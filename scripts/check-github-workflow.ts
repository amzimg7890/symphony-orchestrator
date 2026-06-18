import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { toErrorPayload } from '../src/server/symphony/errors'
import { GithubTracker, githubCommandParts } from '../src/server/symphony/githubTracker'
import type { EffectiveConfig } from '../src/server/symphony/types'
import { loadWorkflow } from '../src/server/symphony/workflow'
import { resolveWorkflowConfig } from '../src/server/symphony/config'

type GithubCheckError = { code: string; message: string }

const execFileAsync = promisify(execFile)
const root = process.cwd()
const args = parseArgs(process.argv.slice(2))
await loadDotEnv(args.envFile)

const workflowPath = path.resolve(root, args.workflow)
const workflow = await loadWorkflow(workflowPath)
const resolved = resolveWorkflowConfig(workflow, process.env)

if (!resolved.ok) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        workflow_path: workflowPath,
        errors: resolved.errors,
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

const config = resolved.config
const githubErrors = githubConfigErrors(config)
if (githubErrors.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        workflow_path: workflowPath,
        errors: githubErrors,
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

try {
  const ghStatus = await inspectGh(config)
  const tracker = new GithubTracker()
  const activeIssues = await tracker.fetchCandidateIssues(config)
  const terminalIssues = await tracker.fetchIssuesByStates(config.tracker.terminal_states, config)
  const candidateIssues = activeIssues
  const repository = config.tracker.repository ?? ghStatus.repository

  console.log(
    JSON.stringify(
      {
        ok: true,
        read_only: true,
        workflow_path: workflowPath,
        gh: ghStatus,
        tracker: {
          kind: config.tracker.kind,
          repository,
          repository_source: config.tracker.repository ? 'workflow' : 'gh',
          gh_command: config.tracker.gh_command,
          required_labels: config.tracker.required_labels,
          active_states: config.tracker.active_states,
          terminal_states: config.tracker.terminal_states,
          assignee: config.tracker.assignee,
        },
        runner: config.agent.runner,
        mock_tracker: config.demo.mock_tracker,
        github: {
          active_issue_count: activeIssues.length,
          eligible_candidate_count: candidateIssues.length,
          terminal_issue_count: terminalIssues.length,
          candidate_issue_identifiers: candidateIssues.slice(0, 10).map((issue) => issue.identifier),
        },
        ready_for_existing_issue_run: candidateIssues.length > 0,
        next:
          candidateIssues.length > 0
            ? `npm run cli -- ${quoteForDisplay(path.relative(root, workflowPath) || workflowPath)} --port 3001`
            : 'Create or label a GitHub issue with the required labels, keep it open, and rerun this check.',
      },
      null,
      2,
    ),
  )
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        workflow_path: workflowPath,
        errors: [toErrorPayload(error)],
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

function githubConfigErrors(config: EffectiveConfig): Array<GithubCheckError> {
  const errors: Array<GithubCheckError> = []
  if (config.tracker.kind !== 'github') {
    errors.push({ code: 'not_github_tracker', message: 'workflow tracker.kind must be github for GitHub checks' })
  }
  if (config.demo.mock_tracker) {
    errors.push({ code: 'mock_tracker_enabled', message: 'workflow demo.mock_tracker must be false for GitHub checks' })
  }
  if (config.agent.runner !== 'codex') {
    errors.push({ code: 'codex_runner_disabled', message: 'workflow agent.runner must be codex for GitHub checks' })
  }
  return errors
}

async function inspectGh(config: EffectiveConfig): Promise<{
  auth_ok: boolean
  repository: string | null
}> {
  await runGh(config, ['auth', 'status'])
  const repository =
    config.tracker.repository ??
    await inferRepository(config).catch(() => null)
  return {
    auth_ok: true,
    repository,
  }
}

async function inferRepository(config: EffectiveConfig): Promise<string | null> {
  const result = await runGh(config, ['repo', 'view', '--json', 'nameWithOwner'])
  const parsed = JSON.parse(result.stdout) as { nameWithOwner?: string }
  return typeof parsed.nameWithOwner === 'string' && parsed.nameWithOwner.trim()
    ? parsed.nameWithOwner.trim()
    : null
}

async function runGh(
  config: EffectiveConfig,
  commandArgs: Array<string>,
): Promise<{ stdout: string; stderr: string }> {
  const command = githubCommandParts(config.tracker.gh_command)
  const result = await execFileAsync(command.executable, [...command.args, ...commandArgs], {
    cwd: config.workflow_directory,
    windowsHide: true,
    maxBuffer: 5 * 1024 * 1024,
  })
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  }
}

function parseArgs(values: Array<string>): { workflow: string; envFile: string } {
  let workflow = 'WORKFLOW.github.md'
  let envFile = path.join(root, '.env')
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--workflow') {
      workflow = requireValue(values, index, '--workflow')
      index += 1
      continue
    }
    if (value.startsWith('--workflow=')) {
      workflow = value.slice('--workflow='.length)
      continue
    }
    if (value === '--dotenv') {
      envFile = path.resolve(root, requireValue(values, index, '--dotenv'))
      index += 1
      continue
    }
    if (value.startsWith('--dotenv=')) {
      envFile = path.resolve(root, value.slice('--dotenv='.length))
      continue
    }
    throw new Error(`Unknown option: ${value}`)
  }
  return { workflow, envFile }
}

function requireValue(values: Array<string>, index: number, flag: string): string {
  const value = values[index + 1]
  if (!value) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

async function loadDotEnv(dotEnvPath: string): Promise<void> {
  if (!existsSync(dotEnvPath)) {
    return
  }
  const content = await readFile(dotEnvPath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match) {
      continue
    }
    const [, key, rawValue] = match
    process.env[key] ??= unquoteDotEnvValue(rawValue)
  }
}

function unquoteDotEnvValue(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function quoteForDisplay(value: string): string {
  return value.includes(' ') ? `"${value.replaceAll('"', '\\"')}"` : value
}

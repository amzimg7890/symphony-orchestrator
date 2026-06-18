import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveWorkflowConfig } from '../src/server/symphony/config'
import { GithubTracker, githubCommandParts } from '../src/server/symphony/githubTracker'
import type { EffectiveConfig, SymphonyErrorPayload } from '../src/server/symphony/types'
import { loadWorkflow } from '../src/server/symphony/workflow'

type Args = {
  workflow: string
  envFile: string
  title: string
  body: string
  create: boolean
  createLabels: boolean
}

const execFileAsync = promisify(execFile)
const root = process.cwd()
const args = parseArgs(process.argv.slice(2))
await loadDotEnv(args.envFile)

const workflowPath = path.resolve(root, args.workflow)
const workflow = await loadWorkflow(workflowPath)
const resolved = resolveWorkflowConfig(workflow, process.env)

if (!resolved.ok) {
  fail(workflowPath, resolved.errors)
}

const config = resolved.config
const configErrors = githubConfigErrors(config)
if (configErrors.length > 0) {
  fail(workflowPath, configErrors)
}

try {
  const gh = githubCommandParts(config.tracker.gh_command)
  await runGh(config, ['auth', 'status'])
  const repository = config.tracker.repository ?? await inferRepository(config)
  const labels = config.tracker.required_labels
  const existingLabels = await listLabels(config, repository)
  const missingLabels = labels.filter((label) => !existingLabels.has(label.toLowerCase()))
  const tracker = new GithubTracker()
  const eligibleCandidates = await tracker.fetchCandidateIssues(config)
  const issueCreateArgs = [
    'issue',
    'create',
    '--repo',
    repository,
    '--title',
    args.title,
    '--body',
    args.body,
    ...labels.flatMap((label) => ['--label', label]),
    ...(config.tracker.assignee ? ['--assignee', config.tracker.assignee] : []),
  ]

  if (!args.create) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dry_run: true,
          workflow_path: workflowPath,
          repository,
          gh_command: config.tracker.gh_command,
          executable: gh.executable,
          required_labels: labels,
          missing_labels: missingLabels,
          assignee: config.tracker.assignee,
          eligible_candidate_count: eligibleCandidates.length,
          create_command: displayCommand(config.tracker.gh_command, issueCreateArgs),
          next:
            missingLabels.length > 0
              ? 'Run with --create --create-labels to create missing labels and a candidate issue, or create the labels manually first.'
              : 'Run with --create to create a candidate issue, or create/label an issue manually.',
        },
        null,
        2,
      ),
    )
    process.exit(0)
  }

  if (missingLabels.length > 0 && !args.createLabels) {
    fail(workflowPath, [
      {
        code: 'invalid_config',
        message: `Missing GitHub labels: ${missingLabels.join(', ')}. Re-run with --create-labels or create them manually.`,
      },
    ])
  }

  for (const label of missingLabels) {
    await runGh(config, [
      'label',
      'create',
      label,
      '--repo',
      repository,
      '--color',
      '0E8A16',
      '--description',
      'Issues eligible for Symphony automation',
    ])
  }

  const created = await runGh(config, issueCreateArgs)
  const issueUrl = created.stdout.trim() || null
  console.log(
    JSON.stringify(
      {
        ok: true,
        dry_run: false,
        workflow_path: workflowPath,
        repository,
        created_issue_url: issueUrl,
        created_labels: missingLabels,
        next: `npm run workflow:check-github -- --workflow ${quoteForDisplay(path.relative(root, workflowPath) || workflowPath)}`,
      },
      null,
      2,
    ),
  )
} catch (error) {
  fail(workflowPath, [errorPayload(error)])
}

function githubConfigErrors(config: EffectiveConfig): Array<SymphonyErrorPayload> {
  const errors: Array<SymphonyErrorPayload> = []
  if (config.tracker.kind !== 'github') {
    errors.push({ code: 'invalid_config', message: 'workflow tracker.kind must be github' })
  }
  if (config.demo.mock_tracker) {
    errors.push({ code: 'invalid_config', message: 'workflow demo.mock_tracker must be false' })
  }
  return errors
}

async function inferRepository(config: EffectiveConfig): Promise<string> {
  const result = await runGh(config, ['repo', 'view', '--json', 'nameWithOwner'])
  const parsed = JSON.parse(result.stdout) as { nameWithOwner?: string }
  if (typeof parsed.nameWithOwner === 'string' && parsed.nameWithOwner.trim()) {
    return parsed.nameWithOwner.trim()
  }

  throw new Error('Unable to infer GitHub repository from gh repo view')
}

async function listLabels(config: EffectiveConfig, repository: string): Promise<Set<string>> {
  const result = await runGh(config, ['label', 'list', '--repo', repository, '--limit', '1000', '--json', 'name'])
  const parsed = JSON.parse(result.stdout) as Array<{ name?: string }>
  if (!Array.isArray(parsed)) {
    throw new Error('GitHub label list payload was malformed')
  }

  return new Set(
    parsed
      .map((label) => label.name)
      .filter((label): label is string => typeof label === 'string')
      .map((label) => label.trim().toLowerCase())
      .filter(Boolean),
  )
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

function parseArgs(values: Array<string>): Args {
  let workflow = 'WORKFLOW.github.md'
  let envFile = path.join(root, '.env')
  let title = 'Symphony smoke: verify local GitHub automation'
  let body = [
    'Symphony local-gh smoke task.',
    '',
    '1. Confirm this workspace is a checkout of this GitHub repository.',
    '2. Run a lightweight read-only check such as `git status --short`.',
    '3. Add a GitHub issue comment containing `Symphony local-gh smoke completed`.',
    '4. Close this issue.',
    '',
    'Do not edit repository files.',
  ].join('\n')
  let create = false
  let createLabels = false

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
    if (value === '--title') {
      title = requireValue(values, index, '--title')
      index += 1
      continue
    }
    if (value.startsWith('--title=')) {
      title = value.slice('--title='.length)
      continue
    }
    if (value === '--body') {
      body = requireValue(values, index, '--body')
      index += 1
      continue
    }
    if (value.startsWith('--body=')) {
      body = value.slice('--body='.length)
      continue
    }
    if (value === '--create') {
      create = true
      continue
    }
    if (value === '--create-labels') {
      createLabels = true
      continue
    }
    throw new Error(`Unknown option: ${value}`)
  }

  return { workflow, envFile, title, body, create, createLabels }
}

function fail(workflowPath: string, errors: Array<SymphonyErrorPayload>): never {
  console.error(JSON.stringify({ ok: false, workflow_path: workflowPath, errors }, null, 2))
  process.exit(1)
}

function errorPayload(error: unknown): SymphonyErrorPayload {
  const failed = error as Error & { code?: number | string; stdout?: string; stderr?: string }
  if (failed && typeof failed === 'object' && ('stdout' in failed || 'stderr' in failed)) {
    return {
      code: 'github_cli_status',
      message: `GitHub CLI failed: ${truncateText(failed.stderr || failed.stdout || failed.message)}`,
      details: {
        exit_code: failed.code,
        stdout: truncateText(failed.stdout),
        stderr: truncateText(failed.stderr),
      },
    } as SymphonyErrorPayload
  }

  return {
    code: 'invalid_config',
    message: error instanceof Error ? error.message : String(error),
  }
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

function displayCommand(command: string, args: Array<string>): string {
  return [command, ...args.map(quoteShellArg)].join(' ')
}

function quoteShellArg(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`
}

function quoteForDisplay(value: string): string {
  return value.includes(' ') ? `"${value.replaceAll('"', '\\"')}"` : value
}

function truncateText(value: unknown): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 1000 ? `${text.slice(0, 1000)}...<truncated>` : text
}

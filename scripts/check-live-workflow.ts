import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeLabels, normalizeStateName, resolveWorkflowConfig, stateInList } from '../src/server/symphony/config'
import { LinearTracker } from '../src/server/symphony/linearTracker'
import type { EffectiveConfig, Issue } from '../src/server/symphony/types'
import { loadWorkflow } from '../src/server/symphony/workflow'

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
const liveErrors = liveConfigErrors(config)
if (liveErrors.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        workflow_path: workflowPath,
        errors: liveErrors,
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

const tracker = new LinearTracker()
const activeIssues = await tracker.fetchCandidateIssues(config)
const terminalIssues = await tracker.fetchIssuesByStates(config.tracker.terminal_states, config)
const candidateIssues = activeIssues.filter((issue) => issueEligibleForRun(issue, config))

console.log(
  JSON.stringify(
    {
      ok: true,
      read_only: true,
      workflow_path: workflowPath,
      tracker: {
        kind: config.tracker.kind,
        project_slug: config.tracker.project_slug,
        required_labels: config.tracker.required_labels,
        active_states: config.tracker.active_states,
        terminal_states: config.tracker.terminal_states,
        assignee: config.tracker.assignee,
      },
      runner: config.agent.runner,
      mock_tracker: config.demo.mock_tracker,
      linear: {
        active_issue_count: activeIssues.length,
        eligible_candidate_count: candidateIssues.length,
        terminal_issue_count: terminalIssues.length,
        candidate_issue_identifiers: candidateIssues.slice(0, 10).map((issue) => issue.identifier),
      },
      ready_for_existing_issue_run: candidateIssues.length > 0,
      next:
        candidateIssues.length > 0
          ? `npm run cli -- ${quoteForDisplay(path.relative(root, workflowPath) || workflowPath)} --port 3001`
          : 'Create or label a Linear issue in an active state, or run the opt-in live e2e smoke to create a temporary issue.',
    },
    null,
    2,
  ),
)

function liveConfigErrors(config: EffectiveConfig): Array<{ code: string; message: string }> {
  const errors: Array<{ code: string; message: string }> = []
  if (config.tracker.kind !== 'linear') {
    errors.push({ code: 'not_live_linear', message: 'workflow tracker.kind must be linear for live checks' })
  }
  if (config.demo.mock_tracker) {
    errors.push({ code: 'mock_tracker_enabled', message: 'workflow demo.mock_tracker must be false for live checks' })
  }
  if (config.agent.runner !== 'codex') {
    errors.push({ code: 'codex_runner_disabled', message: 'workflow agent.runner must be codex for live checks' })
  }
  return errors
}

function issueEligibleForRun(issue: Issue, config: EffectiveConfig): boolean {
  if (!stateInList(issue.state, config.tracker.active_states)) {
    return false
  }
  if (stateInList(issue.state, config.tracker.terminal_states)) {
    return false
  }
  if (!issue.assigned_to_worker) {
    return false
  }
  const labels = normalizeLabels(issue.labels)
  if (!config.tracker.required_labels.every((required) => labels.includes(required))) {
    return false
  }
  if (normalizeStateName(issue.state) === 'todo') {
    return !issue.blocked_by.some(
      (blocker) => blocker.state && !stateInList(blocker.state, config.tracker.terminal_states),
    )
  }
  return true
}

function parseArgs(values: Array<string>): { workflow: string; envFile: string } {
  let workflow = path.join('.tmp', 'live-workflow', 'WORKFLOW.md')
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

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeLabels, normalizeStateName, resolveWorkflowConfig, stateInList } from '../src/server/symphony/config'
import { LinearTracker } from '../src/server/symphony/linearTracker'
import { SymphonyOrchestrator } from '../src/server/symphony/orchestrator'
import type { AgentRunner } from '../src/server/symphony/runner'
import type { EffectiveConfig, Issue, IssueTracker } from '../src/server/symphony/types'
import { loadWorkflow } from '../src/server/symphony/workflow'

const root = process.cwd()

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  await loadDotEnv(args.envFile)

  const workflowPath = path.resolve(root, args.workflow)
  const workflow = await loadWorkflow(workflowPath)
  const resolved = resolveWorkflowConfig(workflow, process.env)
  if (!resolved.ok) {
    throw new Error(`Invalid workflow config: ${resolved.errors.map((error) => error.message).join('; ')}`)
  }
  const config = resolved.config
  const liveErrors = liveConfigErrors(config)
  if (liveErrors.length > 0) {
    throw new Error(liveErrors.map((error) => error.message).join('; '))
  }

  const tracker = new ReadOnlyLinearTracker()
  const runner = new GuardRunner()
  const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
  try {
    await orchestrator.start(workflowPath)
    await waitFor(() => tracker.candidatePollCount > 0, args.timeoutMs)
    await orchestrator.stop()
  } finally {
    await orchestrator.stop().catch(() => {})
  }

  const eligibleCandidates = tracker.lastCandidates.filter((issue) => issueEligibleForRun(issue, config))
  const ok = !runner.invoked
  const payload = {
    ok,
    read_only: true,
    workflow_path: workflowPath,
    runner_invoked: runner.invoked,
    candidate_poll_count: tracker.candidatePollCount,
    runner: config.agent.runner,
    mock_tracker: config.demo.mock_tracker,
    tracker: {
      kind: config.tracker.kind,
      project_slug: config.tracker.project_slug,
      required_labels: config.tracker.required_labels,
      active_states: config.tracker.active_states,
      terminal_states: config.tracker.terminal_states,
      assignee: config.tracker.assignee,
    },
    linear: {
      active_issue_count: tracker.lastCandidates.length,
      eligible_candidate_count: eligibleCandidates.length,
      candidate_issue_identifiers: eligibleCandidates.slice(0, 10).map((issue) => issue.identifier),
    },
    next:
      eligibleCandidates.length > 0
        ? 'Existing eligible issues are present; run the normal service or opt-in e2e only when you are ready for Codex to work them.'
        : 'No eligible issue was dispatched. Create or label a Linear issue, or run the opt-in live e2e smoke to create one.',
  }

  console.log(JSON.stringify(payload, null, 2))
  if (!ok) {
    process.exit(1)
  }
}

class ReadOnlyLinearTracker implements IssueTracker {
  private readonly linear = new LinearTracker()
  candidatePollCount = 0
  lastCandidates: Array<Issue> = []

  async fetchCandidateIssues(config: EffectiveConfig): Promise<Array<Issue>> {
    this.lastCandidates = await this.linear.fetchCandidateIssues(config)
    this.candidatePollCount += 1
    return []
  }

  async fetchIssuesByStates(): Promise<Array<Issue>> {
    return []
  }

  async fetchIssueStatesByIds(): Promise<Array<Issue>> {
    return []
  }

  async createComment(): Promise<void> {
    throw new Error('read-only live runtime smoke must not create Linear comments')
  }

  async updateIssueState(): Promise<void> {
    throw new Error('read-only live runtime smoke must not update Linear issue state')
  }
}

class GuardRunner implements AgentRunner {
  invoked = false

  async run(): Promise<void> {
    this.invoked = true
    throw new Error('read-only live runtime smoke must not invoke the runner')
  }

  async startSession(): Promise<never> {
    this.invoked = true
    throw new Error('read-only live runtime smoke must not start a runner session')
  }
}

function liveConfigErrors(config: EffectiveConfig): Array<{ code: string; message: string }> {
  const errors: Array<{ code: string; message: string }> = []
  if (config.tracker.kind !== 'linear') {
    errors.push({ code: 'not_live_linear', message: 'workflow tracker.kind must be linear for live runtime smoke' })
  }
  if (config.demo.mock_tracker) {
    errors.push({ code: 'mock_tracker_enabled', message: 'workflow demo.mock_tracker must be false for live runtime smoke' })
  }
  if (config.agent.runner !== 'codex') {
    errors.push({ code: 'codex_runner_disabled', message: 'workflow agent.runner must be codex for live runtime smoke' })
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

function parseArgs(values: Array<string>): { workflow: string; envFile: string; timeoutMs: number } {
  let workflow = path.join('.tmp', 'live-workflow', 'WORKFLOW.md')
  let envFile = path.join(root, '.env')
  let timeoutMs = 30_000
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
    if (value === '--timeout-ms') {
      timeoutMs = positiveInteger(requireValue(values, index, '--timeout-ms'), '--timeout-ms')
      index += 1
      continue
    }
    if (value.startsWith('--timeout-ms=')) {
      timeoutMs = positiveInteger(value.slice('--timeout-ms='.length), '--timeout-ms')
      continue
    }
    throw new Error(`Unknown option: ${value}`)
  }
  return { workflow, envFile, timeoutMs }
}

function requireValue(values: Array<string>, index: number, flag: string): string {
  const value = values[index + 1]
  if (!value) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function positiveInteger(value: string, name: string): number {
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return numeric
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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await delay(50)
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for live runtime poll`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

try {
  await main()
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

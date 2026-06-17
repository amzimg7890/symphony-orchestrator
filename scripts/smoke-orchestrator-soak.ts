import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { stateInList } from '../src/server/symphony/config'
import { SymphonyOrchestrator } from '../src/server/symphony/orchestrator'
import type { AgentRunner } from '../src/server/symphony/runner'
import type { EffectiveConfig, Issue, IssueTracker, RuntimeSnapshot } from '../src/server/symphony/types'

const root = process.cwd()
const smokeRoot = path.join(root, '.tmp', 'orchestrator-soak')
const workflowPath = path.join(smokeRoot, 'WORKFLOW.md')
const workspaceRoot = path.join(smokeRoot, 'workspaces')

async function writeWorkflow(): Promise<void> {
  await writeFile(
    workflowPath,
    [
      '---',
      'tracker:',
      '  kind: linear',
      '  api_key: demo-token',
      '  project_slug: demo',
      '  required_labels:',
      '    - soak',
      'polling:',
      '  interval_ms: 60000',
      'workspace:',
      '  root: ./workspaces',
      'agent:',
      '  max_concurrent_agents: 2',
      '  max_turns: 1',
      '  max_retry_backoff_ms: 250',
      'codex:',
      '  command: codex app-server',
      '  stall_timeout_ms: 40',
      'logging:',
      '  root: ./logs',
      '  file: soak.jsonl',
      'demo:',
      '  mock_tracker: false',
      '---',
      'Soak prompt for {{ issue.identifier }}: {{ issue.title }}.',
      '',
    ].join('\n'),
    'utf8',
  )
}

class SoakRunner implements AgentRunner {
  readonly runCounts = new Map<string, number>()
  private active = 0
  maxObservedConcurrent = 0

  async run(input: Parameters<AgentRunner['run']>[0]): Promise<void> {
    this.active += 1
    this.maxObservedConcurrent = Math.max(this.maxObservedConcurrent, this.active)
    this.runCounts.set(input.issue.identifier, this.runCount(input.issue.identifier) + 1)

    try {
      input.emit({
        event: 'session_started',
        timestamp: new Date().toISOString(),
        session_id: `session-${input.issue.identifier}`,
        thread_id: `thread-${input.issue.identifier}`,
        message: `${input.issue.identifier}: soak session started`,
      })
      input.emit({
        event: 'turn_started',
        timestamp: new Date().toISOString(),
        session_id: `session-${input.issue.identifier}`,
        thread_id: `thread-${input.issue.identifier}`,
        turn_id: `turn-${input.issue.identifier}-${input.attempt ?? 0}`,
        message: `${input.issue.identifier}: soak turn started`,
      })

      if (input.issue.identifier === 'SOAK-2' && this.runCount(input.issue.identifier) === 1) {
        await delayWithAbort(60, input.signal)
        throw new Error('intentional soak retry')
      }

      if (input.issue.identifier === 'SOAK-3' || input.issue.identifier === 'SOAK-4') {
        await waitForAbort(input.signal)
        return
      }

      await delayWithAbort(60, input.signal)
      if (input.tracker instanceof SoakTracker) {
        input.tracker.transitionIssue(input.issue.id, 'Done')
      }
      input.emit({
        event: 'turn_completed',
        timestamp: new Date().toISOString(),
        session_id: `session-${input.issue.identifier}`,
        thread_id: `thread-${input.issue.identifier}`,
        turn_id: `turn-${input.issue.identifier}-${input.attempt ?? 0}`,
        message: `${input.issue.identifier}: soak turn completed`,
        usage: {
          input_tokens: 100 + this.runCount(input.issue.identifier),
          output_tokens: 25,
          total_tokens: 125 + this.runCount(input.issue.identifier),
        },
      })
    } finally {
      this.active -= 1
    }
  }

  runCount(identifier: string): number {
    return this.runCounts.get(identifier) ?? 0
  }
}

class SoakTracker implements IssueTracker {
  private readonly issues = new Map<string, Issue>()

  constructor(issues: Array<Issue>) {
    for (const issue of issues) {
      this.addIssue(issue)
    }
  }

  async fetchCandidateIssues(config: EffectiveConfig): Promise<Array<Issue>> {
    return this.allIssues()
      .filter((issue) => stateInList(issue.state, config.tracker.active_states))
      .map(cloneIssue)
  }

  async fetchIssuesByStates(states: Array<string>): Promise<Array<Issue>> {
    return this.allIssues()
      .filter((issue) => stateInList(issue.state, states))
      .map(cloneIssue)
  }

  async fetchIssueStatesByIds(ids: Array<string>): Promise<Array<Issue>> {
    return ids
      .map((id) => this.issues.get(id))
      .filter((issue): issue is Issue => Boolean(issue))
      .map(cloneIssue)
  }

  async createComment(_issueId: string, _body: string): Promise<void> {
    return
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    this.transitionIssue(issueId, stateName)
  }

  addIssue(issue: Issue): void {
    this.issues.set(issue.id, cloneIssue(issue))
  }

  transitionIssue(issueId: string, state: string): void {
    const issue = this.issues.get(issueId)
    if (!issue) {
      return
    }
    this.issues.set(issueId, {
      ...issue,
      state,
      updated_at: new Date().toISOString(),
    })
  }

  setAssignedToWorker(issueId: string, assigned: boolean): void {
    const issue = this.issues.get(issueId)
    if (!issue) {
      return
    }
    this.issues.set(issueId, {
      ...issue,
      assigned_to_worker: assigned,
      assignee_id: assigned ? 'worker' : 'other-worker',
      updated_at: new Date().toISOString(),
    })
  }

  private allIssues(): Array<Issue> {
    return Array.from(this.issues.values())
  }
}

async function waitForSnapshot(
  predicate: (snapshot: RuntimeSnapshot) => boolean,
  label: string,
): Promise<RuntimeSnapshot> {
  const deadline = Date.now() + 10_000
  let lastSnapshot = orchestrator.snapshot()
  while (Date.now() < deadline) {
    lastSnapshot = orchestrator.snapshot()
    if (predicate(lastSnapshot)) {
      return lastSnapshot
    }
    await delay(25)
  }

  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(lastSnapshot)}`)
}

async function assertWorkspaceRemoved(identifier: string): Promise<void> {
  const candidate = path.join(workspaceRoot, identifier)
  const exists = await stat(candidate).then(() => true, () => false)
  assert(!exists, `${identifier} workspace should be removed after terminal completion`)
}

function issueFixture(id: string, identifier: string, title: string, createdAt: string): Issue {
  return {
    id,
    identifier,
    title,
    description: null,
    priority: 1,
    state: 'Todo',
    branch_name: null,
    url: null,
    assignee_id: 'worker',
    assigned_to_worker: true,
    labels: ['soak', 'codex'],
    blocked_by: [],
    created_at: createdAt,
    updated_at: createdAt,
  }
}

function cloneIssue(issue: Issue): Issue {
  return {
    ...issue,
    labels: [...issue.labels],
    blocked_by: issue.blocked_by.map((blocker) => ({ ...blocker })),
  }
}

async function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal })
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

async function removeSmokeRoot(): Promise<void> {
  await rm(smokeRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  })
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

const tracker = new SoakTracker([
  issueFixture('issue-normal', 'SOAK-1', 'Normal terminal completion', '2026-01-01T00:00:00Z'),
  issueFixture('issue-retry', 'SOAK-2', 'Retry once then complete', '2026-01-01T00:01:00Z'),
])
const runner = new SoakRunner()
const orchestrator = new SymphonyOrchestrator(runner, () => tracker)

try {
  await removeSmokeRoot()
  await mkdir(smokeRoot, { recursive: true })
  await writeWorkflow()

  console.log('[soak] starting orchestrator')
  await orchestrator.start(workflowPath)

  console.log('[soak] checking concurrent initial dispatch and retry')
  await waitForSnapshot(
    (snapshot) =>
      runner.runCount('SOAK-1') >= 1 &&
      runner.runCount('SOAK-2') >= 1 &&
      runner.maxObservedConcurrent >= 2 &&
      snapshot.counts.retrying >= 1,
    'initial concurrent dispatch with one retry queued',
  )
  await waitForSnapshot(
    (snapshot) => runner.runCount('SOAK-2') >= 2 && snapshot.counts.completed >= 2,
    'retry issue completed on second attempt',
  )
  await assertWorkspaceRemoved('SOAK-1')
  await assertWorkspaceRemoved('SOAK-2')

  console.log('[soak] checking reconciliation release after reassignment')
  tracker.addIssue(issueFixture('issue-reassigned', 'SOAK-3', 'Release after reassignment', '2026-01-01T00:02:00Z'))
  await orchestrator.refresh()
  await waitForSnapshot(
    (snapshot) => snapshot.running.some((row) => row.issue_identifier === 'SOAK-3'),
    'reassignment candidate running',
  )
  tracker.setAssignedToWorker('issue-reassigned', false)
  await orchestrator.refresh()
  await waitForSnapshot(
    (snapshot) =>
      !snapshot.running.some((row) => row.issue_identifier === 'SOAK-3') &&
      snapshot.recent_events.some(
        (event) => event.event === 'run_terminated' && event.issue_identifier === 'SOAK-3' && event.message === 'assignee changed',
      ),
    'reassigned issue released',
  )

  console.log('[soak] checking stalled worker recovery')
  tracker.addIssue(issueFixture('issue-stalled', 'SOAK-4', 'Stall and schedule retry', '2026-01-01T00:03:00Z'))
  await orchestrator.refresh()
  await waitForSnapshot(
    (snapshot) => snapshot.running.some((row) => row.issue_identifier === 'SOAK-4'),
    'stalled candidate running',
  )
  await delay(80)
  await orchestrator.refresh()
  const stalledSnapshot = await waitForSnapshot(
    (snapshot) =>
      snapshot.retrying.some(
        (row) =>
          row.issue_identifier === 'SOAK-4' &&
          row.last_attempt_status === 'Stalled' &&
          row.error === 'stalled session',
      ),
    'stalled issue queued for retry',
  )

  assert(
    stalledSnapshot.recent_events.some((event) => event.event === 'stall_detected' && event.issue_identifier === 'SOAK-4'),
    'stall_detected event should be visible',
  )

  console.log(
    JSON.stringify(
      {
        ok: true,
        workflow_path: workflowPath,
        completed: stalledSnapshot.counts.completed,
        retrying: stalledSnapshot.counts.retrying,
        max_observed_concurrent: runner.maxObservedConcurrent,
        run_counts: Object.fromEntries(runner.runCounts),
        log_path: path.join(smokeRoot, 'logs', 'soak.jsonl'),
      },
      null,
      2,
    ),
  )
} finally {
  await orchestrator.stop()
  await removeSmokeRoot()
}

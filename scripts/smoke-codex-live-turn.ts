import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CodexAppServerRunner } from '../src/server/symphony/codexAppServerRunner'
import { resolveWorkflowConfig } from '../src/server/symphony/config'
import type { AgentRuntimeEvent, Issue, IssueTracker, Workspace } from '../src/server/symphony/types'
import { parseWorkflow } from '../src/server/symphony/workflow'

const root = process.cwd()
const smokeRoot = path.join(root, '.tmp', 'codex-live-turn-smoke')
const workspacePath = path.join(smokeRoot, 'workspace')
const workflowPath = path.join(smokeRoot, 'WORKFLOW.md')
const marker = 'SYMPHONY_LIVE_TURN_OK'

async function main(): Promise<void> {
  if (process.env.SYMPHONY_LIVE_CODEX_SMOKE !== '1') {
    console.log(
      JSON.stringify(
        {
          ok: true,
          skipped: true,
          reason: 'Set SYMPHONY_LIVE_CODEX_SMOKE=1 to send a real Codex turn/start. This may invoke a model.',
        },
        null,
        2,
      ),
    )
    return
  }

  const events: Array<AgentRuntimeEvent> = []
  const runner = new CodexAppServerRunner()

  try {
    await removeSmokeRoot()
    await mkdir(workspacePath, { recursive: true })
    await writeFile(
      path.join(workspacePath, 'SMOKE.md'),
      'This temporary workspace is used by the Symphony live Codex smoke test.\n',
      'utf8',
    )

    const config = resolveConfig()
    const issue: Issue = {
      id: 'live-smoke-issue',
      identifier: 'SMOKE-1',
      title: 'Run live Codex app-server turn smoke',
      description: null,
      priority: null,
      state: 'Todo',
      branch_name: null,
      url: null,
      assignee_id: 'symphony-smoke',
      assigned_to_worker: true,
      labels: ['codex'],
      blocked_by: [],
      created_at: null,
      updated_at: null,
    }
    const workspace: Workspace = {
      path: workspacePath,
      workspace_key: issue.identifier,
      created_now: false,
    }

    await runner.run({
      issue,
      workspace,
      prompt: [
        'You are running a Symphony live smoke test.',
        'Do not inspect, create, edit, move, or delete any files.',
        `Reply with exactly: ${marker}`,
      ].join('\n'),
      turn_number: 1,
      continuation: false,
      attempt: null,
      config,
      tracker: emptyTracker,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    })

    const eventNames = events.map((event) => event.event)
    assert(eventNames.includes('session_started'), 'live smoke should start a session')
    assert(eventNames.includes('turn_started'), 'live smoke should start a turn')
    assert(eventNames.includes('turn_completed'), 'live smoke should complete a turn')

    const streamedText = events
      .filter((event) => event.event === 'notification')
      .map((event) => event.message ?? '')
      .join('')

    console.log(
      JSON.stringify(
        {
          ok: true,
          skipped: false,
          events: eventNames,
          thread_id: events.find((event) => event.thread_id)?.thread_id ?? null,
          turn_id: events.find((event) => event.turn_id)?.turn_id ?? null,
          token_usage_seen: events.some((event) => event.usage),
          marker_seen_in_stream: streamedText.includes(marker),
          workspace: workspacePath,
        },
        null,
        2,
      ),
    )
  } finally {
    await removeSmokeRoot()
  }
}

function resolveConfig() {
  const model = process.env.SYMPHONY_LIVE_CODEX_MODEL?.trim()
  const workflow = parseWorkflow(
    [
      '---',
      'tracker:',
      '  kind: linear',
      '  api_key: demo-token',
      '  project_slug: demo',
      'workspace:',
      `  root: ${yamlSingleQuoted(smokeRoot)}`,
      'agent:',
      '  runner: codex',
      '  max_concurrent_agents: 1',
      '  max_turns: 1',
      'codex:',
      '  command: codex app-server',
      ...(model ? [`  model: ${yamlSingleQuoted(model)}`] : []),
      `  read_timeout_ms: ${positiveIntegerEnv('SYMPHONY_LIVE_CODEX_READ_TIMEOUT_MS', 10_000)}`,
      `  turn_timeout_ms: ${positiveIntegerEnv('SYMPHONY_LIVE_CODEX_TURN_TIMEOUT_MS', 180_000)}`,
      'demo:',
      '  mock_tracker: true',
      '---',
      'Live Codex smoke workflow.',
    ].join('\n'),
    workflowPath,
  )

  const result = resolveWorkflowConfig(workflow, process.env)
  if (!result.ok) {
    throw new Error(`Invalid live smoke config: ${result.errors.map((error) => error.message).join('; ')}`)
  }
  return result.config
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }
  const numeric = Number(raw)
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback
}

function yamlSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function removeSmokeRoot(): Promise<void> {
  await rm(smokeRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  })
}

const emptyTracker: IssueTracker = {
  async fetchCandidateIssues() {
    return []
  },
  async fetchIssuesByStates() {
    return []
  },
  async fetchIssueStatesByIds() {
    return []
  },
  async createComment() {},
  async updateIssueState() {},
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

await main()

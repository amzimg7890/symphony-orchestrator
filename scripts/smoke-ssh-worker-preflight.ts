import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { CodexAppServerRunner } from '../src/server/symphony/codexAppServerRunner'
import { resolveWorkflowConfig } from '../src/server/symphony/config'
import { runSshCommand, shellEscape } from '../src/server/symphony/ssh'
import type { AgentRuntimeEvent, Issue, IssueTracker, Workspace } from '../src/server/symphony/types'
import { createWorkspaceForIssue, removeWorkspaceForIssue } from '../src/server/symphony/workspace'
import { parseWorkflow } from '../src/server/symphony/workflow'

const root = process.cwd()

await loadDotEnv(path.join(root, '.env'))

const runId = `symphony-ssh-worker-preflight-${Date.now()}-${Math.random().toString(36).slice(2)}`
const workflowPath = path.join(root, '.tmp', 'ssh-worker-preflight', 'WORKFLOW.md')
const workerHosts = csvEnv('SYMPHONY_LIVE_SSH_WORKER_HOSTS', csvEnv('SYMPHONY_SSH_WORKER_HOSTS', []))
const requiredPreflight = booleanEnv('SYMPHONY_SSH_WORKER_PREFLIGHT_REQUIRED')
const commandTimeoutMs = positiveIntegerEnv('SYMPHONY_SSH_WORKER_COMMAND_TIMEOUT_MS', 60_000)
const readTimeoutMs = positiveIntegerEnv('SYMPHONY_SSH_WORKER_CODEX_READ_TIMEOUT_MS', 60_000)
const codexCommand = env('SYMPHONY_SSH_WORKER_CODEX_COMMAND') ?? 'codex app-server'
const configuredRemoteRoot = env('SYMPHONY_SSH_WORKER_WORKSPACE_ROOT')
const defaultCleanupRoot = `~/.${runId}`
const remoteWorkspaceRoot = configuredRemoteRoot ?? `${defaultCleanupRoot}/workspaces`
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

if (workerHosts.length === 0) {
  const payload = JSON.stringify(
    {
      ok: true,
      skipped: true,
      required: requiredPreflight,
      reason:
        'Set SYMPHONY_LIVE_SSH_WORKER_HOSTS or SYMPHONY_SSH_WORKER_HOSTS to run the SSH worker preflight.',
    },
    null,
    2,
  )

  if (requiredPreflight) {
    console.error(payload)
    process.exit(1)
  }

  console.log(payload)
  process.exit(0)
}

const config = resolveSmokeConfig()
const results = []

for (const [index, workerHost] of workerHosts.entries()) {
  const issueIdentifier = `SSH-SMOKE-${index + 1}`
  const events: Array<AgentRuntimeEvent> = []
  const ready = await runSshOrThrow(workerHost, 'printf ready')
  assert(ready.stdout === 'ready', `${workerHost} did not echo ready`)
  const home = (await runSshOrThrow(workerHost, 'printf \'%s\\n\' "$HOME"')).stdout.trim()
  assert(home.length > 0, `${workerHost} returned an empty HOME`)

  let workspace: Workspace | null = null
  let session: Awaited<ReturnType<CodexAppServerRunner['startSession']>> | null = null
  try {
    workspace = await createWorkspaceForIssue(issueIdentifier, config, workerHost)
    const runner = new CodexAppServerRunner()
    session = await runner.startSession({
      issue: issueFixture(issueIdentifier),
      workspace,
      worker_host: workerHost,
      attempt: null,
      config,
      tracker: emptyTracker,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    })
    await session.close()
    session = null

    const sessionStarted = events.find((event) => event.event === 'session_started')
    assert(sessionStarted, `${workerHost} did not emit session_started`)
    results.push({
      worker_host: workerHost,
      home,
      workspace_path: workspace.path,
      workspace_created: workspace.created_now,
      app_server_session_started: true,
      thread_id: sessionStarted.thread_id ?? null,
    })
  } finally {
    await session?.close().catch(() => {})
    const hookError = await removeWorkspaceForIssue(issueIdentifier, config, workerHost).catch((error) => {
      throw error
    })
    if (hookError) {
      throw hookError
    }
    if (!configuredRemoteRoot) {
      await runSshCommand(workerHost, `rm -rf ${shellEscape(defaultCleanupRoot)}`, commandTimeoutMs)
    }
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      skipped: false,
      worker_count: results.length,
      codex_command: codexCommand,
      remote_workspace_root: remoteWorkspaceRoot,
      command_timeout_ms: commandTimeoutMs,
      codex_read_timeout_ms: readTimeoutMs,
      no_turn_started: true,
      note: 'This preflight starts and names a remote Codex app-server thread but does not send turn/start or invoke a model.',
      workers: results,
    },
    null,
    2,
  ),
)

async function runSshOrThrow(workerHost: string, command: string): Promise<{ stdout: string; stderr: string }> {
  const result = await runSshCommand(workerHost, command, commandTimeoutMs)
  if (result.exit_code !== 0 || result.timed_out) {
    throw new Error(
      `SSH command failed on ${workerHost} exit=${result.exit_code} timed_out=${result.timed_out}: ${result.stderr || result.stdout}`,
    )
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function resolveSmokeConfig() {
  const workflow = parseWorkflow(
    [
      '---',
      'tracker:',
      '  kind: linear',
      '  api_key: demo-token',
      '  project_slug: demo',
      'workspace:',
      `  root: ${yamlSingleQuoted(remoteWorkspaceRoot)}`,
      'worker:',
      '  ssh_hosts:',
      ...workerHosts.map((host) => `    - ${yamlSingleQuoted(host)}`),
      'agent:',
      '  runner: codex',
      '  max_concurrent_agents: 1',
      '  max_turns: 1',
      'codex:',
      `  command: ${yamlSingleQuoted(codexCommand)}`,
      `  read_timeout_ms: ${readTimeoutMs}`,
      'demo:',
      '  mock_tracker: true',
      'hooks:',
      `  timeout_ms: ${commandTimeoutMs}`,
      '---',
      'SSH worker preflight.',
    ].join('\n'),
    workflowPath,
  )

  const result = resolveWorkflowConfig(workflow, process.env)
  if (!result.ok) {
    throw new Error(`Invalid SSH worker preflight config: ${result.errors.map((error) => error.message).join('; ')}`)
  }
  return result.config
}

function issueFixture(identifier: string): Issue {
  return {
    id: `issue-${identifier.toLowerCase()}`,
    identifier,
    title: 'Run SSH worker preflight',
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

function env(key: string): string | null {
  const value = process.env[key]?.trim()
  return value ? value : null
}

function csvEnv(key: string, fallback: Array<string>): Array<string> {
  const value = env(key)
  if (!value) {
    return fallback
  }

  const parsed = value.split(',').map((item) => item.trim()).filter(Boolean)
  return parsed.length > 0 ? parsed : fallback
}

function booleanEnv(key: string): boolean {
  const value = env(key)?.toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer when set`)
  }
  return value
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

function yamlSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

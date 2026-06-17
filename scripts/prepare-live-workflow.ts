import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveWorkflowConfig } from '../src/server/symphony/config'
import { parseWorkflow } from '../src/server/symphony/workflow'

const root = process.cwd()
const args = parseArgs(process.argv.slice(2))
await loadDotEnv(args.envFile)

const projectSlugRef = firstPresentEnvRef([
  'SYMPHONY_LIVE_E2E_PROJECT_SLUG',
  'LINEAR_PROJECT_SLUG',
  'SYMPHONY_LINEAR_PROJECT_SLUG',
  'TRACKER_PROJECT_SLUG',
])
const apiKeyPresent = Boolean(env('LINEAR_API_KEY'))
const missing = [
  apiKeyPresent ? null : 'LINEAR_API_KEY',
  projectSlugRef ? null : 'LINEAR_PROJECT_SLUG',
].filter((item): item is string => Boolean(item))

if (missing.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        missing,
        message: 'Live workflow preparation needs Linear credentials in .env or the process environment.',
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

const workflowPath = path.resolve(root, args.out)
const workflowContent = buildWorkflow(projectSlugRef!)
const workflow = parseWorkflow(workflowContent, workflowPath)
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

await mkdir(path.dirname(workflowPath), { recursive: true })
await writeFile(workflowPath, workflowContent, 'utf8')

console.log(
  JSON.stringify(
    {
      ok: true,
      workflow_path: workflowPath,
      tracker: {
        kind: resolved.config.tracker.kind,
        project_slug: resolved.config.tracker.project_slug,
        required_labels: resolved.config.tracker.required_labels,
        active_states: resolved.config.tracker.active_states,
        terminal_states: resolved.config.tracker.terminal_states,
        assignee: resolved.config.tracker.assignee,
      },
      runner: resolved.config.agent.runner,
      mock_tracker: resolved.config.demo.mock_tracker,
      workspace_root: resolved.config.workspace.root,
      logging_path: path.join(resolved.config.logging.root, resolved.config.logging.file),
      secret_written: workflowContent.includes(env('LINEAR_API_KEY') ?? ''),
      next: `npm run cli -- ${quoteForDisplay(path.relative(root, workflowPath) || workflowPath)} --port 3001`,
    },
    null,
    2,
  ),
)

function buildWorkflow(projectSlugRef: string): string {
  const requiredLabels = csvEnv('SYMPHONY_REQUIRED_LABELS', ['codex'])
  const activeStates = csvEnv('SYMPHONY_ACTIVE_STATES', ['Todo', 'In Progress'])
  const terminalStates = csvEnv('SYMPHONY_TERMINAL_STATES', ['Done', 'Closed', 'Cancelled', 'Canceled', 'Duplicate'])
  const workspaceRoot = env('SYMPHONY_LIVE_E2E_WORKSPACE_ROOT') ?? './symphony_workspaces'
  const codexCommand =
    env('SYMPHONY_LIVE_E2E_CODEX_COMMAND') ??
    env('SYMPHONY_SSH_WORKER_CODEX_COMMAND') ??
    'codex app-server'
  const codexModel = env('SYMPHONY_LIVE_E2E_MODEL') ?? env('SYMPHONY_LIVE_CODEX_MODEL')
  const runner = env('SYMPHONY_LIVE_WORKFLOW_RUNNER') ?? 'codex'
  const assignee = env('LINEAR_ASSIGNEE') ? '$LINEAR_ASSIGNEE' : null

  return [
    '---',
    'tracker:',
    '  kind: linear',
    `  endpoint: ${yamlSingleQuoted(env('LINEAR_ENDPOINT') ?? 'https://api.linear.app/graphql')}`,
    '  api_key: $LINEAR_API_KEY',
    `  project_slug: $${projectSlugRef}`,
    ...(assignee ? [`  assignee: ${assignee}`] : []),
    '  required_labels:',
    ...requiredLabels.map((label) => `    - ${yamlSingleQuoted(label)}`),
    '  active_states:',
    ...activeStates.map((state) => `    - ${yamlSingleQuoted(state)}`),
    '  terminal_states:',
    ...terminalStates.map((state) => `    - ${yamlSingleQuoted(state)}`),
    'polling:',
    `  interval_ms: ${positiveIntegerEnv('SYMPHONY_LIVE_WORKFLOW_POLL_INTERVAL_MS', 5000)}`,
    'workspace:',
    `  root: ${yamlSingleQuoted(workspaceRoot)}`,
    'hooks:',
    `  timeout_ms: ${positiveIntegerEnv('SYMPHONY_SSH_WORKER_COMMAND_TIMEOUT_MS', 60000)}`,
    'agent:',
    `  runner: ${yamlSingleQuoted(runner)}`,
    '  max_concurrent_agents: 1',
    '  max_turns: 1',
    '  max_retry_backoff_ms: 60000',
    'codex:',
    `  command: ${yamlSingleQuoted(codexCommand)}`,
    ...(codexModel ? [`  model: ${yamlSingleQuoted(codexModel)}`] : []),
    `  read_timeout_ms: ${positiveIntegerEnv('SYMPHONY_LIVE_E2E_CODEX_READ_TIMEOUT_MS', 60000)}`,
    `  turn_timeout_ms: ${positiveIntegerEnv('SYMPHONY_LIVE_E2E_CODEX_TURN_TIMEOUT_MS', 600000)}`,
    `  stall_timeout_ms: ${positiveIntegerEnv('SYMPHONY_LIVE_E2E_CODEX_STALL_TIMEOUT_MS', 600000)}`,
    'logging:',
    '  enabled: true',
    '  root: ./log',
    '  file: symphony-live.jsonl',
    'observability:',
    '  dashboard_enabled: true',
    '  refresh_ms: 1000',
    '  render_interval_ms: 16',
    'demo:',
    '  mock_tracker: false',
    '---',
    '# Linear Issue',
    '',
    'You are working on {{ issue.identifier }}: {{ issue.title }}.',
    '',
    'State: {{ issue.state }}',
    'Labels: {% for label in issue.labels %}{{ label }}{% unless forloop.last %}, {% endunless %}{% endfor %}',
    '',
    'Complete the requested work in the current workspace. Use the linear_graphql tool to add a concise progress comment and move the issue to a completed state only after verification passes.',
    '',
  ].join('\n')
}

function parseArgs(values: Array<string>): { out: string; envFile: string } {
  let out = path.join('.tmp', 'live-workflow', 'WORKFLOW.md')
  let envFile = path.join(root, '.env')
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--out') {
      out = requireValue(values, index, '--out')
      index += 1
      continue
    }
    if (value.startsWith('--out=')) {
      out = value.slice('--out='.length)
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

  return { out, envFile }
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

function firstPresentEnvRef(names: Array<string>): string | null {
  return names.find((name) => Boolean(env(name))) ?? null
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

function quoteForDisplay(value: string): string {
  return value.includes(' ') ? `"${value.replaceAll('"', '\\"')}"` : value
}

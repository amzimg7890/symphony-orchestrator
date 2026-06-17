import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveWorkflowConfig } from '../src/server/symphony/config'
import type { EffectiveConfig, SymphonyErrorPayload } from '../src/server/symphony/types'
import { parseWorkflow } from '../src/server/symphony/workflow'

type GateStatus = 'ready_to_run' | 'blocked' | 'skipped'

type Gate = {
  name: string
  command: string
  status: GateStatus
  read_only: boolean
  external_side_effects: boolean
  env?: Record<string, string>
  reason?: string
}

type WorkflowStatus =
  | {
      status: 'missing'
      path: string
      exists: false
    }
  | {
      status: 'invalid'
      path: string
      exists: true
      errors: Array<SymphonyErrorPayload | { code: string; message: string }>
      secret_written: boolean
    }
  | {
      status: 'not_live'
      path: string
      exists: true
      errors: Array<{ code: string; message: string }>
      tracker: WorkflowTrackerSummary
      runner: string
      mock_tracker: boolean
      secret_written: boolean
    }
  | {
      status: 'ready'
      path: string
      exists: true
      tracker: WorkflowTrackerSummary
      runner: string
      mock_tracker: boolean
      workspace_root: string
      logging_path: string
      secret_written: boolean
    }

type WorkflowTrackerSummary = {
  kind: string
  project_slug: string | null
  required_labels: Array<string>
  active_states: Array<string>
  terminal_states: Array<string>
  assignee_configured: boolean
}

const root = process.cwd()
const args = parseArgs(process.argv.slice(2))

try {
  const dotenv = await loadDotEnv(args.envFile)
  const projectSlug = firstPresentEnv([
    'SYMPHONY_LIVE_E2E_PROJECT_SLUG',
    'LINEAR_PROJECT_SLUG',
    'SYMPHONY_LINEAR_PROJECT_SLUG',
    'TRACKER_PROJECT_SLUG',
  ])
  const workerHosts = csvEnv('SYMPHONY_LIVE_SSH_WORKER_HOSTS', csvEnv('SYMPHONY_SSH_WORKER_HOSTS', []))
  const linearConfigured = Boolean(env('LINEAR_API_KEY') && projectSlug)
  const workflow = await inspectWorkflow(args.workflow)
  const liveWorkflowReady = workflow.status === 'ready'
  const gates = buildGates({
    linearConfigured,
    liveWorkflowReady,
    workerHostCount: workerHosts.length,
  })

  const overallStatus = overall(linearConfigured, liveWorkflowReady)

  console.log(
    JSON.stringify(
      {
        ok: true,
        read_only: true,
        overall_status: overallStatus,
        recommended_next: nextStep(overallStatus),
        env: {
          dotenv_path: dotenv.path,
          dotenv_loaded: dotenv.loaded,
          linear_api_key_present: Boolean(env('LINEAR_API_KEY')),
          project_slug: projectSlug?.value ?? null,
          project_slug_source: projectSlug?.key ?? null,
          required_labels: csvEnv('SYMPHONY_REQUIRED_LABELS', ['codex']),
          active_states: csvEnv('SYMPHONY_ACTIVE_STATES', ['Todo', 'In Progress']),
          terminal_states: csvEnv('SYMPHONY_TERMINAL_STATES', [
            'Done',
            'Closed',
            'Cancelled',
            'Canceled',
            'Duplicate',
          ]),
          assignee_configured: Boolean(env('LINEAR_ASSIGNEE')),
          worker_host_count: workerHosts.length,
          opt_in: {
            codex_live_turn: booleanEnv('SYMPHONY_LIVE_CODEX_SMOKE'),
            live_e2e: booleanEnv('SYMPHONY_RUN_LIVE_E2E'),
            real_preflight_required: booleanEnv('SYMPHONY_REAL_PREFLIGHT_REQUIRED'),
            ssh_worker_preflight_required: booleanEnv('SYMPHONY_SSH_WORKER_PREFLIGHT_REQUIRED'),
          },
        },
        workflow,
        gates,
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
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

async function inspectWorkflow(workflowPathArg: string): Promise<WorkflowStatus> {
  const workflowPath = path.resolve(root, workflowPathArg)
  if (!existsSync(workflowPath)) {
    return {
      status: 'missing',
      path: workflowPath,
      exists: false,
    }
  }

  const content = await readFile(workflowPath, 'utf8')
  const secret = env('LINEAR_API_KEY')
  const secretWritten = Boolean(secret && content.includes(secret))

  let workflow
  try {
    workflow = parseWorkflow(content, workflowPath)
  } catch (error) {
    return {
      status: 'invalid',
      path: workflowPath,
      exists: true,
      errors: [
        {
          code: 'workflow_parse_error',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      secret_written: secretWritten,
    }
  }

  const resolved = resolveWorkflowConfig(workflow, process.env)
  if (!resolved.ok) {
    return {
      status: 'invalid',
      path: workflowPath,
      exists: true,
      errors: resolved.errors,
      secret_written: secretWritten,
    }
  }

  const liveErrors = liveConfigErrors(resolved.config)
  if (liveErrors.length > 0) {
    return {
      status: 'not_live',
      path: workflowPath,
      exists: true,
      errors: liveErrors,
      tracker: summarizeTracker(resolved.config),
      runner: resolved.config.agent.runner,
      mock_tracker: resolved.config.demo.mock_tracker,
      secret_written: secretWritten,
    }
  }

  return {
    status: 'ready',
    path: workflowPath,
    exists: true,
    tracker: summarizeTracker(resolved.config),
    runner: resolved.config.agent.runner,
    mock_tracker: resolved.config.demo.mock_tracker,
    workspace_root: resolved.config.workspace.root,
    logging_path: path.join(resolved.config.logging.root, resolved.config.logging.file),
    secret_written: secretWritten,
  }
}

function buildGates(input: {
  linearConfigured: boolean
  liveWorkflowReady: boolean
  workerHostCount: number
}): Array<Gate> {
  return [
    gate('typecheck', 'npm run typecheck', 'ready_to_run', true, false),
    gate('unit_and_smoke_tests', 'npm test', 'ready_to_run', true, false),
    gate('production_build', 'npm run build', 'ready_to_run', true, false),
    gate(
      'real_preflight',
      'npm run smoke:real-preflight',
      input.linearConfigured ? 'ready_to_run' : 'blocked',
      true,
      false,
      undefined,
      input.linearConfigured ? undefined : 'LINEAR_API_KEY and a Linear project slug are required.',
    ),
    gate(
      'prepare_live_workflow',
      'npm run workflow:live',
      input.linearConfigured ? 'ready_to_run' : 'blocked',
      true,
      false,
      undefined,
      input.linearConfigured ? undefined : 'LINEAR_API_KEY and a Linear project slug are required.',
    ),
    gate(
      'check_live_workflow',
      'npm run workflow:check-live',
      input.liveWorkflowReady ? 'ready_to_run' : 'blocked',
      true,
      false,
      undefined,
      input.liveWorkflowReady ? undefined : 'Generate a live workflow with npm run workflow:live first.',
    ),
    gate(
      'smoke_live_runtime_readonly',
      'npm run workflow:smoke-live-readonly',
      input.liveWorkflowReady ? 'ready_to_run' : 'blocked',
      true,
      false,
      undefined,
      input.liveWorkflowReady ? undefined : 'Generate a live workflow with npm run workflow:live first.',
    ),
    gate(
      'codex_live_turn',
      'npm run smoke:codex-live-turn',
      booleanEnv('SYMPHONY_LIVE_CODEX_SMOKE') ? 'ready_to_run' : 'skipped',
      false,
      true,
      { SYMPHONY_LIVE_CODEX_SMOKE: '1' },
      booleanEnv('SYMPHONY_LIVE_CODEX_SMOKE')
        ? 'This invokes a real Codex turn.'
        : 'Set SYMPHONY_LIVE_CODEX_SMOKE=1 only when you want to invoke a real Codex turn.',
    ),
    gate(
      'ssh_worker_preflight',
      'npm run smoke:ssh-worker-preflight',
      sshPreflightStatus(input.workerHostCount),
      false,
      true,
      undefined,
      sshPreflightReason(input.workerHostCount),
    ),
    gate(
      'live_e2e',
      'npm run smoke:live-e2e',
      liveE2eStatus(input.linearConfigured),
      false,
      true,
      { SYMPHONY_RUN_LIVE_E2E: '1' },
      liveE2eReason(input.linearConfigured),
    ),
  ]
}

function gate(
  name: string,
  command: string,
  status: GateStatus,
  readOnly: boolean,
  externalSideEffects: boolean,
  gateEnv?: Record<string, string>,
  reason?: string,
): Gate {
  return {
    name,
    command,
    status,
    read_only: readOnly,
    external_side_effects: externalSideEffects,
    ...(gateEnv ? { env: gateEnv } : {}),
    ...(reason ? { reason } : {}),
  }
}

function sshPreflightStatus(workerHostCount: number): GateStatus {
  if (workerHostCount > 0) {
    return 'ready_to_run'
  }
  return booleanEnv('SYMPHONY_SSH_WORKER_PREFLIGHT_REQUIRED') ? 'blocked' : 'skipped'
}

function sshPreflightReason(workerHostCount: number): string {
  if (workerHostCount > 0) {
    return 'Configured SSH hosts are present; this starts and closes remote Codex app-server sessions without turn/start.'
  }
  return 'Configure SYMPHONY_LIVE_SSH_WORKER_HOSTS only when you want to validate SSH workers.'
}

function liveE2eStatus(linearConfigured: boolean): GateStatus {
  if (!booleanEnv('SYMPHONY_RUN_LIVE_E2E')) {
    return 'skipped'
  }
  return linearConfigured ? 'ready_to_run' : 'blocked'
}

function liveE2eReason(linearConfigured: boolean): string {
  if (!booleanEnv('SYMPHONY_RUN_LIVE_E2E')) {
    return 'Set SYMPHONY_RUN_LIVE_E2E=1 only with explicit intent; this creates/updates Linear issues and invokes Codex.'
  }
  if (!linearConfigured) {
    return 'LINEAR_API_KEY and a Linear project slug are required.'
  }
  return 'This creates or reuses a Linear project, creates a temporary issue, invokes Codex, comments, and completes the issue.'
}

function liveConfigErrors(config: EffectiveConfig): Array<{ code: string; message: string }> {
  const errors: Array<{ code: string; message: string }> = []
  if (config.tracker.kind !== 'linear') {
    errors.push({ code: 'not_live_linear', message: 'workflow tracker.kind must be linear for live acceptance' })
  }
  if (config.demo.mock_tracker) {
    errors.push({ code: 'mock_tracker_enabled', message: 'workflow demo.mock_tracker must be false for live acceptance' })
  }
  if (config.agent.runner !== 'codex') {
    errors.push({ code: 'codex_runner_disabled', message: 'workflow agent.runner must be codex for live acceptance' })
  }
  if (config.tracker.api_key.trim() === '') {
    errors.push({ code: 'missing_tracker_api_key', message: 'workflow tracker.api_key must resolve for live acceptance' })
  }
  if (config.tracker.project_slug.trim() === '') {
    errors.push({
      code: 'missing_tracker_project_slug',
      message: 'workflow tracker.project_slug must resolve for live acceptance',
    })
  }
  return errors
}

function summarizeTracker(config: EffectiveConfig): WorkflowTrackerSummary {
  return {
    kind: config.tracker.kind,
    project_slug: config.tracker.project_slug || null,
    required_labels: config.tracker.required_labels,
    active_states: config.tracker.active_states,
    terminal_states: config.tracker.terminal_states,
    assignee_configured: Boolean(config.tracker.assignee),
  }
}

function overall(linearConfigured: boolean, liveWorkflowReady: boolean): string {
  if (!linearConfigured) {
    return 'needs_linear_configuration'
  }
  if (!liveWorkflowReady) {
    return 'linear_configured_generate_live_workflow'
  }
  return 'ready_for_read_only_live_validation'
}

function nextStep(status: string): string {
  if (status === 'needs_linear_configuration') {
    return 'Add LINEAR_API_KEY and LINEAR_PROJECT_SLUG, then run npm run workflow:live.'
  }
  if (status === 'linear_configured_generate_live_workflow') {
    return 'Run npm run workflow:live to generate .tmp/live-workflow/WORKFLOW.md.'
  }
  return 'Run npm run workflow:check-live, then npm run workflow:smoke-live-readonly. Ask before running the mutating live e2e gate.'
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

async function loadDotEnv(dotEnvPath: string): Promise<{ path: string; loaded: boolean }> {
  if (!existsSync(dotEnvPath)) {
    return { path: dotEnvPath, loaded: false }
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
  return { path: dotEnvPath, loaded: true }
}

function firstPresentEnv(names: Array<string>): { key: string; value: string } | null {
  for (const key of names) {
    const value = env(key)
    if (value) {
      return { key, value }
    }
  }
  return null
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

import os from 'node:os'
import path from 'node:path'
import type {
  EffectiveConfig,
  Issue,
  SymphonyErrorPayload,
  WorkflowConfigOverrides,
  WorkflowConfigResult,
  WorkflowDefinition,
} from './types'

const DEFAULT_ACTIVE_STATES = ['Todo', 'In Progress']
const DEFAULT_TERMINAL_STATES = ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']
const DEFAULT_GITHUB_ACTIVE_STATES = ['Open']
const DEFAULT_GITHUB_TERMINAL_STATES = ['Closed']
const DEFAULT_WORKSPACE_ROOT = path.join(os.tmpdir(), 'symphony_workspaces')
const DEFAULT_CODEX_APPROVAL_POLICY = {
  reject: {
    sandbox_approval: true,
    rules: true,
    mcp_elicitations: true,
  },
}

export function resolveWorkflowConfig(
  workflow: WorkflowDefinition,
  env: NodeJS.ProcessEnv = process.env,
  overrides: WorkflowConfigOverrides = {},
): WorkflowConfigResult {
  const raw = workflow.config
  const errors: Array<SymphonyErrorPayload> = []

  const tracker = asRecord(raw.tracker)
  const polling = asRecord(raw.polling)
  const workspace = asRecord(raw.workspace)
  const worker = asRecord(raw.worker)
  const hooks = asRecord(raw.hooks)
  const agent = asRecord(raw.agent)
  const codex = asRecord(raw.codex)
  const server = asRecord(raw.server)
  const logging = asRecord(raw.logging)
  const observability = asRecord(raw.observability)
  const demo = asRecord(raw.demo)
  const trackerKind = stringValue(tracker.kind, '').trim()
  const mockTracker = booleanValue(demo.mock_tracker, trackerKind === 'linear' || !trackerKind)
  if (!trackerKind) {
    errors.push({
      code: 'missing_tracker_kind',
      message: 'tracker.kind is required and currently supports "linear", "github", or "memory"',
    })
  } else if (trackerKind !== 'linear' && trackerKind !== 'github' && trackerKind !== 'memory') {
    errors.push({
      code: 'unsupported_tracker_kind',
      message: `Unsupported tracker.kind "${trackerKind}". This implementation currently supports "linear", "github", or "memory".`,
    })
  }

  const apiKey = resolveSecretValue(tracker.api_key, env.LINEAR_API_KEY, env).trim()
  const projectSlug = resolveEnvValue(stringValue(tracker.project_slug, ''), env).trim()
  const repository = resolveEnvValue(
    stringValue(tracker.repo ?? tracker.repository, env.GITHUB_REPOSITORY ?? ''),
    env,
  ).trim()
  const ghCommand = stringValue(tracker.gh_command ?? tracker.github_command, 'gh').trim() || 'gh'
  const assigneeFallback =
    trackerKind === 'github' ? env.GITHUB_ASSIGNEE ?? env.GH_ASSIGNEE : env.LINEAR_ASSIGNEE
  const codexCommand = codexCommandValue(codex.command, errors)
  const approvalPolicy = stringOrObjectValue(
    codex.approval_policy,
    DEFAULT_CODEX_APPROVAL_POLICY,
    'codex.approval_policy',
    errors,
  )
  const threadSandbox = stringOnlyValue(
    codex.thread_sandbox,
    'workspace-write',
    'codex.thread_sandbox',
    errors,
  )
  const turnSandboxPolicy = objectValue(
    codex.turn_sandbox_policy,
    'workspace-write',
    'codex.turn_sandbox_policy',
    errors,
  )
  const runner = stringValue(
    agent.runner,
    env.SYMPHONY_RUNNER ?? (mockTracker || trackerKind === 'memory' ? 'simulated' : 'codex'),
  )
  const activeStateFallback =
    trackerKind === 'github' ? DEFAULT_GITHUB_ACTIVE_STATES : DEFAULT_ACTIVE_STATES
  const terminalStateFallback =
    trackerKind === 'github' ? DEFAULT_GITHUB_TERMINAL_STATES : DEFAULT_TERMINAL_STATES
  const requiredLabels = normalizeRequiredLabels(
    stringListValue(tracker.required_labels, [], 'tracker.required_labels', errors),
  )
  const activeStates = stringListValue(
    tracker.active_states,
    activeStateFallback,
    'tracker.active_states',
    errors,
  )
  const terminalStates = stringListValue(
    tracker.terminal_states,
    terminalStateFallback,
    'tracker.terminal_states',
    errors,
  )
  const workerHosts = arrayOfStrings(worker.ssh_hosts, []).map((host) => host.trim()).filter(Boolean)
  const workspaceRootValue = stringValue(workspace.root, DEFAULT_WORKSPACE_ROOT)

  if (trackerKind === 'linear' && !apiKey) {
    errors.push({
      code: 'missing_tracker_api_key',
      message: 'tracker.api_key is required and may point at $LINEAR_API_KEY',
    })
  }

  if (trackerKind === 'linear' && !projectSlug) {
    errors.push({
      code: 'missing_tracker_project_slug',
      message: 'tracker.project_slug is required for tracker.kind=linear and may point at $LINEAR_PROJECT_SLUG',
    })
  }

  if (runner !== 'simulated' && runner !== 'codex') {
    errors.push({
      code: 'invalid_config',
      message: 'agent.runner must be either "simulated" or "codex"',
    })
  }

  const hookTimeout = positiveInteger(hooks.timeout_ms, 60_000, 'hooks.timeout_ms', errors)
  const maxConcurrentAgents = positiveInteger(
    agent.max_concurrent_agents,
    10,
    'agent.max_concurrent_agents',
    errors,
  )
  const maxTurns = positiveInteger(agent.max_turns, 20, 'agent.max_turns', errors)
  const maxRetryBackoff = positiveInteger(
    agent.max_retry_backoff_ms,
    300_000,
    'agent.max_retry_backoff_ms',
    errors,
  )
  const maxConcurrentAgentsByState = parseStateConcurrency(
    agent.max_concurrent_agents_by_state,
    errors,
  )
  const maxConcurrentAgentsPerHost = nullablePositiveInteger(
    worker.max_concurrent_agents_per_host,
    'worker.max_concurrent_agents_per_host',
    errors,
  )
  const stallTimeout = nonNegativeInteger(
    codex.stall_timeout_ms,
    300_000,
    'codex.stall_timeout_ms',
    errors,
  )
  const memoryIssues = parseMemoryIssues(tracker.issues, errors)
  const loggingRoot = resolvePathValue(
    overrides.logging_root ?? stringValue(logging.root, './log'),
    workflow.directory,
    env,
  )
  const loggingFile = stringValue(logging.file, 'symphony.jsonl').trim() || 'symphony.jsonl'
  if (!relativePathStaysWithinRoot(loggingRoot, loggingFile)) {
    errors.push({
      code: 'invalid_config',
      message: 'logging.file must resolve inside logging.root',
    })
  }

  const config: EffectiveConfig = {
    workflow_path: workflow.path,
    workflow_directory: workflow.directory,
    tracker: {
      kind: trackerKind === 'memory' ? 'memory' : trackerKind === 'github' ? 'github' : 'linear',
      endpoint: stringValue(tracker.endpoint, 'https://api.linear.app/graphql'),
      api_key: apiKey,
      project_slug: projectSlug,
      repository: repository || null,
      gh_command: ghCommand,
      assignee: nullableResolvedSecret(tracker.assignee, assigneeFallback, env),
      required_labels: requiredLabels,
      active_states: activeStates,
      terminal_states: terminalStates,
      memory_issues: memoryIssues,
    },
    polling: {
      interval_ms: positiveInteger(polling.interval_ms, 30_000, 'polling.interval_ms', errors),
    },
    workspace: {
      root: resolvePathValue(
        workspaceRootValue,
        workflow.directory,
        env,
        DEFAULT_WORKSPACE_ROOT,
      ),
      remote_root: resolveRemotePathValue(workspaceRootValue, env, DEFAULT_WORKSPACE_ROOT),
    },
    worker: {
      ssh_hosts: workerHosts,
      max_concurrent_agents_per_host: maxConcurrentAgentsPerHost,
    },
    hooks: {
      after_create: nullableString(hooks.after_create),
      before_run: nullableString(hooks.before_run),
      after_run: nullableString(hooks.after_run),
      before_remove: nullableString(hooks.before_remove),
      timeout_ms: hookTimeout,
    },
    agent: {
      runner: runner === 'codex' ? 'codex' : 'simulated',
      max_concurrent_agents: maxConcurrentAgents,
      max_turns: maxTurns,
      max_retry_backoff_ms: maxRetryBackoff,
      max_concurrent_agents_by_state: maxConcurrentAgentsByState,
    },
    codex: {
      command: codexCommand,
      model: nullableString(codex.model),
      approval_policy: approvalPolicy,
      approvals_reviewer: codex.approvals_reviewer ?? null,
      thread_sandbox: threadSandbox,
      turn_sandbox_policy: turnSandboxPolicy,
      turn_timeout_ms: positiveInteger(codex.turn_timeout_ms, 3_600_000, 'codex.turn_timeout_ms', errors),
      read_timeout_ms: positiveInteger(codex.read_timeout_ms, 5_000, 'codex.read_timeout_ms', errors),
      stall_timeout_ms: stallTimeout,
    },
    server: {
      port: overrides.server_port === undefined ? nullablePort(server.port, 'server.port', errors) : overrides.server_port,
      host: serverHost(server.host, errors),
    },
    logging: {
      enabled: booleanValue(logging.enabled, true),
      root: loggingRoot,
      file: loggingFile,
    },
    observability: {
      dashboard_enabled: booleanStrict(
        observability.dashboard_enabled,
        true,
        'observability.dashboard_enabled',
        errors,
      ),
      refresh_ms: positiveInteger(
        observability.refresh_ms,
        1000,
        'observability.refresh_ms',
        errors,
      ),
      render_interval_ms: positiveInteger(
        observability.render_interval_ms,
        16,
        'observability.render_interval_ms',
        errors,
      ),
    },
    demo: {
      mock_tracker: mockTracker,
    },
  }

  if (errors.length > 0) {
    return { ok: false, config, errors }
  }

  return { ok: true, config, errors: [] }
}

export function normalizeStateName(state: string): string {
  return state.trim().toLowerCase()
}

export function stateInList(state: string, states: Array<string>): boolean {
  const normalized = normalizeStateName(state)
  return states.some((candidate) => normalizeStateName(candidate) === normalized)
}

export function normalizeLabels(labels: Array<string>): Array<string> {
  return labels.map((label) => label.trim().toLowerCase()).filter(Boolean)
}

function normalizeRequiredLabels(labels: Array<string>): Array<string> {
  return uniqueStrings(labels.map((label) => label.trim().toLowerCase()))
}

function uniqueStrings(values: Array<string>): Array<string> {
  return Array.from(new Set(values))
}

function stringListValue(
  value: unknown,
  fallback: Array<string>,
  field: string,
  errors: Array<SymphonyErrorPayload>,
): Array<string> {
  if (value === undefined || value === null) {
    return fallback
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push({
      code: 'invalid_config',
      message: `${field} must be a list of strings`,
    })
    return fallback
  }

  return value
}

function parseStateConcurrency(
  value: unknown,
  errors: Array<SymphonyErrorPayload>,
): Record<string, number> {
  if (value === undefined || value === null) {
    return {}
  }

  if (!isRecord(value)) {
    errors.push({
      code: 'invalid_config',
      message: 'agent.max_concurrent_agents_by_state must be an object',
    })
    return {}
  }

  const parsed: Record<string, number> = {}
  for (const [state, limit] of Object.entries(value)) {
    const normalizedState = normalizeStateName(state)
    if (!normalizedState) {
      errors.push({
        code: 'invalid_config',
        message: 'agent.max_concurrent_agents_by_state state names must not be blank',
      })
      continue
    }

    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
      errors.push({
        code: 'invalid_config',
        message: 'agent.max_concurrent_agents_by_state limits must be positive integers',
      })
      continue
    }

    parsed[normalizedState] = limit
  }

  return parsed
}

function parseMemoryIssues(
  value: unknown,
  errors: Array<SymphonyErrorPayload>,
): Array<Issue> {
  if (value === undefined || value === null) {
    return []
  }

  if (!Array.isArray(value)) {
    errors.push({
      code: 'invalid_config',
      message: 'tracker.issues must be a list when tracker.kind=memory',
    })
    return []
  }

  const issues: Array<Issue> = []
  value.forEach((item, index) => {
    const raw = asRecord(item)
    const id = nullableString(raw.id)
    const identifier = nullableString(raw.identifier)
    const title = nullableString(raw.title)
    const state = nullableString(raw.state)
    if (!id || !identifier || !title || !state) {
      errors.push({
        code: 'invalid_config',
        message: `tracker.issues[${index}] must include id, identifier, title, and state`,
      })
      return
    }

    issues.push({
      id,
      identifier,
      title,
      description: nullableString(raw.description),
      priority: nullableNumber(raw.priority),
      state,
      branch_name: nullableString(raw.branch_name ?? raw.branchName),
      url: nullableString(raw.url),
      assignee_id: nullableString(raw.assignee_id ?? raw.assigneeId),
      assigned_to_worker: booleanValue(raw.assigned_to_worker ?? raw.assignedToWorker, true),
      labels: arrayOfStrings(raw.labels, []).map((label) => label.trim()).filter(Boolean),
      blocked_by: parseMemoryBlockers(raw.blocked_by ?? raw.blockedBy),
      created_at: nullableString(raw.created_at ?? raw.createdAt),
      updated_at: nullableString(raw.updated_at ?? raw.updatedAt),
    })
  })

  return issues
}

function parseMemoryBlockers(value: unknown): Issue['blocked_by'] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => {
      const raw = asRecord(item)
      return {
        id: nullableString(raw.id),
        identifier: nullableString(raw.identifier),
        state: nullableString(raw.state),
        created_at: nullableString(raw.created_at ?? raw.createdAt),
        updated_at: nullableString(raw.updated_at ?? raw.updatedAt),
      }
    })
}

function resolvePathValue(
  value: string,
  workflowDirectory: string,
  env: NodeJS.ProcessEnv,
  fallback?: string,
): string {
  const expandedEnv = resolveEnvValue(value, env)
  const resolvedValue = expandedEnv === '' && fallback !== undefined ? fallback : expandedEnv
  const expandedHome = expandHomePath(resolvedValue)

  if (path.isAbsolute(expandedHome)) {
    return path.resolve(expandedHome)
  }

  return path.resolve(workflowDirectory, expandedHome)
}

function resolveRemotePathValue(value: string, env: NodeJS.ProcessEnv, fallback?: string): string {
  const expandedEnv = resolveEnvValue(value, env)
  const resolvedValue = expandedEnv === '' && fallback !== undefined ? fallback : expandedEnv
  return resolvedValue.replaceAll('\\', '/')
}

function expandHomePath(value: string): string {
  if (value === '~') {
    return os.homedir()
  }

  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }

  return value
}

function relativePathStaysWithinRoot(root: string, relativePath: string): boolean {
  if (path.isAbsolute(relativePath)) {
    return false
  }

  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(resolvedRoot, relativePath)
  const relative = path.relative(resolvedRoot, resolvedTarget)

  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function resolveEnvValue(value: string, env: NodeJS.ProcessEnv): string {
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return env[value.slice(1)] ?? ''
  }

  return value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, key: string) => env[key] ?? '')
}

function resolveSecretValue(
  value: unknown,
  fallback: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  if (value === undefined || value === null) {
    return fallback ?? ''
  }

  const raw = stringValue(value, '')
  const exactEnvName = exactEnvReferenceName(raw)
  if (!exactEnvName) {
    return resolveEnvValue(raw, env)
  }

  if (!(exactEnvName in env)) {
    return fallback ?? ''
  }

  return env[exactEnvName] ?? ''
}

function exactEnvReferenceName(value: string): string | null {
  const match = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)
  return match?.[1] ?? null
}

function arrayOfStrings(value: unknown, fallback: Array<string>): Array<string> {
  if (!Array.isArray(value)) {
    return fallback
  }

  return value.map((item) => String(item))
}

function positiveInteger(
  value: unknown,
  fallback: number,
  field: string,
  errors: Array<SymphonyErrorPayload>,
): number {
  if (value === undefined || value === null || value === '') {
    return fallback
  }

  const numeric = Number(value)
  if (Number.isInteger(numeric) && numeric > 0) {
    return numeric
  }

  errors.push({
    code: 'invalid_config',
    message: `${field} must be a positive integer`,
  })
  return fallback
}

function nullablePositiveInteger(
  value: unknown,
  field: string,
  errors: Array<SymphonyErrorPayload>,
): number | null {
  if (value === undefined || value === null || value === '') {
    return null
  }

  const numeric = Number(value)
  if (Number.isInteger(numeric) && numeric > 0) {
    return numeric
  }

  errors.push({
    code: 'invalid_config',
    message: `${field} must be a positive integer`,
  })
  return null
}

function nullablePort(
  value: unknown,
  field: string,
  errors: Array<SymphonyErrorPayload>,
): number | null {
  if (value === undefined || value === null || value === '') {
    return null
  }

  const numeric = Number(value)
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 65_535) {
    return numeric
  }

  errors.push({
    code: 'invalid_config',
    message: `${field} must be an integer between 0 and 65535`,
  })
  return null
}

function serverHost(value: unknown, errors: Array<SymphonyErrorPayload>): string {
  if (value === undefined || value === null) {
    return '127.0.0.1'
  }

  if (typeof value !== 'string') {
    errors.push({
      code: 'invalid_config',
      message: 'server.host must be a string',
    })
    return '127.0.0.1'
  }

  return value.trim() || '127.0.0.1'
}

function nonNegativeInteger(
  value: unknown,
  fallback: number,
  field: string,
  errors: Array<SymphonyErrorPayload>,
): number {
  if (value === undefined || value === null || value === '') {
    return fallback
  }

  const numeric = Number(value)
  if (Number.isInteger(numeric) && numeric >= 0) {
    return numeric
  }

  errors.push({
    code: 'invalid_config',
    message: `${field} must be a non-negative integer`,
  })
  return fallback
}

function codexCommandValue(value: unknown, errors: Array<SymphonyErrorPayload>): string {
  if (value === undefined || value === null) {
    return 'codex app-server'
  }

  if (typeof value !== 'string') {
    errors.push({
      code: 'invalid_config',
      message: 'codex.command must be a string',
    })
    return 'codex app-server'
  }

  if (value === '') {
    errors.push({
      code: 'missing_codex_command',
      message: 'codex.command must be a non-empty shell command',
    })
  }

  return value
}

function stringOnlyValue(
  value: unknown,
  fallback: string,
  field: string,
  errors: Array<SymphonyErrorPayload>,
): string {
  if (value === undefined || value === null) {
    return fallback
  }

  if (typeof value === 'string') {
    return value
  }

  errors.push({
    code: 'invalid_config',
    message: `${field} must be a string`,
  })
  return fallback
}

function stringOrObjectValue(
  value: unknown,
  fallback: unknown,
  field: string,
  errors: Array<SymphonyErrorPayload>,
): unknown {
  if (value === undefined || value === null) {
    return fallback
  }

  if (typeof value === 'string' || isRecord(value)) {
    return value
  }

  errors.push({
    code: 'invalid_config',
    message: `${field} must be a string or object`,
  })
  return fallback
}

function objectValue(
  value: unknown,
  fallback: unknown,
  field: string,
  errors: Array<SymphonyErrorPayload>,
): unknown {
  if (value === undefined || value === null) {
    return fallback
  }

  if (isRecord(value)) {
    return value
  }

  errors.push({
    code: 'invalid_config',
    message: `${field} must be an object`,
  })
  return fallback
}

function stringValue(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    return value
  }

  if (value === undefined || value === null) {
    return fallback
  }

  return String(value)
}

function nullableString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value
  }

  return null
}

function nullableNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null
  }

  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function nullableResolvedSecret(
  value: unknown,
  fallback: string | undefined,
  env: NodeJS.ProcessEnv,
): string | null {
  const raw = value === undefined || value === null ? null : stringValue(value, '')
  if (raw === null || raw === '') {
    return fallback?.trim() || null
  }

  return resolveSecretValue(raw, fallback, env).trim() || null
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'string') {
    return value.toLowerCase() === 'true'
  }

  return fallback
}

function booleanStrict(
  value: unknown,
  fallback: boolean,
  field: string,
  errors: Array<SymphonyErrorPayload>,
): boolean {
  if (value === undefined || value === null || value === '') {
    return fallback
  }

  if (typeof value === 'boolean') {
    return value
  }

  errors.push({
    code: 'invalid_config',
    message: `${field} must be a boolean`,
  })
  return fallback
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

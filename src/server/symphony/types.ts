export type IssueState = string

export type BlockerRef = {
  id: string | null
  identifier: string | null
  state: IssueState | null
  created_at: string | null
  updated_at: string | null
}

export type Issue = {
  id: string
  identifier: string
  title: string
  description: string | null
  priority: number | null
  state: IssueState
  branch_name: string | null
  url: string | null
  assignee_id: string | null
  assigned_to_worker: boolean
  labels: Array<string>
  blocked_by: Array<BlockerRef>
  created_at: string | null
  updated_at: string | null
}

export type WorkflowDefinition = {
  path: string
  directory: string
  config: Record<string, unknown>
  prompt_template: string
}

export type WorkflowConfigOverrides = {
  logging_root?: string
  server_port?: number | null
}

export type TrackerKind = 'linear' | 'github' | 'memory'

export type TrackerConfig = {
  kind: TrackerKind
  endpoint: string
  api_key: string
  project_slug: string
  repository: string | null
  gh_command: string
  assignee: string | null
  required_labels: Array<string>
  active_states: Array<string>
  terminal_states: Array<string>
  memory_issues: Array<Issue>
}

export type PollingConfig = {
  interval_ms: number
}

export type WorkspaceConfig = {
  root: string
  remote_root?: string
}

export type WorkerConfig = {
  ssh_hosts: Array<string>
  max_concurrent_agents_per_host: number | null
}

export type HooksConfig = {
  after_create: string | null
  before_run: string | null
  after_run: string | null
  before_remove: string | null
  timeout_ms: number
}

export type AgentConfig = {
  runner: 'simulated' | 'codex'
  max_concurrent_agents: number
  max_turns: number
  max_retry_backoff_ms: number
  max_concurrent_agents_by_state: Record<string, number>
}

export type CodexConfig = {
  command: string
  model: string | null
  approval_policy: unknown
  approvals_reviewer: unknown
  thread_sandbox: unknown
  turn_sandbox_policy: unknown
  turn_timeout_ms: number
  read_timeout_ms: number
  stall_timeout_ms: number
}

export type ServerConfig = {
  port: number | null
  host: string
}

export type LoggingConfig = {
  enabled: boolean
  root: string
  file: string
}

export type ObservabilityConfig = {
  dashboard_enabled: boolean
  refresh_ms: number
  render_interval_ms: number
}

export type DemoConfig = {
  mock_tracker: boolean
}

export type EffectiveConfig = {
  workflow_path: string
  workflow_directory: string
  tracker: TrackerConfig
  polling: PollingConfig
  workspace: WorkspaceConfig
  worker: WorkerConfig
  hooks: HooksConfig
  agent: AgentConfig
  codex: CodexConfig
  server: ServerConfig
  logging: LoggingConfig
  observability: ObservabilityConfig
  demo: DemoConfig
}

export type WorkflowConfigResult =
  | { ok: true; config: EffectiveConfig; errors: [] }
  | { ok: false; config: EffectiveConfig | null; errors: Array<SymphonyErrorPayload> }

export type SymphonyErrorCode =
  | 'missing_workflow_file'
  | 'workflow_parse_error'
  | 'workflow_front_matter_not_a_map'
  | 'template_parse_error'
  | 'template_render_error'
  | 'unsupported_tracker_kind'
  | 'missing_tracker_kind'
  | 'missing_tracker_api_key'
  | 'missing_tracker_project_slug'
  | 'missing_codex_command'
  | 'invalid_config'
  | 'linear_api_request'
  | 'linear_api_status'
  | 'linear_graphql_errors'
  | 'linear_unknown_payload'
  | 'linear_missing_end_cursor'
  | 'linear_state_not_found'
  | 'github_cli_request'
  | 'github_cli_status'
  | 'github_unknown_payload'
  | 'github_unsupported_state'
  | 'workspace_error'
  | 'hook_error'
  | 'agent_error'
  | 'issue_not_found'
  | 'service_not_running'
  | 'invalid_control_action'
  | 'method_not_allowed'
  | 'snapshot_unavailable'
  | 'snapshot_timeout'
  | 'orchestrator_unavailable'
  | 'unavailable'

export type SymphonyErrorPayload = {
  code: SymphonyErrorCode
  message: string
  details?: Record<string, unknown>
}

export type RunAttemptStatus =
  | 'PreparingWorkspace'
  | 'BuildingPrompt'
  | 'LaunchingAgentProcess'
  | 'InitializingSession'
  | 'StreamingTurn'
  | 'Blocked'
  | 'Finishing'
  | 'Succeeded'
  | 'Failed'
  | 'TimedOut'
  | 'Stalled'
  | 'CanceledByReconciliation'

export type TokenTotals = {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  seconds_running: number
}

export type AgentRuntimeEvent = {
  event: string
  timestamp: string
  codex_app_server_pid?: string | null
  session_id?: string | null
  thread_id?: string | null
  turn_id?: string | null
  message?: string | null
  usage?: Partial<TokenTotals>
  rate_limits?: unknown
}

export type Workspace = {
  path: string
  workspace_key: string
  created_now: boolean
}

export type RetrySnapshotRow = {
  issue_id: string
  issue_identifier: string
  issue_url: string | null
  attempt: number
  due_at: string
  last_attempt_status: RunAttemptStatus
  error: string | null
  workspace_path: string | null
  worker_host: string | null
}

export type BlockedSnapshotRow = {
  issue_id: string
  issue_identifier: string
  issue_url: string | null
  state: string
  reason: string
  error: string
  blocked_at: string
  workspace_path: string | null
  worker_host: string | null
  session_id: string | null
  thread_id: string | null
  turn_id: string | null
  codex_app_server_pid: string | null
  last_event: string | null
  last_message: string | null
  last_event_at: string | null
}

export type RunningSnapshotRow = {
  issue_id: string
  issue_identifier: string
  issue_url: string | null
  state: string
  session_id: string | null
  thread_id: string | null
  turn_id: string | null
  codex_app_server_pid: string | null
  turn_count: number
  last_event: string | null
  last_message: string | null
  started_at: string
  last_event_at: string | null
  workspace_path: string | null
  worker_host: string | null
  status: RunAttemptStatus
  tokens: Omit<TokenTotals, 'seconds_running'>
}

export type PollingSnapshot = {
  'checking?': boolean
  next_poll_in_ms: number | null
  poll_interval_ms: number | null
}

export type RuntimeSnapshot = {
  generated_at: string
  service_status: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error'
  workflow_path: string | null
  counts: {
    running: number
    retrying: number
    blocked: number
    claimed: number
    completed: number
  }
  running: Array<RunningSnapshotRow>
  retrying: Array<RetrySnapshotRow>
  blocked: Array<BlockedSnapshotRow>
  codex_totals: TokenTotals
  rate_limits: unknown
  polling: PollingSnapshot
  recent_events: Array<{
    at: string
    event: string
    message: string
    issue_id?: string
    issue_identifier?: string
    session_id?: string
    thread_id?: string
    turn_id?: string
    codex_app_server_pid?: string
  }>
  config_errors: Array<SymphonyErrorPayload>
  last_error: SymphonyErrorPayload | null
  config: {
    poll_interval_ms: number | null
    max_concurrent_agents: number | null
    workspace_root: string | null
    worker_ssh_hosts: Array<string>
    worker_max_concurrent_agents_per_host: number | null
    active_states: Array<string>
    terminal_states: Array<string>
    runner: string
    tracker: string
    tracker_project_slug?: string | null
    tracker_repository?: string | null
    server_port: number | null
    server_host: string | null
    observability_dashboard_enabled: boolean | null
    observability_refresh_ms: number | null
    observability_render_interval_ms: number | null
    logging_path: string | null
  }
}

export type IssueDetailSnapshot = {
  issue_identifier: string
  issue_id: string
  issue: Issue | null
  status: 'running' | 'retrying' | 'blocked' | 'completed' | 'claimed' | 'unknown'
  workspace: {
    path: string | null
    host: string | null
  }
  attempts: {
    restart_count: number
    current_retry_attempt: number
  }
  running: RunningSnapshotRow | null
  retry: RetrySnapshotRow | null
  blocked: BlockedSnapshotRow | null
  logs: {
    codex_session_logs: Array<CodexSessionLog>
  }
  recent_events: RuntimeSnapshot['recent_events']
  last_error: string | null
  tracked: Record<string, unknown>
}

export type CodexSessionLog = {
  label: string
  path: string
  url: string | null
  session_id: string | null
  thread_id: string | null
  turn_id: string | null
  codex_app_server_pid: string | null
  event_count: number
  first_event_at: string | null
  last_event_at: string | null
  latest_event: string | null
  latest_message: string | null
  source_truncated: boolean
}

export type IssueTracker = {
  fetchCandidateIssues(config: EffectiveConfig): Promise<Array<Issue>>
  fetchIssuesByStates(states: Array<string>, config: EffectiveConfig): Promise<Array<Issue>>
  fetchIssueStatesByIds(ids: Array<string>, config: EffectiveConfig): Promise<Array<Issue>>
  createComment(issueId: string, body: string, config: EffectiveConfig): Promise<void>
  updateIssueState(issueId: string, stateName: string, config: EffectiveConfig): Promise<void>
}

import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { normalizeLabels, normalizeStateName, resolveWorkflowConfig, stateInList } from './config'
import { nowIso, secondsBetween } from './clock'
import { SymphonyError, toErrorPayload } from './errors'
import { summarizeCodexRuntimeMessage } from './codexEventSummary'
import { GithubTracker } from './githubTracker'
import { LinearTracker } from './linearTracker'
import { readIssueSessionLogs, structuredLogPath, writeStructuredLog } from './logger'
import { MemoryTracker } from './memoryTracker'
import { MockLinearTracker } from './mockTracker'
import { broadcastObservabilityUpdate } from './observability'
import { renderContinuationPrompt, renderIssuePrompt } from './prompt'
import { ConfiguredAgentRunner, openAgentSession, type AgentRunner } from './runner'
import {
  createWorkspaceForIssue,
  removeWorkspaceForIssue,
  runHook,
  runHookBestEffort,
  workspacePathForIssue,
} from './workspace'
import { loadWorkflow } from './workflow'
import type {
  AgentRuntimeEvent,
  BlockedSnapshotRow,
  EffectiveConfig,
  Issue,
  IssueDetailSnapshot,
  IssueTracker,
  RetrySnapshotRow,
  RunAttemptStatus,
  RunningSnapshotRow,
  RuntimeSnapshot,
  SymphonyErrorPayload,
  TokenTotals,
  WorkflowConfigOverrides,
  WorkflowDefinition,
} from './types'

type ServiceStatus = RuntimeSnapshot['service_status']
type TrackerMode = 'mock-linear' | 'linear' | 'github' | 'memory'
type TrackerFactory = (config: EffectiveConfig) => IssueTracker
const noWorkerCapacity = Symbol('noWorkerCapacity')
type WorkerHostSelection = string | null | typeof noWorkerCapacity
export type SymphonyStartOptions = {
  config_overrides?: WorkflowConfigOverrides
}

type RunningEntry = {
  issue: Issue
  worker_abort: AbortController
  workspace_ready: Promise<string | null>
  resolve_workspace_ready: (workspacePath: string | null) => void
  workspace_ready_settled: boolean
  workspace_path: string | null
  worker_host: string | null
  continuation_retry_allowed: boolean
  status: RunAttemptStatus
  session_id: string | null
  thread_id: string | null
  turn_id: string | null
  codex_app_server_pid: string | null
  last_codex_event: string | null
  last_codex_timestamp: string | null
  last_codex_message: string | null
  codex_input_tokens: number
  codex_output_tokens: number
  codex_total_tokens: number
  last_reported_input_tokens: number
  last_reported_output_tokens: number
  last_reported_total_tokens: number
  turn_count: number
  retry_attempt: number | null
  started_at: string
}

type RetryEntry = {
  issue: Issue
  issue_id: string
  identifier: string
  issue_url: string | null
  attempt: number
  due_at_ms: number
  timer_handle: ReturnType<typeof setTimeout>
  last_attempt_status: RunAttemptStatus
  error: string | null
  workspace_path: string | null
  worker_host: string | null
}

type BlockedEntry = {
  issue: Issue
  reason: string
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

type RecentEvent = RuntimeSnapshot['recent_events'][number]
type EventContext = {
  issue?: Issue | null
  issue_id?: string | null
  issue_identifier?: string | null
  session_id?: string | null
  thread_id?: string | null
  turn_id?: string | null
  codex_app_server_pid?: string | null
}
type ResolvedEventContext = {
  issue_id?: string
  issue_identifier?: string
  session_id?: string
  thread_id?: string
  turn_id?: string
  codex_app_server_pid?: string
}

export class SymphonyOrchestrator {
  private status: ServiceStatus = 'idle'
  private workflowPath: string | null = null
  private workflow: WorkflowDefinition | null = null
  private config: EffectiveConfig | null = null
  private tracker: IssueTracker | null = null
  private trackerMode: TrackerMode | null = null
  private readonly runner: AgentRunner
  private readonly trackerFactory: TrackerFactory
  private readonly running = new Map<string, RunningEntry>()
  private readonly claimed = new Set<string>()
  private readonly retryAttempts = new Map<string, RetryEntry>()
  private readonly blocked = new Map<string, BlockedEntry>()
  private readonly completed = new Map<string, Issue>()
  private readonly restartCounts = new Map<string, number>()
  private readonly recentEvents: Array<RecentEvent> = []
  private readonly codexTotals: TokenTotals = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    seconds_running: 0,
  }
  private codexRateLimits: unknown = null
  private configErrors: Array<SymphonyErrorPayload> = []
  private lastError: SymphonyErrorPayload | null = null
  private configOverrides: WorkflowConfigOverrides = {}
  private trackerConfigSignature: string | null = null
  private ticker: ReturnType<typeof setTimeout> | null = null
  private nextPollDueAtMs: number | null = null
  private watcher: FSWatcher | null = null
  private pollInFlight = false

  constructor(
    runner: AgentRunner = new ConfiguredAgentRunner(),
    trackerFactory: TrackerFactory = defaultTrackerFactory,
  ) {
    this.runner = runner
    this.trackerFactory = trackerFactory
  }

  async start(
    workflowPath = path.join(process.cwd(), 'WORKFLOW.md'),
    options: SymphonyStartOptions = {},
  ): Promise<RuntimeSnapshot> {
    if (this.status === 'running' || this.status === 'starting') {
      return this.snapshot()
    }

    this.status = 'starting'
    this.workflowPath = path.resolve(workflowPath)
    this.configOverrides = { ...(options.config_overrides ?? {}) }
    this.resetRuntimeState()

    try {
      await this.reloadWorkflow({ startup: true })
      await this.startupTerminalWorkspaceCleanup()
      this.watchWorkflow()
      this.status = 'running'
      this.recordEvent('service_started', `workflow=${this.workflowPath}`)
      this.scheduleTick(0)
    } catch (error) {
      this.status = 'error'
      this.lastError = toErrorPayload(error)
      throw error
    }

    return this.snapshot()
  }

  async stop(): Promise<RuntimeSnapshot> {
    if (this.status !== 'running' && this.status !== 'starting') {
      this.status = 'stopped'
      return this.snapshot()
    }

    this.status = 'stopping'
    this.clearTicker()
    this.watcher?.close()
    this.watcher = null

    for (const [issueId, retry] of this.retryAttempts.entries()) {
      clearTimeout(retry.timer_handle)
      this.claimed.delete(issueId)
    }
    this.retryAttempts.clear()

    const runningEntries = Array.from(this.running.entries())
    for (const [, entry] of runningEntries) {
      entry.status = 'CanceledByReconciliation'
      entry.worker_abort.abort()
    }
    await Promise.all(runningEntries.map(([, entry]) => entry.workspace_ready.catch(() => null)))

    for (const [issueId] of runningEntries) {
      if (!this.running.has(issueId)) {
        continue
      }
      this.closeRunningEntry(issueId)
      this.claimed.delete(issueId)
    }
    for (const issueId of this.blocked.keys()) {
      this.claimed.delete(issueId)
    }
    this.blocked.clear()

    this.status = 'stopped'
    this.recordEvent('service_stopped', 'all workers canceled')
    return this.snapshot()
  }

  async refresh(): Promise<RuntimeSnapshot> {
    if (this.status !== 'running') {
      throw new SymphonyError('service_not_running', 'Symphony service is not running')
    }

    await this.tick()
    return this.snapshot()
  }

  snapshot(): RuntimeSnapshot {
    const running = Array.from(this.running.values()).map((entry) => this.runningRow(entry))
    const retrying = Array.from(this.retryAttempts.values()).map((entry) => this.retryRow(entry))
    const blocked = Array.from(this.blocked.values()).map((entry) => this.blockedRow(entry))

    return {
      generated_at: nowIso(),
      service_status: this.status,
      workflow_path: this.workflowPath,
      counts: {
        running: running.length,
        retrying: retrying.length,
        blocked: blocked.length,
        claimed: this.claimed.size,
        completed: this.completed.size,
      },
      running,
      retrying,
      blocked,
      codex_totals: {
        ...this.codexTotals,
        seconds_running: this.totalRuntimeSeconds(),
      },
      rate_limits: this.codexRateLimits,
      polling: this.pollingSnapshot(),
      recent_events: [...this.recentEvents],
      config_errors: [...this.configErrors],
      last_error: this.lastError,
      config: {
        poll_interval_ms: this.config?.polling.interval_ms ?? null,
        max_concurrent_agents: this.config?.agent.max_concurrent_agents ?? null,
        workspace_root: this.config?.workspace.root ?? null,
        worker_ssh_hosts: this.config?.worker.ssh_hosts ?? [],
        worker_max_concurrent_agents_per_host: this.config?.worker.max_concurrent_agents_per_host ?? null,
        active_states: this.config?.tracker.active_states ?? [],
        terminal_states: this.config?.tracker.terminal_states ?? [],
        runner: this.config?.agent.runner ?? 'simulated',
        tracker: this.config
          ? trackerModeForConfig(this.config)
          : 'linear',
        tracker_project_slug: this.config?.tracker.project_slug ?? null,
        tracker_repository: this.config?.tracker.repository ?? null,
        server_port: this.config?.server.port ?? null,
        server_host: this.config?.server.host ?? null,
        observability_dashboard_enabled: this.config?.observability.dashboard_enabled ?? null,
        observability_refresh_ms: this.config?.observability.refresh_ms ?? null,
        observability_render_interval_ms: this.config?.observability.render_interval_ms ?? null,
        logging_path: this.config ? structuredLogPath(this.config) : null,
      },
    }
  }

  issueDetail(identifier: string): IssueDetailSnapshot | null {
    const runningEntry = Array.from(this.running.values()).find(
      (entry) => entry.issue.identifier === identifier,
    )
    const retryEntry = Array.from(this.retryAttempts.values()).find(
      (entry) => entry.identifier === identifier,
    )
    const blockedEntry = Array.from(this.blocked.values()).find(
      (entry) => entry.issue.identifier === identifier,
    )
    const completedIssue = Array.from(this.completed.values()).find(
      (issue) => issue.identifier === identifier,
    )

    const issue = runningEntry?.issue ?? retryEntry?.issue ?? blockedEntry?.issue ?? completedIssue
    const retryIssueId = retryEntry?.issue_id
    const issueId = issue?.id ?? retryIssueId
    if (!issueId) {
      return null
    }

    return {
      issue_identifier: identifier,
      issue_id: issueId,
      issue: issueSnapshot(issue),
      status: runningEntry
        ? 'running'
        : retryEntry
          ? 'retrying'
          : blockedEntry
            ? 'blocked'
            : completedIssue
              ? 'completed'
              : this.claimed.has(issueId)
                ? 'claimed'
                : 'unknown',
      workspace: {
        path:
          runningEntry?.workspace_path
          ?? retryEntry?.workspace_path
          ?? blockedEntry?.workspace_path
          ?? this.expectedWorkspacePath(identifier),
        host: runningEntry?.worker_host ?? retryEntry?.worker_host ?? blockedEntry?.worker_host ?? null,
      },
      attempts: {
        restart_count: retryRestartCount(retryEntry?.attempt),
        current_retry_attempt: retryEntry?.attempt ?? 0,
      },
      running: runningEntry ? this.runningRow(runningEntry) : null,
      retry: retryEntry ? this.retryRow(retryEntry) : null,
      blocked: blockedEntry ? this.blockedRow(blockedEntry) : null,
      logs: {
        codex_session_logs: readIssueSessionLogs(this.config, identifier),
      },
      recent_events: this.recentEvents.filter((event) => event.issue_identifier === identifier),
      last_error: blockedEntry?.reason ?? retryEntry?.error ?? null,
      tracked: {
        claimed: this.claimed.has(issueId),
      },
    }
  }

  private async reloadWorkflow({ startup }: { startup: boolean }): Promise<void> {
    if (!this.workflowPath) {
      throw new SymphonyError('missing_workflow_file', 'No workflow path configured')
    }

    try {
      const previousPollInterval = this.config?.polling.interval_ms ?? null
      const workflow = await loadWorkflow(this.workflowPath)
      const result = resolveWorkflowConfig(workflow, process.env, this.configOverrides)

      if (!result.ok) {
        this.configErrors = result.errors
        if (startup || !this.config) {
          throw new SymphonyError(result.errors[0]?.code ?? 'invalid_config', result.errors[0]?.message ?? 'Invalid workflow config')
        }
        this.recordEvent('workflow_reload_failed', result.errors[0]?.message ?? 'invalid config')
        return
      }

      this.workflow = workflow
      this.config = result.config
      this.ensureTrackerForConfig(result.config, startup)
      this.configErrors = []
      this.recordEvent(startup ? 'workflow_loaded' : 'workflow_reloaded', workflow.path)
      if (
        !startup &&
        this.status === 'running' &&
        previousPollInterval !== null &&
        previousPollInterval !== result.config.polling.interval_ms
      ) {
        this.scheduleTick(result.config.polling.interval_ms)
        this.recordEvent('polling_rescheduled', `interval_ms=${result.config.polling.interval_ms}`)
      }
    } catch (error) {
      const payload = toErrorPayload(error)
      this.configErrors = [payload]
      if (startup || !this.config) {
        throw error
      }
      this.recordEvent('workflow_reload_failed', payload.message)
    }
  }

  private ensureTrackerForConfig(config: EffectiveConfig, startup: boolean): void {
    const nextMode = trackerModeForConfig(config)
    const nextSignature = trackerConfigSignatureForConfig(config)
    if (this.tracker && this.trackerMode === nextMode && this.trackerConfigSignature === nextSignature) {
      return
    }

    this.tracker = this.trackerFactory(config)
    this.trackerMode = nextMode
    this.trackerConfigSignature = nextSignature
    if (!startup) {
      this.recordEvent('tracker_reconfigured', nextMode)
    }
  }

  private async startupTerminalWorkspaceCleanup(): Promise<void> {
    if (!this.config || !this.tracker) {
      return
    }

    try {
      const terminalIssues = await this.tracker.fetchIssuesByStates(
        this.config.tracker.terminal_states,
        this.config,
      )
      await Promise.all(
        terminalIssues.map(async (issue) => {
          const hookError = await removeWorkspaceForIssue(issue.identifier, this.config!)
          this.recordHookFailure('before_remove', hookError, issue.identifier)
        }),
      )
      this.recordEvent('startup_cleanup_completed', `${terminalIssues.length} terminal workspaces checked`)
    } catch (error) {
      this.lastError = toErrorPayload(error)
      this.recordEvent('startup_cleanup_failed', this.lastError.message)
    }
  }

  private watchWorkflow(): void {
    if (!this.workflowPath) {
      return
    }

    this.watcher?.close()
    this.watcher = watch(this.workflowPath, { persistent: false }, () => {
      void this.reloadWorkflow({ startup: false })
    })
  }

  private scheduleTick(delayMs: number): void {
    this.clearTicker()
    if (this.status !== 'running') {
      this.nextPollDueAtMs = null
      return
    }

    this.nextPollDueAtMs = Date.now() + Math.max(0, delayMs)
    this.ticker = setTimeout(() => {
      this.ticker = null
      this.nextPollDueAtMs = null
      void this.tick()
    }, delayMs)
  }

  private clearTicker(): void {
    if (this.ticker) {
      clearTimeout(this.ticker)
      this.ticker = null
    }
    this.nextPollDueAtMs = null
  }

  private resetRuntimeState(): void {
    this.clearTicker()
    for (const retry of this.retryAttempts.values()) {
      clearTimeout(retry.timer_handle)
    }
    for (const entry of this.running.values()) {
      entry.worker_abort.abort()
    }

    this.running.clear()
    this.claimed.clear()
    this.retryAttempts.clear()
    this.blocked.clear()
    this.completed.clear()
    this.restartCounts.clear()
    this.recentEvents.splice(0)
    this.codexTotals.input_tokens = 0
    this.codexTotals.output_tokens = 0
    this.codexTotals.total_tokens = 0
    this.codexTotals.seconds_running = 0
    this.codexRateLimits = null
    this.lastError = null
    this.configErrors = []
    this.tracker = null
    this.trackerMode = null
    this.trackerConfigSignature = null
  }

  private async tick(): Promise<void> {
    if (this.pollInFlight || this.status !== 'running') {
      return
    }

    this.pollInFlight = true
    try {
      await this.reloadWorkflow({ startup: false })
      await this.reconcileRunningIssues()

      if (!this.config || !this.tracker || this.configErrors.length > 0) {
        return
      }

      const candidates = await this.tracker.fetchCandidateIssues(this.config)
      for (const issue of sortForDispatch(candidates)) {
        if (this.availableSlots() <= 0) {
          break
        }

        if (this.shouldDispatch(issue)) {
          const workerHost = this.selectWorkerHost(null)
          if (workerHost === noWorkerCapacity) {
            break
          }

          this.dispatchIssue(issue, null, workerHost)
        }
      }

      this.recordEvent('poll_completed', `${candidates.length} candidates checked`)
    } catch (error) {
      this.lastError = toErrorPayload(error)
      this.recordEvent('poll_failed', this.lastError.message)
    } finally {
      this.pollInFlight = false
      this.scheduleTick(this.config?.polling.interval_ms ?? 30_000)
    }
  }

  private async reconcileRunningIssues(): Promise<void> {
    if (!this.config || !this.tracker || (this.running.size === 0 && this.blocked.size === 0)) {
      return
    }

    this.reconcileStalledRuns()
    const runningIds = Array.from(this.running.keys())
    if (runningIds.length === 0) {
      await this.reconcileBlockedIssues()
      return
    }

    let refreshed: Array<Issue>
    try {
      refreshed = await this.tracker.fetchIssueStatesByIds(runningIds, this.config)
    } catch (error) {
      this.lastError = toErrorPayload(error)
      this.recordEvent('reconciliation_refresh_failed', this.lastError.message)
      return
    }

    const refreshedById = new Map(refreshed.map((issue) => [issue.id, issue]))
    for (const issueId of runningIds) {
      const entry = this.running.get(issueId)
      if (!entry) {
        continue
      }

      const issue = refreshedById.get(issueId)
      if (!issue) {
        await this.terminateRunningIssue(issueId, false, 'issue missing')
        continue
      }

      if (stateInList(issue.state, this.config.tracker.terminal_states)) {
        await this.terminateRunningIssue(issue.id, true, 'terminal state')
        continue
      }

      if (!issueEligibleForRun(issue, this.config)) {
        await this.terminateRunningIssue(issue.id, false, issueIneligibilityReason(issue, this.config))
        continue
      }

      entry.issue = issue
    }

    await this.reconcileBlockedIssues()
  }

  private async reconcileBlockedIssues(): Promise<void> {
    if (!this.config || !this.tracker || this.blocked.size === 0) {
      return
    }

    let refreshed: Array<Issue>
    try {
      refreshed = await this.tracker.fetchIssueStatesByIds(Array.from(this.blocked.keys()), this.config)
    } catch (error) {
      this.lastError = toErrorPayload(error)
      this.recordEvent('blocked_refresh_failed', this.lastError.message)
      return
    }

    const refreshedById = new Map(refreshed.map((issue) => [issue.id, issue]))
    for (const issueId of Array.from(this.blocked.keys())) {
      const entry = this.blocked.get(issueId)
      if (!entry) {
        continue
      }

      const issue = refreshedById.get(issueId)
      if (!issue) {
        this.blocked.delete(issueId)
        this.claimed.delete(issueId)
        this.recordEvent('blocked_released', 'issue missing', entry.issue.identifier)
        continue
      }

      if (stateInList(issue.state, this.config.tracker.terminal_states)) {
        const hookError = await removeWorkspaceForIssue(issue.identifier, this.config, entry.worker_host)
        this.recordHookFailure('before_remove', hookError, issue.identifier)
        this.blocked.delete(issue.id)
        this.claimed.delete(issue.id)
        this.recordEvent('blocked_released', 'terminal state', issue.identifier)
      } else if (!issueEligibleForRun(issue, this.config)) {
        this.blocked.delete(issue.id)
        this.claimed.delete(issue.id)
        this.recordEvent('blocked_released', issueIneligibilityReason(issue, this.config), issue.identifier)
      } else {
        entry.issue = issue
      }
    }
  }

  private reconcileStalledRuns(): void {
    if (!this.config || this.config.codex.stall_timeout_ms <= 0) {
      return
    }

    for (const [issueId, entry] of this.running.entries()) {
      const start = Date.parse(entry.last_codex_timestamp ?? entry.started_at)
      if (Number.isNaN(start)) {
        continue
      }

      if (Date.now() - start > this.config.codex.stall_timeout_ms) {
        entry.status = 'Stalled'
        entry.worker_abort.abort()
        this.recordEvent('stall_detected', entry.issue.identifier, entry.issue.identifier)
        this.scheduleRetry(entry.issue, nextAttempt(entry.retry_attempt), 'stalled session', {
          lastAttemptStatus: 'Stalled',
          workspacePath: entry.workspace_path,
          workerHost: entry.worker_host,
        })
        this.closeRunningEntry(issueId)
      }
    }
  }

  private async terminateRunningIssue(
    issueId: string,
    cleanupWorkspace: boolean,
    reason: string,
  ): Promise<void> {
    const entry = this.running.get(issueId)
    if (!entry || !this.config) {
      return
    }

    entry.status = 'CanceledByReconciliation'
    entry.worker_abort.abort()
    await entry.workspace_ready.catch(() => null)
    this.closeRunningEntry(issueId)
    this.claimed.delete(issueId)

    if (cleanupWorkspace) {
      const hookError = await removeWorkspaceForIssue(entry.issue.identifier, this.config, entry.worker_host)
      this.recordHookFailure('before_remove', hookError, entry.issue.identifier)
    }

    this.recordEvent('run_terminated', reason, entry.issue.identifier)
  }

  private dispatchIssue(issue: Issue, attempt: number | null, workerHost: string | null): void {
    if (!this.config || !this.workflow || !this.tracker) {
      return
    }

    const abortController = new AbortController()
    let resolveWorkspaceReady: (workspacePath: string | null) => void = () => {}
    const workspaceReady = new Promise<string | null>((resolve) => {
      resolveWorkspaceReady = resolve
    })
    const entry: RunningEntry = {
      issue,
      worker_abort: abortController,
      workspace_ready: workspaceReady,
      resolve_workspace_ready: resolveWorkspaceReady,
      workspace_ready_settled: false,
      workspace_path: null,
      worker_host: workerHost,
      continuation_retry_allowed: true,
      status: 'PreparingWorkspace',
      session_id: null,
      thread_id: null,
      turn_id: null,
      codex_app_server_pid: null,
      last_codex_event: null,
      last_codex_timestamp: null,
      last_codex_message: null,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      turn_count: 0,
      retry_attempt: attempt,
      started_at: nowIso(),
    }

    this.claimed.add(issue.id)
    this.retryAttempts.delete(issue.id)
    this.blocked.delete(issue.id)
    this.completed.delete(issue.id)
    this.running.set(issue.id, entry)
    this.recordEvent(
      'dispatch_started',
      `attempt=${attempt ?? 'first'} worker_host=${workerHost ?? 'local'}`,
      issue.identifier,
    )

    void this.runWorker(issue, attempt, abortController.signal, workerHost)
      .then(() => this.onWorkerExit(issue.id, 'normal'))
      .catch((error) => this.onWorkerExit(issue.id, error))
  }

  private async runWorker(
    issue: Issue,
    attempt: number | null,
    signal: AbortSignal,
    workerHost: string | null,
  ): Promise<void> {
    const runConfig = this.config
    const runWorkflow = this.workflow
    const runTracker = this.tracker
    if (!runConfig || !runWorkflow || !runTracker) {
      throw new SymphonyError('invalid_config', 'Cannot run worker without loaded config')
    }

    const entry = this.running.get(issue.id)
    if (!entry) {
      return
    }

    let currentIssue = issue
    let workspacePath: string | null = null
    let session: Awaited<ReturnType<typeof openAgentSession>> | null = null
    let cleanupWorkspaceAfterRun = false

    try {
      entry.status = 'PreparingWorkspace'
      const workspace = await createWorkspaceForIssue(currentIssue.identifier, runConfig, workerHost)
      workspacePath = workspace.path
      entry.workspace_path = workspace.path
      resolveWorkspaceReady(entry, workspace.path)

      if (signal.aborted || !this.running.has(currentIssue.id)) {
        return
      }

      if (runConfig.hooks.before_run) {
        await runHook(
          runConfig.hooks.before_run,
          workspace.path,
          runConfig.hooks.timeout_ms,
          'before_run',
          workerHost,
        )
      }

      entry.status = 'BuildingPrompt'
      let prompt = await renderIssuePrompt(runWorkflow, currentIssue, attempt)

      if (signal.aborted || !this.running.has(currentIssue.id)) {
        return
      }

      entry.status = 'InitializingSession'
      session = await openAgentSession(this.runner, {
        issue: currentIssue,
        workspace,
        worker_host: workerHost,
        attempt,
        config: runConfig,
        tracker: runTracker,
        signal,
        emit: (event) => this.handleAgentEvent(currentIssue.id, event),
      })

      for (let turnNumber = 1; turnNumber <= runConfig.agent.max_turns; turnNumber += 1) {
        if (turnNumber > 1) {
          entry.status = 'BuildingPrompt'
          prompt = renderContinuationPrompt(currentIssue, attempt, turnNumber)
        }

        entry.status = 'LaunchingAgentProcess'
        await session.run({
          issue: currentIssue,
          workspace,
          worker_host: workerHost,
          prompt,
          turn_number: turnNumber,
          continuation: turnNumber > 1,
          attempt,
          config: runConfig,
          tracker: runTracker,
          signal,
          emit: (event) => this.handleAgentEvent(currentIssue.id, event),
        })

        if (signal.aborted || !this.running.has(currentIssue.id)) {
          return
        }

        entry.turn_count = Math.max(entry.turn_count, turnNumber)
        const [refreshed] = await runTracker.fetchIssueStatesByIds([currentIssue.id], runConfig)
        if (!refreshed) {
          entry.continuation_retry_allowed = false
          this.recordEvent('continuation_stopped', 'issue missing', currentIssue.identifier)
          break
        }

        currentIssue = refreshed
        entry.issue = currentIssue

        if (stateInList(currentIssue.state, runConfig.tracker.terminal_states)) {
          cleanupWorkspaceAfterRun = true
          this.recordEvent('terminal_cleanup_scheduled', currentIssue.state, currentIssue.identifier)
          break
        }

        if (!issueEligibleForRun(currentIssue, runConfig)) {
          this.recordEvent('continuation_stopped', 'issue no longer eligible', currentIssue.identifier)
          break
        }
      }

      entry.status = 'Finishing'
    } finally {
      resolveWorkspaceReady(entry, workspacePath)
      await session?.close()
      if (workspacePath) {
        const afterRunError = await runHookBestEffort(
          runConfig.hooks.after_run,
          workspacePath,
          runConfig.hooks.timeout_ms,
          'after_run',
          workerHost,
        )
        this.recordHookFailure('after_run', afterRunError, currentIssue.identifier)
        if (cleanupWorkspaceAfterRun) {
          const beforeRemoveError = await removeWorkspaceForIssue(currentIssue.identifier, runConfig, workerHost)
          this.recordHookFailure('before_remove', beforeRemoveError, currentIssue.identifier)
          this.recordEvent('workspace_removed', 'terminal state after run', currentIssue.identifier)
        }
      }
    }
  }

  private handleAgentEvent(issueId: string, event: AgentRuntimeEvent): void {
    const entry = this.running.get(issueId)
    if (!entry) {
      return
    }

    const blocked = isBlockingAgentEvent(event.event)
    const previousTurnId = entry.turn_id
    entry.status = blocked ? 'Blocked' : event.event === 'turn_completed' ? 'Succeeded' : 'StreamingTurn'
    entry.session_id = event.session_id ?? entry.session_id
    entry.thread_id = event.thread_id ?? entry.thread_id
    entry.turn_id = event.turn_id ?? entry.turn_id
    entry.codex_app_server_pid = event.codex_app_server_pid ?? entry.codex_app_server_pid
    entry.last_codex_event = event.event
    entry.last_codex_timestamp = event.timestamp
    entry.last_codex_message = event.message ?? null
    if (event.event === 'turn_started' && (!event.turn_id || event.turn_id !== previousTurnId)) {
      entry.turn_count += 1
    }

    if (event.rate_limits !== undefined) {
      this.codexRateLimits = event.rate_limits
    }

    if (event.usage) {
      this.applyTokenUsage(entry, event.usage)
    }

    this.recordEvent(
      event.event,
      summarizeCodexRuntimeMessage(event.event, event.message ?? null),
      entry.issue.identifier,
    )

    if (blocked) {
      this.blockRunningIssue(issueId, event)
    }
  }

  private blockRunningIssue(issueId: string, event: AgentRuntimeEvent): void {
    const entry = this.running.get(issueId)
    if (!entry) {
      return
    }

    const reason = event.message ?? event.event
    this.blocked.set(issueId, {
      issue: entry.issue,
      reason,
      blocked_at: event.timestamp,
      workspace_path: entry.workspace_path,
      worker_host: entry.worker_host,
      session_id: entry.session_id,
      thread_id: entry.thread_id,
      turn_id: entry.turn_id,
      codex_app_server_pid: entry.codex_app_server_pid,
      last_event: entry.last_codex_event,
      last_message: entry.last_codex_message,
      last_event_at: entry.last_codex_timestamp,
    })
    entry.worker_abort.abort()
    this.closeRunningEntry(issueId)
    this.claimed.add(issueId)
    this.recordEvent('run_blocked', reason, entry.issue.identifier)
  }

  private applyTokenUsage(entry: RunningEntry, usage: Partial<TokenTotals>): void {
    const input = Math.round(Number(usage.input_tokens ?? entry.codex_input_tokens))
    const output = Math.round(Number(usage.output_tokens ?? entry.codex_output_tokens))
    const total = Math.round(Number(usage.total_tokens ?? input + output))

    if (Number.isFinite(input)) {
      this.codexTotals.input_tokens += Math.max(input - entry.last_reported_input_tokens, 0)
      entry.codex_input_tokens = input
      entry.last_reported_input_tokens = input
    }

    if (Number.isFinite(output)) {
      this.codexTotals.output_tokens += Math.max(output - entry.last_reported_output_tokens, 0)
      entry.codex_output_tokens = output
      entry.last_reported_output_tokens = output
    }

    if (Number.isFinite(total)) {
      this.codexTotals.total_tokens += Math.max(total - entry.last_reported_total_tokens, 0)
      entry.codex_total_tokens = total
      entry.last_reported_total_tokens = total
    }
  }

  private onWorkerExit(issueId: string, reason: 'normal' | unknown): void {
    const entry = this.running.get(issueId)
    if (!entry) {
      return
    }

    this.closeRunningEntry(issueId)

    if (reason === 'normal') {
      entry.status = 'Succeeded'
      const stillEligible =
        entry.continuation_retry_allowed &&
        this.config &&
        issueEligibleForRun(entry.issue, this.config)

      if (stillEligible) {
        this.scheduleRetry(entry.issue, 1, null, {
          continuation: true,
          lastAttemptStatus: 'Succeeded',
          workspacePath: entry.workspace_path,
          workerHost: entry.worker_host,
        })
        this.recordEvent('worker_completed', 'continuation retry scheduled', entry.issue.identifier)
      } else {
        this.completed.set(issueId, entry.issue)
        this.claimed.delete(issueId)
        this.recordEvent('worker_completed', `issue state=${entry.issue.state}; claim released`, entry.issue.identifier)
      }
      return
    }

    const payload = workerFailurePayload(reason)
    this.lastError = payload
    const attempt = nextAttempt(entry.retry_attempt)
    const lastAttemptStatus = terminalStatusForError(reason)
    entry.status = lastAttemptStatus
    this.restartCounts.set(issueId, (this.restartCounts.get(issueId) ?? 0) + 1)

    if (this.status === 'running') {
      this.scheduleRetry(entry.issue, attempt, payload.message, {
        lastAttemptStatus,
        workspacePath: entry.workspace_path,
        workerHost: entry.worker_host,
      })
    } else {
      this.claimed.delete(issueId)
    }

    this.recordEvent('worker_failed', payload.message, entry.issue.identifier)
  }

  private scheduleRetry(
    issue: Issue,
    attempt: number,
    error: string | null,
    options: {
      continuation?: boolean
      lastAttemptStatus?: RunAttemptStatus
      workspacePath?: string | null
      workerHost?: string | null
    } = {},
  ): void {
    if (!this.config || this.status !== 'running') {
      this.claimed.delete(issue.id)
      return
    }

    const existing = this.retryAttempts.get(issue.id)
    if (existing) {
      clearTimeout(existing.timer_handle)
    }

    const delayMs = options.continuation
      ? 1000
      : Math.min(10_000 * 2 ** Math.max(attempt - 1, 0), this.config.agent.max_retry_backoff_ms)
    const dueAtMs = Date.now() + delayMs
    const timer = setTimeout(() => {
      void this.handleRetry(issue.id)
    }, delayMs)

    this.claimed.add(issue.id)
    this.retryAttempts.set(issue.id, {
      issue: issueSnapshot(issue) ?? issue,
      issue_id: issue.id,
      identifier: issue.identifier,
      issue_url: issue.url,
      attempt,
      due_at_ms: dueAtMs,
      timer_handle: timer,
      last_attempt_status: options.lastAttemptStatus ?? 'Failed',
      error,
      workspace_path: options.workspacePath ?? existing?.workspace_path ?? null,
      worker_host: options.workerHost ?? null,
    })
  }

  private async handleRetry(issueId: string): Promise<void> {
    const retry = this.retryAttempts.get(issueId)
    if (!retry || !this.config || !this.tracker || this.status !== 'running') {
      return
    }

    await this.reloadWorkflow({ startup: false })
    if (this.configErrors.length > 0) {
      await delay(25)
      await this.reloadWorkflow({ startup: false })
    }
    if (!this.config || !this.tracker || this.configErrors.length > 0) {
      this.scheduleRetry(retry.issue, retry.attempt + 1, this.configErrors[0]?.message ?? 'workflow reload failed', {
        lastAttemptStatus: retry.last_attempt_status,
        workspacePath: retry.workspace_path,
        workerHost: retry.worker_host,
      })
      return
    }

    this.retryAttempts.delete(issueId)

    let candidates: Array<Issue>
    try {
      candidates = await this.tracker.fetchCandidateIssues(this.config)
    } catch (error) {
      this.lastError = toErrorPayload(error)
      const next = retry.attempt + 1
      this.scheduleRetry(retry.issue, next, 'retry poll failed', {
        lastAttemptStatus: retry.last_attempt_status,
        workspacePath: retry.workspace_path,
        workerHost: retry.worker_host,
      })
      return
    }

    const issue = candidates.find((candidate) => candidate.id === issueId)
    if (!issue) {
      this.claimed.delete(issueId)
      this.recordEvent('retry_released', 'issue no longer active', retry.identifier)
      return
    }

    if (this.availableSlots() <= 0) {
      this.scheduleRetry(issue, retry.attempt + 1, 'no available orchestrator slots', {
        lastAttemptStatus: retry.last_attempt_status,
        workspacePath: retry.workspace_path,
        workerHost: retry.worker_host,
      })
      return
    }

    if (!this.stateSlotAvailable(issue.state)) {
      this.scheduleRetry(issue, retry.attempt + 1, 'no available orchestrator slots', {
        lastAttemptStatus: retry.last_attempt_status,
        workspacePath: retry.workspace_path,
        workerHost: retry.worker_host,
      })
      return
    }

    const workerHost = this.selectWorkerHost(retry.worker_host)
    if (workerHost === noWorkerCapacity) {
      this.scheduleRetry(issue, retry.attempt + 1, 'no available orchestrator slots', {
        lastAttemptStatus: retry.last_attempt_status,
        workspacePath: retry.workspace_path,
        workerHost: retry.worker_host,
      })
      return
    }

    if (!this.shouldDispatch(issue, { ignoreClaimed: true })) {
      this.claimed.delete(issueId)
      this.recordEvent('retry_released', 'issue no longer eligible', issue.identifier)
      return
    }

    this.dispatchIssue(issue, retry.attempt, workerHost)
  }

  private shouldDispatch(issue: Issue, options?: { ignoreClaimed?: boolean }): boolean {
    if (!this.config) {
      return false
    }

    if (!issueEligibleForRun(issue, this.config)) {
      return false
    }

    if (this.running.has(issue.id)) {
      return false
    }

    if (!options?.ignoreClaimed && this.claimed.has(issue.id)) {
      return false
    }

    return this.availableSlots() > 0 && this.stateSlotAvailable(issue.state)
  }

  private availableSlots(): number {
    if (!this.config) {
      return 0
    }

    return Math.max(this.config.agent.max_concurrent_agents - this.running.size, 0)
  }

  private stateSlotAvailable(state: string): boolean {
    if (!this.config) {
      return false
    }

    const normalized = normalizeStateName(state)
    const limit =
      this.config.agent.max_concurrent_agents_by_state[normalized] ??
      this.config.agent.max_concurrent_agents
    const runningInState = Array.from(this.running.values()).filter(
      (entry) => normalizeStateName(entry.issue.state) === normalized,
    ).length

    return runningInState < limit
  }

  private selectWorkerHost(preferredWorkerHost: string | null): WorkerHostSelection {
    if (!this.config || this.config.worker.ssh_hosts.length === 0) {
      return null
    }

    const availableHosts = this.config.worker.ssh_hosts.filter((host) => this.workerHostSlotAvailable(host))
    if (availableHosts.length === 0) {
      return noWorkerCapacity
    }

    if (preferredWorkerHost && availableHosts.includes(preferredWorkerHost)) {
      return preferredWorkerHost
    }

    return availableHosts
      .map((host, index) => ({
        host,
        index,
        running: this.runningWorkerHostCount(host),
      }))
      .sort((a, b) => a.running - b.running || a.index - b.index)[0].host
  }

  private workerHostSlotAvailable(workerHost: string): boolean {
    const limit = this.config?.worker.max_concurrent_agents_per_host
    if (!limit) {
      return true
    }

    return this.runningWorkerHostCount(workerHost) < limit
  }

  private runningWorkerHostCount(workerHost: string): number {
    return Array.from(this.running.values()).filter((entry) => entry.worker_host === workerHost).length
  }

  private runningRow(entry: RunningEntry): RunningSnapshotRow {
    return {
      issue_id: entry.issue.id,
      issue_identifier: entry.issue.identifier,
      issue_url: entry.issue.url,
      state: entry.issue.state,
      session_id: entry.session_id,
      thread_id: entry.thread_id,
      turn_id: entry.turn_id,
      codex_app_server_pid: entry.codex_app_server_pid,
      turn_count: entry.turn_count,
      last_event: entry.last_codex_event,
      last_message: entry.last_codex_message,
      started_at: entry.started_at,
      last_event_at: entry.last_codex_timestamp,
      workspace_path: entry.workspace_path,
      worker_host: entry.worker_host,
      status: entry.status,
      tokens: {
        input_tokens: entry.codex_input_tokens,
        output_tokens: entry.codex_output_tokens,
        total_tokens: entry.codex_total_tokens,
      },
    }
  }

  private retryRow(entry: RetryEntry): RetrySnapshotRow {
    return {
      issue_id: entry.issue_id,
      issue_identifier: entry.identifier,
      issue_url: entry.issue_url,
      attempt: entry.attempt,
      due_at: new Date(entry.due_at_ms).toISOString(),
      last_attempt_status: entry.last_attempt_status,
      error: entry.error,
      workspace_path: entry.workspace_path,
      worker_host: entry.worker_host,
    }
  }

  private blockedRow(entry: BlockedEntry): BlockedSnapshotRow {
    return {
      issue_id: entry.issue.id,
      issue_identifier: entry.issue.identifier,
      issue_url: entry.issue.url,
      state: entry.issue.state,
      reason: entry.reason,
      error: entry.reason,
      blocked_at: entry.blocked_at,
      workspace_path: entry.workspace_path,
      worker_host: entry.worker_host,
      session_id: entry.session_id,
      thread_id: entry.thread_id,
      turn_id: entry.turn_id,
      codex_app_server_pid: entry.codex_app_server_pid,
      last_event: entry.last_event,
      last_message: entry.last_message,
      last_event_at: entry.last_event_at,
    }
  }

  private totalRuntimeSeconds(): number {
    return (
      this.codexTotals.seconds_running +
      Array.from(this.running.values()).reduce(
        (total, entry) => total + secondsBetween(entry.started_at),
        0,
      )
    )
  }

  private pollingSnapshot(): RuntimeSnapshot['polling'] {
    return {
      'checking?': this.pollInFlight,
      next_poll_in_ms: this.pollInFlight ? null : nextPollInMs(this.nextPollDueAtMs),
      poll_interval_ms: this.config?.polling.interval_ms ?? null,
    }
  }

  private expectedWorkspacePath(issueIdentifier: string): string | null {
    if (!this.config) {
      return null
    }

    try {
      return workspacePathForIssue(issueIdentifier, this.config)
    } catch {
      return null
    }
  }

  private closeRunningEntry(issueId: string): RunningEntry | null {
    const entry = this.running.get(issueId)
    if (!entry) {
      return null
    }

    this.running.delete(issueId)
    this.codexTotals.seconds_running += secondsBetween(entry.started_at)
    return entry
  }

  private recordEvent(event: string, message: string, issueIdentifier?: string, context: EventContext = {}): void {
    const at = nowIso()
    const eventContext = this.resolveEventContext(issueIdentifier, context)
    this.recentEvents.unshift({
      at,
      event,
      message,
      ...eventContext,
    })

    this.recentEvents.splice(40)

    try {
      writeStructuredLog(this.config, {
        at,
        event,
        message,
        ...eventContext,
        workflow_path: this.workflowPath,
        service_status: this.status,
      })
    } catch (error) {
      this.lastError = toErrorPayload(error)
      this.recentEvents.unshift({
        at: nowIso(),
        event: 'structured_log_failed',
        message: this.lastError.message,
        ...eventContext,
      })
      this.recentEvents.splice(40)
    } finally {
      broadcastObservabilityUpdate()
    }
  }

  private resolveEventContext(issueIdentifier: string | undefined, context: EventContext): ResolvedEventContext {
    const explicitIdentifier = context.issue_identifier ?? context.issue?.identifier ?? issueIdentifier
    const explicitIssueId = context.issue_id ?? context.issue?.id
    const matched = this.findEventContextEntry(explicitIdentifier, explicitIssueId)

    return omitUndefined({
      issue_id: explicitIssueId ?? matched.issue_id,
      issue_identifier: explicitIdentifier ?? matched.issue_identifier,
      session_id: context.session_id ?? matched.session_id,
      thread_id: context.thread_id ?? matched.thread_id,
      turn_id: context.turn_id ?? matched.turn_id,
      codex_app_server_pid: context.codex_app_server_pid ?? matched.codex_app_server_pid,
    })
  }

  private findEventContextEntry(
    issueIdentifier: string | null | undefined,
    issueId: string | null | undefined,
  ): EventContext {
    const running = Array.from(this.running.values()).find(
      (entry) => entry.issue.id === issueId || entry.issue.identifier === issueIdentifier,
    )
    if (running) {
      return {
        issue_id: running.issue.id,
        issue_identifier: running.issue.identifier,
        session_id: running.session_id,
        thread_id: running.thread_id,
        turn_id: running.turn_id,
        codex_app_server_pid: running.codex_app_server_pid,
      }
    }

    const blocked = Array.from(this.blocked.values()).find(
      (entry) => entry.issue.id === issueId || entry.issue.identifier === issueIdentifier,
    )
    if (blocked) {
      return {
        issue_id: blocked.issue.id,
        issue_identifier: blocked.issue.identifier,
        session_id: blocked.session_id,
        thread_id: blocked.thread_id,
        turn_id: blocked.turn_id,
        codex_app_server_pid: blocked.codex_app_server_pid,
      }
    }

    const retry = Array.from(this.retryAttempts.values()).find(
      (entry) => entry.issue_id === issueId || entry.identifier === issueIdentifier,
    )
    if (retry) {
      return {
        issue_id: retry.issue_id,
        issue_identifier: retry.identifier,
      }
    }

    const completed = Array.from(this.completed.values()).find(
      (issue) => issue.id === issueId || issue.identifier === issueIdentifier,
    )
    if (completed) {
      return {
        issue_id: completed.id,
        issue_identifier: completed.identifier,
      }
    }

    return {}
  }

  private recordHookFailure(
    hookName: 'after_run' | 'before_remove',
    error: SymphonyError | null,
    issueIdentifier?: string,
  ): void {
    if (!error) {
      return
    }

    const payload = toErrorPayload(error)
    this.lastError = payload
    this.recordEvent(`${hookName}_hook_failed`, payload.message, issueIdentifier)
  }
}

function issueSnapshot(issue: Issue | null | undefined): Issue | null {
  if (!issue) {
    return null
  }

  return {
    ...issue,
    labels: [...issue.labels],
    blocked_by: issue.blocked_by.map((blocker) => ({ ...blocker })),
  }
}

function resolveWorkspaceReady(entry: RunningEntry, workspacePath: string | null): void {
  if (entry.workspace_ready_settled) {
    return
  }

  entry.workspace_ready_settled = true
  entry.resolve_workspace_ready(workspacePath)
}

function omitUndefined(context: EventContext): ResolvedEventContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined && value !== null),
  ) as ResolvedEventContext
}

function terminalStatusForError(error: unknown): Extract<RunAttemptStatus, 'Failed' | 'TimedOut'> {
  const message = error instanceof Error ? error.message : String(error)
  return /\b(time(?:d)?\s*out|timeout)\b/i.test(message) ? 'TimedOut' : 'Failed'
}

function workerFailurePayload(error: unknown): SymphonyErrorPayload {
  if (error instanceof SymphonyError) {
    return error.toPayload()
  }

  return {
    code: 'agent_error',
    message: error instanceof Error ? error.message : String(error),
  }
}

function isBlockingAgentEvent(event: string): boolean {
  const normalized = event.trim().toLowerCase()
  return (
    normalized === 'turn_input_required' ||
    normalized === 'turn/input_required' ||
    normalized === 'turn/needs_input' ||
    normalized === 'turn/approval_required' ||
    normalized === 'input_required' ||
    normalized === 'needs_input' ||
    normalized === 'operator_input_required' ||
    normalized === 'approval_required' ||
    normalized === 'mcp_elicitation_required' ||
    normalized === 'elicitation_required'
  )
}

function issueEligibleForRun(issue: Issue, config: EffectiveConfig): boolean {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
    return false
  }

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
    const hasOpenBlocker = issue.blocked_by.some(
      (blocker) => blocker.state && !stateInList(blocker.state, config.tracker.terminal_states),
    )
    if (hasOpenBlocker) {
      return false
    }
  }

  return true
}

function issueIneligibilityReason(issue: Issue, config: EffectiveConfig): string {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
    return 'missing required issue fields'
  }

  if (!stateInList(issue.state, config.tracker.active_states)) {
    return 'non-active state'
  }

  if (stateInList(issue.state, config.tracker.terminal_states)) {
    return 'terminal state'
  }

  if (!issue.assigned_to_worker) {
    return 'assignee changed'
  }

  const labels = normalizeLabels(issue.labels)
  if (!config.tracker.required_labels.every((required) => labels.includes(required))) {
    return 'required labels changed'
  }

  if (normalizeStateName(issue.state) === 'todo') {
    const hasOpenBlocker = issue.blocked_by.some(
      (blocker) => blocker.state && !stateInList(blocker.state, config.tracker.terminal_states),
    )
    if (hasOpenBlocker) {
      return 'blocked by non-terminal issue'
    }
  }

  return 'issue no longer eligible'
}

function defaultTrackerFactory(config: EffectiveConfig): IssueTracker {
  if (config.tracker.kind === 'memory') {
    return new MemoryTracker(config.tracker.memory_issues)
  }

  if (config.tracker.kind === 'github') {
    return new GithubTracker()
  }

  return config.demo.mock_tracker ? new MockLinearTracker() : new LinearTracker()
}

function trackerModeForConfig(config: EffectiveConfig): TrackerMode {
  if (config.tracker.kind === 'memory') {
    return 'memory'
  }

  if (config.tracker.kind === 'github') {
    return 'github'
  }

  return config.demo.mock_tracker ? 'mock-linear' : 'linear'
}

function trackerConfigSignatureForConfig(config: EffectiveConfig): string {
  if (config.tracker.kind === 'memory') {
    return `memory:${JSON.stringify(config.tracker.memory_issues)}`
  }

  if (config.tracker.kind === 'github') {
    return `github:${config.tracker.gh_command}:${config.tracker.repository ?? ''}:${config.tracker.assignee ?? ''}`
  }

  return trackerModeForConfig(config)
}

function nextAttempt(current: number | null): number {
  return current === null ? 1 : current + 1
}

function retryRestartCount(attempt: number | null | undefined): number {
  return Math.max((attempt ?? 0) - 1, 0)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nextPollInMs(nextPollDueAtMs: number | null): number | null {
  return typeof nextPollDueAtMs === 'number' ? Math.max(0, nextPollDueAtMs - Date.now()) : null
}

function sortForDispatch(issues: Array<Issue>): Array<Issue> {
  return [...issues].sort((a, b) => {
    const priorityA = a.priority ?? Number.POSITIVE_INFINITY
    const priorityB = b.priority ?? Number.POSITIVE_INFINITY
    if (priorityA !== priorityB) {
      return priorityA - priorityB
    }

    const createdA = Date.parse(a.created_at ?? '')
    const createdB = Date.parse(b.created_at ?? '')
    const createdCompare =
      (Number.isNaN(createdA) ? Number.POSITIVE_INFINITY : createdA) -
      (Number.isNaN(createdB) ? Number.POSITIVE_INFINITY : createdB)
    if (createdCompare !== 0) {
      return createdCompare
    }

    return a.identifier.localeCompare(b.identifier)
  })
}

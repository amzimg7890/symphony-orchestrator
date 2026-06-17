import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { summarizeCodexNotification } from './codexEventSummary'
import { executeDynamicToolCall, linearGraphqlToolSpec } from './dynamicTool'
import { SymphonyError } from './errors'
import { shellEscape, spawnSsh } from './ssh'
import type { AgentRunInput, AgentRunner, AgentSession, AgentSessionInput } from './runner'
import type { AgentRuntimeEvent, EffectiveConfig, Issue, TokenTotals, Workspace } from './types'

type JsonRpcId = number | string

type JsonRpcMessage = {
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: {
    code?: number
    message?: string
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type TurnCompletion = {
  resolve: () => void
  reject: (error: Error) => void
}

const nonInteractiveToolInputAnswer = 'This is a non-interactive session. Operator input is unavailable.'

export class CodexAppServerRunner implements AgentRunner {
  async startSession(input: AgentSessionInput): Promise<AgentSession> {
    const command = input.config.codex.command.trim()
    if (!command) {
      throw new SymphonyError('missing_codex_command', 'codex.command must not be empty')
    }

    const session = new CodexAppServerSession(input, command)
    await session.start()
    return session
  }

  async run(input: AgentRunInput): Promise<void> {
    const session = await this.startSession(input)
    try {
      await session.run(input)
    } finally {
      await session.close()
    }
  }
}

class CodexAppServerSession implements AgentSession {
  private readonly proc: ChildProcessWithoutNullStreams
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private readonly rl: readline.Interface
  private readonly exitPromise: Promise<never>
  private stderr = ''
  private nextId = 1
  private threadId: string | null = null
  private turnId: string | null = null
  private currentInput: AgentRunInput | null = null
  private currentCompletion: TurnCompletion | null = null
  private approvalPolicyOverride: unknown | null = null
  private blocked = false
  private closed = false

  private readonly abort = () => {
    void maybeInterruptTurn(this.turnId, (message) => this.send(message)).finally(() => {
      void this.close()
    })
  }

  constructor(
    private readonly input: AgentSessionInput,
    command: string,
  ) {
    this.proc = spawnCodexAppServer(command, input.workspace.path, input.worker_host ?? null)
    this.rl = readline.createInterface({ input: this.proc.stdout })
    this.rl.on('line', (line) => this.handleLine(line))
    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-4000)
    })
    this.exitPromise = new Promise<never>((_, reject) => {
      this.proc.once('error', (error) => {
        reject(new SymphonyError('agent_error', `Failed to start Codex app-server: ${error.message}`))
      })
      this.proc.once('exit', (code, signal) => {
        if (this.closed || this.blocked || this.input.signal.aborted) {
          return
        }
        const suffix = this.stderr.trim() ? `: ${this.stderr.trim()}` : ''
        reject(new SymphonyError('agent_error', `Codex app-server exited (${code ?? signal})${suffix}`))
      })
    })
    input.signal.addEventListener('abort', this.abort, { once: true })
  }

  async start(): Promise<void> {
    await Promise.race([
      (async () => {
        await this.request('initialize', {
          clientInfo: {
            name: 'symphony_tanstack',
            title: 'Symphony TanStack',
            version: '0.1.0',
          },
          capabilities: {
            experimentalApi: true,
          },
        })
        this.send({ method: 'initialized', params: {} })

        let thread: unknown
        try {
          thread = await this.request(
            'thread/start',
            buildThreadStartParams(this.input.config, this.input.workspace),
          )
        } catch (error) {
          const fallbackApprovalPolicy = legacyApprovalPolicyFallback(this.input.config.codex.approval_policy)
          if (!fallbackApprovalPolicy || !isUnsupportedRejectApprovalPolicyError(error)) {
            throw error
          }

          this.approvalPolicyOverride = fallbackApprovalPolicy
          thread = await this.request(
            'thread/start',
            buildThreadStartParams(this.input.config, this.input.workspace, {
              approvalPolicyOverride: fallbackApprovalPolicy,
            }),
          )
        }
        this.threadId = extractThreadId(thread) ?? this.threadId
        if (!this.threadId) {
          throw new SymphonyError('agent_error', 'Codex app-server did not return a thread id')
        }
        await this.setThreadNameBestEffort(this.threadId, issueThreadName(this.input.issue))

        this.input.emit({
          event: 'session_started',
          timestamp: new Date().toISOString(),
          codex_app_server_pid: this.proc.pid ? String(this.proc.pid) : null,
          session_id: this.threadId,
          thread_id: this.threadId,
          message: `${this.input.issue.identifier}: app-server thread started`,
        })
      })(),
      this.exitPromise,
    ])
  }

  async run(input: AgentRunInput): Promise<void> {
    if (this.closed) {
      throw new SymphonyError('agent_error', 'Codex app-server session is closed')
    }
    if (!this.threadId) {
      throw new SymphonyError('agent_error', 'Codex app-server thread has not started')
    }

    this.currentInput = input
    this.blocked = false
    const turnCompletion = this.createTurnCompletion(input.config.codex.turn_timeout_ms)
    this.currentCompletion = turnCompletion.completion

    try {
      const turn = await Promise.race([
        this.request(
          'turn/start',
          buildTurnStartParams(input.config, input.workspace, this.threadId, input.prompt, {
            approvalPolicyOverride: this.approvalPolicyOverride,
            issue: input.issue,
          }),
        ),
        this.exitPromise,
      ])
      this.turnId = extractTurnId(turn) ?? this.turnId
      if (this.turnId) {
        input.emit({
          event: 'turn_started',
          timestamp: new Date().toISOString(),
          codex_app_server_pid: this.proc.pid ? String(this.proc.pid) : null,
          session_id: `${this.threadId}-${this.turnId}`,
          thread_id: this.threadId,
          turn_id: this.turnId,
          message: `${input.issue.identifier}: app-server turn started`,
        })
      }

      await Promise.race([turnCompletion.promise, this.exitPromise])
    } finally {
      if (this.currentCompletion === turnCompletion.completion) {
        this.currentCompletion = null
      }
      if (this.currentInput === input) {
        this.currentInput = null
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    this.closed = true
    this.input.signal.removeEventListener('abort', this.abort)
    for (const pendingRequest of this.pending.values()) {
      clearTimeout(pendingRequest.timer)
    }
    this.pending.clear()
    this.rl.close()
    await terminateProcess(this.proc)
  }

  private handleLine(line: string): void {
    const message = parseJsonRpcLine(line)
    if (!message) {
      if (protocolMessageCandidate(line)) {
        ;(this.currentInput ?? this.input).emit({
          event: 'malformed',
          timestamp: new Date().toISOString(),
          codex_app_server_pid: this.proc.pid ? String(this.proc.pid) : null,
          session_id: this.threadId && this.turnId ? `${this.threadId}-${this.turnId}` : this.threadId,
          thread_id: this.threadId,
          turn_id: this.turnId,
          message: 'malformed JSON event from codex',
        })
      }
      return
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(
          new SymphonyError(
            'agent_error',
            `Codex app-server ${message.error.code ?? 'error'}: ${message.error.message ?? 'unknown error'}`,
          ),
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message)
      return
    }

    if (!message.method) {
      return
    }

    if (isBlockingServerRequest(message.method)) {
      this.blockOnServerRequest(message)
      return
    }

    const event = mapNotificationToRuntimeEvent(message, {
      pid: this.proc.pid ? String(this.proc.pid) : null,
      threadId: this.threadId,
      turnId: this.turnId,
    })

    if (event?.thread_id) {
      this.threadId = event.thread_id
    }
    if (event?.turn_id) {
      this.turnId = event.turn_id
    }
    if (event) {
      ;(this.currentInput ?? this.input).emit(event)
    }

    if (event && runtimeEventBlocksTurn(event.event)) {
      this.blocked = true
      this.currentCompletion?.resolve()
      return
    }

    if (message.method === 'turn/completed') {
      const turn = asRecord(asRecord(message.params).turn)
      const status = typeof turn.status === 'string' ? turn.status : 'completed'
      const error = asRecord(turn.error)
      if (status === 'failed') {
        this.currentCompletion?.reject(
          new SymphonyError('agent_error', stringValue(error.message, null) ?? 'Codex turn failed'),
        )
      } else {
        this.currentCompletion?.resolve()
      }
    }
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    const method = message.method ?? ''
    if (method === 'item/tool/call') {
      const result = await executeDynamicToolCall((this.currentInput ?? this.input).config, message.params)
      this.send({
        id: message.id,
        result,
      })
      this.emitDynamicToolEvent(message.params, result)
      return
    }

    if (this.maybeHandleAutomaticServerRequest(message)) {
      return
    }

    if (isBlockingServerRequest(method)) {
      this.blockOnServerRequest(message)
      return
    }

    this.send({
      id: message.id,
      error: {
        code: -32601,
        message: `Unsupported Symphony app-server request: ${method}`,
      },
    })
  }

  private blockOnServerRequest(message: JsonRpcMessage): void {
    this.blocked = true
    const payload = asRecord(message.params)
    const threadId = stringValue(payload.threadId, this.threadId)
    const turnId = stringValue(payload.turnId, this.turnId)
    ;(this.currentInput ?? this.input).emit({
      event: blockingEventName(message.method ?? ''),
      timestamp: new Date().toISOString(),
      codex_app_server_pid: this.proc.pid ? String(this.proc.pid) : null,
      session_id: threadId && turnId ? `${threadId}-${turnId}` : threadId,
      thread_id: threadId,
      turn_id: turnId,
      message: summarizeServerRequest(message.method ?? '', message.params),
    })
    this.currentCompletion?.resolve()
  }

  private maybeHandleAutomaticServerRequest(message: JsonRpcMessage): boolean {
    if (message.id === undefined || !message.method) {
      return false
    }

    const input = this.currentInput ?? this.input
    const autoApproveRequests = input.config.codex.approval_policy === 'never'
    const payload = asRecord(message.params)
    const threadId = stringValue(payload.threadId, this.threadId)
    const turnId = stringValue(payload.turnId, this.turnId)
    const metadata = {
      timestamp: new Date().toISOString(),
      codex_app_server_pid: this.proc.pid ? String(this.proc.pid) : null,
      session_id: threadId && turnId ? `${threadId}-${turnId}` : threadId,
      thread_id: threadId,
      turn_id: turnId,
    }

    if (message.method === 'item/tool/requestUserInput') {
      const approvalAnswers = autoApproveRequests ? toolRequestUserInputApprovalAnswers(payload) : null
      if (approvalAnswers) {
        this.send({
          id: message.id,
          result: { answers: approvalAnswers.answers },
        })
        input.emit({
          event: 'approval_auto_approved',
          ...metadata,
          message: approvalAnswers.decision,
        })
        return true
      }

      const unavailableAnswers = toolRequestUserInputUnavailableAnswers(payload)
      if (unavailableAnswers) {
        this.send({
          id: message.id,
          result: { answers: unavailableAnswers },
        })
        input.emit({
          event: 'tool_input_auto_answered',
          ...metadata,
          message: nonInteractiveToolInputAnswer,
        })
        return true
      }

      return false
    }

    const decision = approvalDecisionForServerRequest(message.method)
    if (!decision || !autoApproveRequests) {
      return false
    }

    this.send({
      id: message.id,
      result: { decision },
    })
    input.emit({
      event: 'approval_auto_approved',
      ...metadata,
      message: decision,
    })
    return true
  }

  private emitDynamicToolEvent(params: unknown, result: { success: boolean }): void {
    const input = this.currentInput ?? this.input
    const payload = asRecord(params)
    const threadId = stringValue(payload.threadId, this.threadId)
    const turnId = stringValue(payload.turnId, this.turnId)
    const toolName = dynamicToolName(payload)
    input.emit({
      event: result.success
        ? 'tool_call_completed'
        : toolName === 'linear_graphql'
          ? 'tool_call_failed'
          : 'unsupported_tool_call',
      timestamp: new Date().toISOString(),
      codex_app_server_pid: this.proc.pid ? String(this.proc.pid) : null,
      session_id: threadId && turnId ? `${threadId}-${turnId}` : threadId,
      thread_id: threadId,
      turn_id: turnId,
      message: toolName,
    })
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId
    this.nextId += 1

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SymphonyError('agent_error', `Timed out waiting for Codex app-server ${method}`))
      }, this.input.config.codex.read_timeout_ms)

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
        timer,
      })
      this.send({ id, method, params })
    })
  }

  private send(message: JsonRpcMessage): void {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private createTurnCompletion(timeoutMs: number): { promise: Promise<void>; completion: TurnCompletion } {
    const completion: TurnCompletion = {
      resolve: () => {},
      reject: () => {},
    }
    const promise = new Promise<void>((resolve, reject) => {
      const turnTimer = setTimeout(() => {
        reject(new SymphonyError('agent_error', 'Codex app-server turn timed out'))
      }, timeoutMs)

      completion.resolve = () => {
        clearTimeout(turnTimer)
        resolve()
      }
      completion.reject = (error) => {
        clearTimeout(turnTimer)
        reject(error)
      }
    })

    return { promise, completion }
  }

  private async setThreadNameBestEffort(threadId: string, name: string): Promise<void> {
    try {
      await this.request('thread/name/set', { threadId, name })
    } catch {
      // Thread naming is an observability hint; older app-server builds may not support it.
    }
  }
}

export function buildThreadStartParams(
  config: EffectiveConfig,
  workspace: Workspace,
  options: { approvalPolicyOverride?: unknown } = {},
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    cwd: workspace.path,
    runtimeWorkspaceRoots: [workspace.path],
    serviceName: 'symphony',
    threadSource: 'user',
    dynamicTools: config.tracker.kind === 'linear' && !config.demo.mock_tracker
      ? [linearGraphqlToolSpec()]
      : [],
  }

  if (config.codex.model) {
    params.model = config.codex.model
  }
  const approvalPolicy = options.approvalPolicyOverride ?? config.codex.approval_policy
  if (approvalPolicy !== null) {
    params.approvalPolicy = approvalPolicy
  }
  if (config.codex.approvals_reviewer !== null) {
    params.approvalsReviewer = config.codex.approvals_reviewer
  }
  if (typeof config.codex.thread_sandbox === 'string') {
    params.sandbox = config.codex.thread_sandbox
  }

  return params
}

export function buildTurnStartParams(
  config: EffectiveConfig,
  workspace: Workspace,
  threadId: string,
  prompt: string,
  options: { approvalPolicyOverride?: unknown; issue?: Issue } = {},
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    threadId,
    cwd: workspace.path,
    input: [{ type: 'text', text: prompt }],
    runtimeWorkspaceRoots: [workspace.path],
  }
  if (options.issue) {
    params.responsesapiClientMetadata = issueClientMetadata(options.issue)
  }

  if (config.codex.model) {
    params.model = config.codex.model
  }
  const approvalPolicy = options.approvalPolicyOverride ?? config.codex.approval_policy
  if (approvalPolicy !== null) {
    params.approvalPolicy = approvalPolicy
  }
  if (config.codex.approvals_reviewer !== null) {
    params.approvalsReviewer = config.codex.approvals_reviewer
  }

  const sandboxPolicy = normalizeSandboxPolicy(config.codex.turn_sandbox_policy, workspace)
  if (sandboxPolicy) {
    params.sandboxPolicy = sandboxPolicy
  }

  return params
}

export function issueThreadName(issue: Issue): string {
  return singleLine(`${issue.identifier}: ${issue.title}`, 160)
}

export function mapNotificationToRuntimeEvent(
  message: JsonRpcMessage,
  context: { pid: string | null; threadId: string | null; turnId: string | null },
): AgentRuntimeEvent | null {
  const params = asRecord(message.params)
  const threadId = stringValue(params.threadId, context.threadId)
  const turn = asRecord(params.turn)
  const turnId = stringValue(turn.id, stringValue(params.turnId, context.turnId))
  const timestamp = new Date().toISOString()
  const cumulativeUsage = extractCumulativeTokenUsage(message)
  const rateLimits = extractRateLimits(message)

  if (message.method === 'thread/tokenUsage/updated') {
    return {
      event: message.method,
      timestamp,
      codex_app_server_pid: context.pid,
      session_id: threadId && turnId ? `${threadId}-${turnId}` : threadId,
      thread_id: threadId,
      turn_id: turnId,
      message: summarizeCodexNotification(message.method, params),
      ...(cumulativeUsage ? { usage: cumulativeUsage } : {}),
    }
  }

  if (message.method === 'account/rateLimits/updated') {
    return {
      event: message.method,
      timestamp,
      codex_app_server_pid: context.pid,
      session_id: context.threadId,
      thread_id: context.threadId,
      turn_id: context.turnId,
      message: summarizeCodexNotification(message.method, params),
      rate_limits: rateLimits ?? params.rateLimits ?? params,
    }
  }

  const inputRequiredEvent = inputRequiredNotificationEvent(message.method, params, turn)
  if (inputRequiredEvent) {
    return {
      event: inputRequiredEvent.event,
      timestamp,
      codex_app_server_pid: context.pid,
      session_id: threadId && turnId ? `${threadId}-${turnId}` : threadId,
      thread_id: threadId,
      turn_id: turnId,
      message: inputRequiredEvent.message,
    }
  }

  if (message.method === 'turn/started' || message.method === 'turn/completed') {
    const status = typeof turn.status === 'string' ? turn.status : null
    return {
      event: message.method === 'turn/completed' ? 'turn_completed' : 'turn_started',
      timestamp,
      codex_app_server_pid: context.pid,
      session_id: threadId && turnId ? `${threadId}-${turnId}` : threadId,
      thread_id: threadId,
      turn_id: turnId,
      message: summarizeCodexNotification(message.method, params),
      ...(message.method === 'turn/completed' && cumulativeUsage ? { usage: cumulativeUsage } : {}),
    }
  }

  if ((cumulativeUsage || rateLimits !== undefined) && isCodexWrapperNotificationMethod(message.method)) {
    return {
      event: message.method,
      timestamp,
      codex_app_server_pid: context.pid,
      session_id: threadId && turnId ? `${threadId}-${turnId}` : threadId,
      thread_id: threadId,
      turn_id: turnId,
      message: summarizeNotification(message.method, params),
      ...(cumulativeUsage ? { usage: cumulativeUsage } : {}),
      ...(rateLimits !== undefined ? { rate_limits: rateLimits } : {}),
    }
  }

  if (message.method === 'item/agentMessage/delta') {
    return {
      event: 'notification',
      timestamp,
      codex_app_server_pid: context.pid,
      session_id: threadId && turnId ? `${threadId}-${turnId}` : threadId,
      thread_id: threadId,
      turn_id: turnId,
      message: summarizeCodexNotification(message.method, params),
    }
  }

  if (message.method === 'error' || message.method === 'warning') {
    return {
      event: message.method,
      timestamp,
      codex_app_server_pid: context.pid,
      session_id: threadId && turnId ? `${threadId}-${turnId}` : threadId,
      thread_id: threadId,
      turn_id: turnId,
      message: stringValue(params.message, message.method),
    }
  }

  if (isProgressNotificationMethod(message.method)) {
    return {
      event: message.method,
      timestamp,
      codex_app_server_pid: context.pid,
      session_id: threadId && turnId ? `${threadId}-${turnId}` : threadId,
      thread_id: threadId,
      turn_id: turnId,
      message: summarizeNotification(message.method, params),
    }
  }

  return null
}

export function splitCommandLine(command: string): { executable: string; args: Array<string> } | null {
  const parts: Array<string> = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const char of command.trim()) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }

    if (char === '\\') {
      escaping = true
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        parts.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current) {
    parts.push(current)
  }

  if (parts.length === 0) {
    return null
  }

  const [executable, ...args] = parts
  return { executable, args }
}

function spawnCodexAppServer(
  command: string,
  cwd: string,
  workerHost: string | null,
): ChildProcessWithoutNullStreams {
  if (workerHost) {
    return spawnSsh(workerHost, `cd ${shellEscape(cwd)} && exec ${command}`)
  }

  return spawn(command, {
    cwd,
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

function normalizeSandboxPolicy(value: unknown, workspace: Workspace): unknown | null {
  if (!value) {
    return null
  }

  if (typeof value === 'object') {
    return value
  }

  if (typeof value !== 'string') {
    return null
  }

  if (value === 'danger-full-access' || value === 'dangerFullAccess') {
    return { type: 'dangerFullAccess' }
  }

  if (value === 'read-only' || value === 'readOnly') {
    return { type: 'readOnly' }
  }

  if (value === 'workspace-write' || value === 'workspaceWrite') {
    return { type: 'workspaceWrite', writableRoots: [workspace.path] }
  }

  return null
}

function issueClientMetadata(issue: Issue): Record<string, string> {
  return {
    service: 'symphony',
    issue_id: issue.id,
    issue_identifier: issue.identifier,
    issue_title: singleLine(issue.title, 200),
  }
}

function singleLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized
}

export function legacyApprovalPolicyFallback(value: unknown): unknown | null {
  const approvalPolicy = asRecord(value)
  const rejectPolicy = asRecord(approvalPolicy.reject)
  if (Object.keys(rejectPolicy).length === 0) {
    return null
  }

  return { granular: rejectPolicy }
}

function isUnsupportedRejectApprovalPolicyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /unknown variant [`'"]?reject[`'"]?/i.test(message)
}

function parseJsonRpcLine(line: string): JsonRpcMessage | null {
  try {
    return JSON.parse(line) as JsonRpcMessage
  } catch {
    return null
  }
}

function protocolMessageCandidate(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

function extractThreadId(result: unknown): string | null {
  const payload = asRecord(result)
  return stringValue(asRecord(payload.thread).id, null)
}

function extractTurnId(result: unknown): string | null {
  const payload = asRecord(result)
  return stringValue(asRecord(payload.turn).id, null)
}

function approvalDecisionForServerRequest(method: string): string | null {
  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval'
  ) {
    return 'acceptForSession'
  }

  if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
    return 'approved_for_session'
  }

  return null
}

function dynamicToolName(params: Record<string, unknown>): string | null {
  return stringValue(params.tool, stringValue(params.name, null))
}

function toolRequestUserInputApprovalAnswers(
  params: Record<string, unknown>,
): { answers: Record<string, { answers: Array<string> }>; decision: string } | null {
  const questions = Array.isArray(params.questions) ? params.questions : []
  const answers: Record<string, { answers: Array<string> }> = {}
  for (const question of questions) {
    const payload = asRecord(question)
    const questionId = stringValue(payload.id, null)
    const options = Array.isArray(payload.options) ? payload.options : null
    if (!questionId || !options) {
      return null
    }

    const answer = approvalOptionLabel(options)
    if (!answer) {
      return null
    }

    answers[questionId] = { answers: [answer] }
  }

  return Object.keys(answers).length > 0 ? { answers, decision: 'Approve this Session' } : null
}

function toolRequestUserInputUnavailableAnswers(
  params: Record<string, unknown>,
): Record<string, { answers: Array<string> }> | null {
  const questions = Array.isArray(params.questions) ? params.questions : []
  const answers: Record<string, { answers: Array<string> }> = {}
  for (const question of questions) {
    const questionId = stringValue(asRecord(question).id, null)
    if (!questionId) {
      return null
    }

    answers[questionId] = { answers: [nonInteractiveToolInputAnswer] }
  }

  return Object.keys(answers).length > 0 ? answers : null
}

function approvalOptionLabel(options: Array<unknown>): string | null {
  const labels = options.map((option) => stringValue(asRecord(option).label, null)).filter((label) => label !== null)
  return (
    labels.find((label) => label === 'Approve this Session') ??
    labels.find((label) => label === 'Approve Once') ??
    labels.find((label) => {
      const normalized = label.trim().toLowerCase()
      return normalized.startsWith('approve') || normalized.startsWith('allow')
    }) ??
    null
  )
}

function isBlockingServerRequest(method: string): boolean {
  return (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval' ||
    method === 'item/tool/requestUserInput' ||
    method === 'mcpServer/elicitation/request' ||
    method === 'applyPatchApproval' ||
    method === 'execCommandApproval'
  )
}

function runtimeEventBlocksTurn(event: string): boolean {
  const normalized = event.trim().toLowerCase()
  return (
    normalized === 'turn_input_required' ||
    normalized === 'input_required' ||
    normalized === 'needs_input' ||
    normalized === 'approval_required' ||
    normalized === 'mcp_elicitation_required' ||
    normalized === 'operator_input_required' ||
    normalized === 'elicitation_required'
  )
}

function inputRequiredNotificationEvent(
  method: string | undefined,
  params: Record<string, unknown>,
  turn: Record<string, unknown>,
): { event: 'turn_input_required' | 'approval_required'; message: string } | null {
  if (!method?.startsWith('turn/')) {
    return null
  }

  const outcome = normalizeInputRequiredOutcome(
    firstString(
      params.outcome,
      turn.outcome,
      valueAt(params, ['completion', 'outcome']),
      valueAt(params, ['result', 'outcome']),
    ),
  )
  if (outcome) {
    return {
      event: outcome === 'approval_required' ? 'approval_required' : 'turn_input_required',
      message: inputRequiredMessage(outcome, params),
    }
  }

  if (method === 'turn/input_required' || method === 'turn/needs_input') {
    return {
      event: 'turn_input_required',
      message: inputRequiredMessage('input_required', params),
    }
  }
  if (method === 'turn/approval_required') {
    return {
      event: 'approval_required',
      message: inputRequiredMessage('approval_required', params),
    }
  }

  if (
    booleanValue(params.needsInput) ||
    booleanValue(params.needs_input) ||
    booleanValue(params.inputRequired) ||
    booleanValue(params.input_required) ||
    normalizeInputRequiredOutcome(firstString(params.type, valueAt(params, ['payload', 'type'])))
  ) {
    return {
      event: 'turn_input_required',
      message: inputRequiredMessage('input_required', params),
    }
  }

  return null
}

function inputRequiredMessage(
  outcome: 'input_required' | 'needs_input' | 'approval_required',
  params: Record<string, unknown>,
): string {
  const message = firstString(
    params.reason,
    params.message,
    params.prompt,
    valueAt(params, ['error', 'message']),
    valueAt(params, ['payload', 'reason']),
    valueAt(params, ['payload', 'message']),
  )
  if (message) {
    return message
  }

  return outcome === 'approval_required'
    ? 'codex turn requires approval'
    : 'codex turn requires operator input'
}

function normalizeInputRequiredOutcome(
  outcome: string | null,
): 'input_required' | 'needs_input' | 'approval_required' | null {
  const normalized = outcome?.trim().toLowerCase()
  if (
    normalized === 'input_required' ||
    normalized === 'needs_input' ||
    normalized === 'approval_required'
  ) {
    return normalized
  }

  return null
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true'
}

function isProgressNotificationMethod(method: string | undefined): method is string {
  if (!method) {
    return false
  }

  return (
    method.startsWith('item/') ||
    method.startsWith('turn/') ||
    method.startsWith('hook/') ||
    method.startsWith('command/') ||
    method.startsWith('process/') ||
    method.startsWith('codex/event/') ||
    method.startsWith('mcpServer/') ||
    method.startsWith('serverRequest/')
  )
}

function summarizeNotification(method: string, params: Record<string, unknown>): string {
  return summarizeCodexNotification(method, params)
}

function extractCumulativeTokenUsage(message: JsonRpcMessage): Partial<TokenTotals> | null {
  const params = asRecord(message.params)
  let usage: Record<string, unknown> | null = null

  if (message.method === 'thread/tokenUsage/updated') {
    usage = firstRecord(
      valueAt(params, ['tokenUsage', 'total']),
      valueAt(params, ['usage']),
    )
  } else if (message.method === 'turn/completed') {
    usage = firstRecord(
      valueAt(params, ['usage']),
      valueAt(params, ['tokenUsage', 'total']),
      valueAt(params, ['turn', 'usage']),
    )
  } else if (isCodexWrapperNotificationMethod(message.method)) {
    usage = firstRecord(
      valueAt(params, ['msg', 'payload', 'info', 'total_token_usage']),
      valueAt(params, ['msg', 'payload', 'info', 'totalTokenUsage']),
      valueAt(params, ['msg', 'info', 'total_token_usage']),
      valueAt(params, ['msg', 'info', 'totalTokenUsage']),
      valueAt(params, ['tokenUsage', 'total']),
    )
  }

  return usage ? normalizeTokenUsage(usage) : null
}

function extractRateLimits(message: JsonRpcMessage): unknown {
  const params = asRecord(message.params)
  if (message.method === 'account/rateLimits/updated') {
    return params.rateLimits ?? params.rate_limits
  }

  if (!isCodexWrapperNotificationMethod(message.method)) {
    return undefined
  }

  return (
    valueAt(params, ['msg', 'payload', 'rate_limits']) ??
    valueAt(params, ['msg', 'payload', 'rateLimits']) ??
    valueAt(params, ['msg', 'rate_limits']) ??
    valueAt(params, ['msg', 'rateLimits'])
  )
}

function normalizeTokenUsage(usage: Record<string, unknown>): Partial<TokenTotals> | null {
  const input = tokenCountValue(usage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'])
  const output = tokenCountValue(usage, [
    'output_tokens',
    'outputTokens',
    'completion_tokens',
    'completionTokens',
  ])
  const total = tokenCountValue(usage, ['total_tokens', 'totalTokens'])
  const normalized: Partial<TokenTotals> = {}

  if (input !== null) {
    normalized.input_tokens = input
  }
  if (output !== null) {
    normalized.output_tokens = output
  }
  if (total !== null) {
    normalized.total_tokens = total
  } else if (input !== null && output !== null) {
    normalized.total_tokens = input + output
  }

  return Object.keys(normalized).length > 0 ? normalized : null
}

function tokenCountValue(usage: Record<string, unknown>, keys: Array<string>): number | null {
  for (const key of keys) {
    const raw = usage[key]
    const value = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN
    if (Number.isFinite(value)) {
      return Math.round(value)
    }
  }

  return null
}

function firstRecord(...values: Array<unknown>): Record<string, unknown> | null {
  for (const value of values) {
    if (isRecord(value)) {
      return value
    }
  }

  return null
}

function valueAt(value: unknown, keys: Array<string>): unknown {
  let current: unknown = value
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined
    }
    current = current[key]
  }

  return current
}

function firstString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value
    }
  }

  return null
}

function isCodexWrapperNotificationMethod(method: string | undefined): method is string {
  return typeof method === 'string' && method.startsWith('codex/event/')
}

function blockingEventName(method: string): string {
  if (method === 'mcpServer/elicitation/request' || method === 'item/tool/requestUserInput') {
    return 'mcp_elicitation_required'
  }

  return 'approval_required'
}

function summarizeServerRequest(method: string, params: unknown): string {
  const payload = asRecord(params)
  return (
    stringValue(payload.reason, null) ??
    stringValue(payload.message, null) ??
    stringValue(payload.command, null) ??
    `${method} requires operator input`
  )
}

async function maybeInterruptTurn(turnId: string | null, send: (message: JsonRpcMessage) => void): Promise<void> {
  if (!turnId) {
    return
  }

  send({
    id: `interrupt-${turnId}`,
    method: 'turn/interrupt',
    params: { turnId },
  })
}

async function terminateProcess(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return
  }

  proc.stdin.end()
  if (await waitForExit(proc, 750)) {
    return
  }

  if (process.platform === 'win32' && proc.pid) {
    await runCommand('taskkill', ['/pid', String(proc.pid), '/t', '/f'], 5000).catch(() => {
      proc.kill()
    })
  } else {
    proc.kill()
  }

  await waitForExit(proc, 5000)
}

async function waitForExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return true
  }

  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function runCommand(executable: string, args: Array<string>, timeoutMs: number): Promise<void> {
  const child = spawn(executable, args, {
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${executable} ${args.join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${executable} ${args.join(' ')} exited with ${code ?? signal}`))
    })
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown, fallback: string | null): string | null {
  return typeof value === 'string' ? value : fallback
}

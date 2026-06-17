import { inlineText } from './text'

export function summarizeCodexMessage(message: unknown): string {
  if (message == null) {
    return 'no codex message yet'
  }

  if (isRecord(message) && 'event' in message && 'message' in message) {
    const event = firstString(message.event)
    const innerMessage = message.message
    const payload = unwrapCodexMessagePayload(innerMessage)
    return truncateSummary(summarizeCodexRuntimeEvent(event, innerMessage, payload) ?? summarizeCodexPayload(payload))
  }

  if (isRecord(message) && 'message' in message) {
    return truncateSummary(summarizeCodexPayload(unwrapCodexMessagePayload(message.message)))
  }

  return truncateSummary(summarizeCodexPayload(unwrapCodexMessagePayload(message)))
}

export function summarizeCodexNotification(method: string, params: Record<string, unknown>): string {
  switch (method) {
    case 'thread/started':
      return withShortId('thread started', firstString(valueAt(params, ['thread', 'id']), params.threadId))
    case 'turn/started':
      return withShortId('turn started', firstString(valueAt(params, ['turn', 'id']), params.turnId))
    case 'turn/completed':
      return summarizeTurnCompleted(params)
    case 'turn/input_required':
    case 'turn/needs_input':
      return withDetail('turn requires operator input', firstString(params.reason, params.message, params.prompt))
    case 'turn/approval_required':
      return withDetail('turn requires approval', firstString(params.reason, params.message, params.prompt))
    case 'turn/failed':
      return `turn failed${reasonSuffix(params)}`
    case 'turn/cancelled':
      return 'turn cancelled'
    case 'turn/diff/updated':
      return summarizeDiff(params)
    case 'turn/plan/updated':
      return summarizePlan(params)
    case 'thread/tokenUsage/updated':
      return usageSummary('token usage updated', firstRecord(valueAt(params, ['tokenUsage', 'total']), params.usage))
    case 'item/started':
      return itemLifecycle('item started', params)
    case 'item/completed':
      return itemLifecycle('item completed', params)
    case 'item/agentMessage/delta':
      return streamingSummary('agent message streaming', params)
    case 'item/plan/delta':
      return streamingSummary('plan streaming', params)
    case 'item/reasoning/summaryTextDelta':
      return streamingSummary('reasoning summary streaming', params)
    case 'item/reasoning/summaryPartAdded':
      return streamingSummary('reasoning summary section added', params)
    case 'item/reasoning/textDelta':
      return streamingSummary('reasoning text streaming', params)
    case 'item/commandExecution/outputDelta':
      return streamingSummary('command output streaming', params)
    case 'item/fileChange/outputDelta':
      return streamingSummary('file change output streaming', params)
    case 'item/commandExecution/requestApproval':
      return withDetail('command approval requested', commandFromParams(params))
    case 'item/fileChange/requestApproval':
      return withDetail('file change approval requested', changeCountFromParams(params))
    case 'item/tool/requestUserInput':
    case 'tool/requestUserInput':
      return withDetail('tool requires user input', firstString(params.question, params.prompt))
    case 'item/tool/call':
      return dynamicToolSummary('dynamic tool call requested', params)
    case 'account/updated':
      return withDetail('account updated', firstString(params.authMode, params.auth_mode))
    case 'account/rateLimits/updated':
      return withDetail('rate limits updated', formatRateLimits(params.rateLimits ?? params.rate_limits))
    case 'account/chatgptAuthTokens/refresh':
      return 'account auth token refresh requested'
    default:
      if (method.startsWith('codex/event/')) {
        return summarizeCodexWrapperEvent(method.slice('codex/event/'.length), params)
      }
      return fallbackMethodSummary(method, params)
  }
}

export function summarizeCodexRuntimeMessage(event: string | null, message: string | null): string {
  const normalizedEvent = event?.trim().toLowerCase() ?? null
  const inlineMessage = message ? inline(message) : null
  if (normalizedEvent === 'approval_auto_approved') {
    if (inlineMessage?.startsWith('approval request auto-approved')) {
      return inlineMessage
    }
    return inlineMessage ? `approval request auto-approved: ${inlineMessage}` : 'approval request auto-approved'
  }
  if (normalizedEvent === 'tool_input_auto_answered') {
    if (inlineMessage?.startsWith('tool input auto-answered')) {
      return inlineMessage
    }
    return inlineMessage ? `tool input auto-answered: ${inlineMessage}` : 'tool input auto-answered'
  }
  if (normalizedEvent === 'malformed') {
    return 'malformed JSON event from codex'
  }
  if (normalizedEvent === 'tool_call_completed') {
    return dynamicToolRuntimeSummary('dynamic tool call completed', inlineMessage)
  }
  if (normalizedEvent === 'tool_call_failed') {
    return dynamicToolRuntimeSummary('dynamic tool call failed', inlineMessage)
  }
  if (normalizedEvent === 'unsupported_tool_call') {
    return dynamicToolRuntimeSummary('unsupported dynamic tool call rejected', inlineMessage)
  }
  if (
    normalizedEvent === 'turn_input_required' ||
    normalizedEvent === 'input_required' ||
    normalizedEvent === 'needs_input' ||
    normalizedEvent === 'turn/input_required' ||
    normalizedEvent === 'turn/needs_input'
  ) {
    return inlineMessage ?? 'codex turn requires operator input'
  }
  if (normalizedEvent === 'approval_required' || normalizedEvent === 'turn/approval_required') {
    return inlineMessage ?? 'codex turn requires approval'
  }

  if (!inlineMessage) {
    return event ? fallbackMethodSummary(event, {}) : 'no codex message yet'
  }
  return inlineMessage
}

function dynamicToolRuntimeSummary(base: string, toolName: string | null): string {
  const tool = toolName
  if (tool?.startsWith(base)) {
    return tool
  }
  return tool ? `${base} (${tool})` : base
}

function summarizeCodexRuntimeEvent(event: string | null, message: unknown, payload: unknown): string | null {
  const normalized = event?.trim().toLowerCase() ?? null
  if (normalized === 'session_started') {
    const sessionId = firstString(valueAt(payload, ['session_id']))
    return sessionId ? `session started (${sessionId})` : 'session started'
  }
  if (normalized === 'turn_input_required') {
    return 'turn blocked: waiting for user input'
  }
  if (normalized === 'approval_auto_approved') {
    const base = isRecord(payload) && firstString(payload.method)
      ? `${summarizeCodexPayload(payload)} (auto-approved)`
      : 'approval request auto-approved'
    const decision = isRecord(message) ? firstString(message.decision) : null
    return decision ? `${base}: ${decision}` : base
  }
  if (normalized === 'tool_input_auto_answered') {
    const base = isRecord(payload) && firstString(payload.method)
      ? `${summarizeCodexPayload(payload)} (auto-answered)`
      : 'tool input auto-answered'
    const answer = isRecord(message) ? firstString(message.answer) : null
    return answer ? `${base}: ${inline(answer)}` : base
  }
  if (normalized === 'tool_call_completed') {
    return dynamicToolRuntimeSummary('dynamic tool call completed', dynamicToolName(payload))
  }
  if (normalized === 'tool_call_failed') {
    return dynamicToolRuntimeSummary('dynamic tool call failed', dynamicToolName(payload))
  }
  if (normalized === 'unsupported_tool_call') {
    return dynamicToolRuntimeSummary('unsupported dynamic tool call rejected', dynamicToolName(payload))
  }
  if (normalized === 'turn_ended_with_error') {
    return `turn ended with error: ${summarizeReason(message)}`
  }
  if (normalized === 'startup_failed') {
    return `startup failed: ${summarizeReason(message)}`
  }
  if (normalized === 'turn_failed') {
    return summarizeCodexNotification('turn/failed', notificationParams(payload))
  }
  if (normalized === 'turn_cancelled') {
    return 'turn cancelled'
  }
  if (normalized === 'malformed') {
    return 'malformed JSON event from codex'
  }
  return null
}

function unwrapCodexMessagePayload(message: unknown): unknown {
  if (!isRecord(message)) {
    return message
  }
  if (firstString(message.method) || firstString(message.session_id) || firstString(message.reason)) {
    return message
  }
  return message.payload ?? message
}

function summarizeCodexPayload(payload: unknown): string {
  if (isRecord(payload)) {
    const method = firstString(payload.method)
    if (method) {
      return summarizeCodexNotification(method, notificationParams(payload))
    }

    const sessionId = firstString(payload.session_id)
    if (sessionId) {
      return `session started (${sessionId})`
    }

    if ('error' in payload) {
      return `error: ${summarizeReason(payload.error)}`
    }

    return inline(JSON.stringify(payload))
  }
  if (typeof payload === 'string') {
    return inline(payload)
  }
  return inline(String(payload))
}

function notificationParams(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    return {}
  }
  return firstRecord(payload.params) ?? payload
}

function dynamicToolName(payload: unknown): string | null {
  return firstString(
    valueAt(payload, ['params', 'tool']),
    valueAt(payload, ['params', 'name']),
    valueAt(payload, ['tool']),
    valueAt(payload, ['name']),
  )
}

function summarizeReason(message: unknown): string {
  if (isRecord(message)) {
    const reason = firstString(message.reason, valueAt(message.reason, ['message']))
    if (reason) {
      return inline(reason)
    }
    const error = firstString(valueAt(message, ['error', 'message']), message.error)
    if (error) {
      return inline(error)
    }
  }
  return inline(typeof message === 'string' ? message : JSON.stringify(message))
}

function truncateSummary(message: string): string {
  return message.length > 140 ? `${message.slice(0, 140)}...` : message
}

function summarizeTurnCompleted(params: Record<string, unknown>): string {
  const status = firstString(valueAt(params, ['turn', 'status']), params.status)
  const usage = firstRecord(
    params.usage,
    valueAt(params, ['tokenUsage', 'total']),
    valueAt(params, ['turn', 'usage']),
  )
  const parts = [status ? humanizeStatus(status) : null, formatUsageCounts(usage)].filter(
    (part): part is string => Boolean(part),
  )
  return parts.length > 0 ? `turn completed (${parts.join(', ')})` : 'turn completed'
}

function summarizeDiff(params: Record<string, unknown>): string {
  const files = numberValue(params.fileChangeCount ?? params.changeCount ?? valueAt(params, ['diff', 'fileCount']))
  if (files !== null && files > 0) {
    return `diff updated (${files} ${files === 1 ? 'file' : 'files'})`
  }
  return 'diff updated'
}

function summarizePlan(params: Record<string, unknown>): string {
  const explanation = firstString(params.explanation, params.summary, params.text)
  if (explanation) {
    return `plan updated: ${inline(explanation)}`
  }

  const plan = Array.isArray(params.plan) ? params.plan : null
  if (!plan?.length) {
    return 'plan updated'
  }

  const firstStep = firstString(valueAt(plan[0], ['step']), valueAt(plan[0], ['title']))
  return firstStep ? `plan updated: ${inline(firstStep)}` : `plan updated (${plan.length} steps)`
}

function summarizeCodexWrapperEvent(suffix: string, params: Record<string, unknown>): string {
  const payloadType = firstString(valueAt(params, ['msg', 'payload', 'type']), valueAt(params, ['msg', 'type']))
  switch (suffix) {
    case 'mcp_startup_update':
      return `mcp startup: ${inline(firstString(valueAt(params, ['msg', 'server']), 'mcp') ?? 'mcp')} ${inline(firstString(valueAt(params, ['msg', 'status', 'state']), 'updated') ?? 'updated')}`
    case 'mcp_startup_complete':
      return 'mcp startup complete'
    case 'task_started':
      return 'task started'
    case 'user_message':
      return 'user message received'
    case 'item_started':
      return payloadType === 'token_count'
        ? wrapperUsageSummary(params)
        : withDetail('item started', payloadType ? humanizeItemType(payloadType) : null)
    case 'item_completed':
      return payloadType === 'token_count'
        ? wrapperUsageSummary(params)
        : withDetail('item completed', payloadType ? humanizeItemType(payloadType) : null)
    case 'agent_message_delta':
      return streamingSummary('agent message streaming', params)
    case 'agent_message_content_delta':
      return streamingSummary('agent message content streaming', params)
    case 'agent_reasoning_delta':
      return streamingSummary('reasoning streaming', params)
    case 'reasoning_content_delta':
      return streamingSummary('reasoning content streaming', params)
    case 'agent_reasoning_section_break':
      return 'reasoning section break'
    case 'agent_reasoning':
      return withDetail('reasoning update', reasoningFocus(params))
    case 'turn_diff':
      return 'turn diff updated'
    case 'exec_command_begin':
      return commandFromParams(params) ?? 'command started'
    case 'exec_command_end': {
      const exitCode = numberValue(valueAt(params, ['msg', 'exit_code']) ?? valueAt(params, ['msg', 'exitCode']))
      return exitCode === null ? 'command completed' : `command completed (exit ${exitCode})`
    }
    case 'exec_command_output_delta':
      return 'command output streaming'
    case 'mcp_tool_call_begin':
      return 'mcp tool call started'
    case 'mcp_tool_call_end':
      return 'mcp tool call completed'
    case 'token_count':
      return wrapperUsageSummary(params)
    default:
      return payloadType ? `${humanizeMethod(suffix)} (${humanizeItemType(payloadType)})` : humanizeMethod(suffix)
  }
}

function wrapperUsageSummary(params: Record<string, unknown>): string {
  return usageSummary(
    'token count update',
    firstRecord(
      valueAt(params, ['msg', 'payload', 'info', 'total_token_usage']),
      valueAt(params, ['msg', 'payload', 'info', 'totalTokenUsage']),
      valueAt(params, ['msg', 'info', 'total_token_usage']),
      valueAt(params, ['msg', 'info', 'totalTokenUsage']),
    ),
  )
}

function usageSummary(base: string, usage: Record<string, unknown> | null): string {
  const counts = formatUsageCounts(usage)
  return counts ? `${base} (${counts})` : base
}

function formatUsageCounts(usage: Record<string, unknown> | null): string | null {
  if (!usage) {
    return null
  }
  const input = tokenCountValue(usage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'])
  const output = tokenCountValue(usage, [
    'output_tokens',
    'outputTokens',
    'completion_tokens',
    'completionTokens',
  ])
  const total =
    tokenCountValue(usage, ['total_tokens', 'totalTokens', 'total']) ??
    (input !== null && output !== null ? input + output : null)

  const parts = [
    input !== null ? `in ${formatCount(input)}` : null,
    output !== null ? `out ${formatCount(output)}` : null,
    total !== null ? `total ${formatCount(total)}` : null,
  ].filter((part): part is string => Boolean(part))

  return parts.length > 0 ? parts.join(', ') : null
}

function itemLifecycle(base: string, params: Record<string, unknown>): string {
  const item = firstRecord(params.item, valueAt(params, ['params', 'item'])) ?? {}
  const type = humanizeItemType(firstString(item.type))
  const status = firstString(item.status)
  const id = firstString(item.id)
  const parts = [id ? shortId(id) : null, status ? humanizeStatus(status) : null].filter(
    (part): part is string => Boolean(part),
  )
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `${base}: ${type}${suffix}`
}

function streamingSummary(label: string, params: Record<string, unknown>): string {
  const delta = firstString(
    params.delta,
    valueAt(params, ['msg', 'delta']),
    params.textDelta,
    valueAt(params, ['msg', 'textDelta']),
    params.outputDelta,
    valueAt(params, ['msg', 'outputDelta']),
    params.text,
    valueAt(params, ['msg', 'text']),
    params.summaryText,
    valueAt(params, ['msg', 'summaryText']),
    valueAt(params, ['msg', 'content']),
    valueAt(params, ['msg', 'payload', 'delta']),
    valueAt(params, ['msg', 'payload', 'textDelta']),
    valueAt(params, ['msg', 'payload', 'outputDelta']),
    valueAt(params, ['msg', 'payload', 'text']),
    valueAt(params, ['msg', 'payload', 'summaryText']),
    valueAt(params, ['msg', 'payload', 'content']),
  )
  return delta ? `${label}: ${inline(delta)}` : label
}

function dynamicToolSummary(base: string, params: Record<string, unknown>): string {
  return withDetail(base, firstString(params.tool, params.name, valueAt(params, ['params', 'tool'])))
}

function commandFromParams(params: Record<string, unknown>): string | null {
  const command = normalizeCommand(
    valueAt(params, ['parsedCmd']) ??
      valueAt(params, ['parsed_cmd']) ??
      params.command ??
      params.cmd ??
      params.argv ??
      params.args ??
      valueAt(params, ['msg', 'command']) ??
      valueAt(params, ['msg', 'parsed_cmd']) ??
      valueAt(params, ['msg', 'parsedCmd']),
  )
  return command ? inline(command) : null
}

function normalizeCommand(command: unknown): string | null {
  if (typeof command === 'string') {
    return command
  }
  if (Array.isArray(command) && command.every((item) => typeof item === 'string')) {
    return command.join(' ')
  }
  if (isRecord(command)) {
    const executable = firstString(command.command, command.cmd, command.parsedCmd)
    const args = Array.isArray(command.args) && command.args.every((item) => typeof item === 'string')
      ? command.args
      : Array.isArray(command.argv) && command.argv.every((item) => typeof item === 'string')
        ? command.argv
        : null
    if (executable && args) {
      return [executable, ...args].join(' ')
    }
    return executable
  }
  return null
}

function changeCountFromParams(params: Record<string, unknown>): string | null {
  const count = numberValue(params.fileChangeCount ?? params.changeCount)
  if (count === null || count <= 0) {
    return null
  }
  return `${count} ${count === 1 ? 'file' : 'files'}`
}

function reasoningFocus(params: Record<string, unknown>): string | null {
  return firstString(
    params.reason,
    params.summaryText,
    params.summary,
    params.text,
    valueAt(params, ['msg', 'reason']),
    valueAt(params, ['msg', 'summaryText']),
    valueAt(params, ['msg', 'summary']),
    valueAt(params, ['msg', 'text']),
    valueAt(params, ['msg', 'payload', 'reason']),
    valueAt(params, ['msg', 'payload', 'summaryText']),
    valueAt(params, ['msg', 'payload', 'summary']),
    valueAt(params, ['msg', 'payload', 'text']),
  )
}

function formatRateLimits(rateLimits: unknown): string | null {
  if (!isRecord(rateLimits)) {
    return null
  }
  const primary = rateLimitBucket(rateLimits.primary)
  const secondary = rateLimitBucket(rateLimits.secondary)
  if (primary && secondary) {
    return `primary ${primary}; secondary ${secondary}`
  }
  if (primary) {
    return `primary ${primary}`
  }
  if (secondary) {
    return `secondary ${secondary}`
  }
  return null
}

function rateLimitBucket(bucket: unknown): string | null {
  if (!isRecord(bucket)) {
    return null
  }
  const usedPercent = numberValue(bucket.usedPercent ?? bucket.used_percent)
  const windowMins = numberValue(bucket.windowDurationMins ?? bucket.window_duration_mins)
  if (usedPercent !== null && windowMins !== null) {
    return `${usedPercent}% / ${windowMins}m`
  }
  if (usedPercent !== null) {
    return `${usedPercent}% used`
  }
  const remaining = numberValue(bucket.remaining)
  const limit = numberValue(bucket.limit)
  if (remaining !== null && limit !== null) {
    return `${formatCount(remaining)}/${formatCount(limit)} remaining`
  }
  return null
}

function reasonSuffix(params: Record<string, unknown>): string {
  const reason = firstString(params.reason, params.message, valueAt(params, ['error', 'message']))
  return reason ? `: ${inline(reason)}` : ''
}

function fallbackMethodSummary(method: string, params: Record<string, unknown>): string {
  const msgType = firstString(valueAt(params, ['msg', 'type']), valueAt(params, ['params', 'msg', 'type']))
  return msgType ? `${humanizeMethod(method)} (${humanizeItemType(msgType)})` : humanizeMethod(method)
}

function humanizeMethod(method: string): string {
  return method
    .split('/')
    .filter(Boolean)
    .map(humanizeItemType)
    .join(' ')
}

function humanizeItemType(type: string | null): string {
  if (!type) {
    return 'item'
  }
  return type
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replaceAll('/', ' ')
    .toLowerCase()
    .trim()
}

function humanizeStatus(status: string): string {
  return status.replaceAll('_', ' ').replaceAll('-', ' ').toLowerCase().trim()
}

function withShortId(base: string, id: string | null): string {
  return id ? `${base} (${shortId(id)})` : base
}

function withDetail(base: string, detail: string | null): string {
  return detail ? `${base}: ${inline(detail)}` : base
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id
}

function inline(value: string): string {
  return inlineText(value, { maxLength: 80 })
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

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

function firstString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

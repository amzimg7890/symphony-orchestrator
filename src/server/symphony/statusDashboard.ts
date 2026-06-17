import { summarizeCodexRuntimeMessage } from './codexEventSummary'
import { inlineText } from './text'
import type { RuntimeSnapshot } from './types'

export type StatusDashboardOptions = {
  color?: boolean
  dashboardUrl?: string | null
  projectSlug?: string | null
  terminalColumns?: number
  tps?: number
}

export type TokenThroughputSample = readonly [timestampMs: number, totalTokens: number]

const DEFAULT_COLUMNS = 115
const THROUGHPUT_WINDOW_MS = 5_000
const THROUGHPUT_GRAPH_WINDOW_MS = 10 * 60 * 1000
const THROUGHPUT_GRAPH_COLUMNS = 24
const SPARKLINE_BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const RUNNING_ID_WIDTH = 8
const RUNNING_STAGE_WIDTH = 14
const RUNNING_PID_WIDTH = 8
const RUNNING_AGE_WIDTH = 12
const RUNNING_TOKENS_WIDTH = 10
const RUNNING_SESSION_WIDTH = 14
const RUNNING_EVENT_MIN_WIDTH = 12
const RUNNING_ROW_CHROME_WIDTH = 10
const RUNNING_FIXED_WIDTH =
  RUNNING_ID_WIDTH +
  RUNNING_STAGE_WIDTH +
  RUNNING_PID_WIDTH +
  RUNNING_AGE_WIDTH +
  RUNNING_TOKENS_WIDTH +
  RUNNING_SESSION_WIDTH
const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  blue: '\u001b[34m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  magenta: '\u001b[35m',
  gray: '\u001b[90m',
}

export function formatStatusDashboard(
  snapshot: RuntimeSnapshot,
  options: StatusDashboardOptions = {},
): string {
  const color = options.color ?? false
  const terminalColumns = Math.max(80, options.terminalColumns ?? DEFAULT_COLUMNS)
  const runningEventWidth = Math.max(
    RUNNING_EVENT_MIN_WIDTH,
    terminalColumns - RUNNING_FIXED_WIDTH - RUNNING_ROW_CHROME_WIDTH,
  )
  const maxAgents = snapshot.config.max_concurrent_agents ?? snapshot.counts.running
  const projectSlug = options.projectSlug ?? projectSlugFromSnapshot(snapshot)
  const projectUrl = projectUrlFromSnapshot(snapshot, projectSlug)
  const dashboardUrl = options.dashboardUrl ?? dashboardUrlFromSnapshot(snapshot)

  return [
    paint('╭─ SYMPHONY STATUS', 'bold', color),
    `${paint('│ app_status=', 'bold', color)}${statusValue(snapshot.service_status, color)}`,
    `${paint('│ Agents: ', 'bold', color)}${paint(String(snapshot.counts.running), 'green', color)}${paint('/', 'gray', color)}${paint(String(maxAgents), 'gray', color)}`,
    `${paint('│ Throughput: ', 'bold', color)}${paint(`${formatTps(options.tps ?? 0)} tps`, 'cyan', color)}`,
    `${paint('│ Runtime: ', 'bold', color)}${paint(formatRuntimeSeconds(snapshot.codex_totals.seconds_running), 'magenta', color)}`,
    `${paint('│ Tokens: ', 'bold', color)}${paint(`in ${formatCount(snapshot.codex_totals.input_tokens)}`, 'yellow', color)}${paint(' | ', 'gray', color)}${paint(`out ${formatCount(snapshot.codex_totals.output_tokens)}`, 'yellow', color)}${paint(' | ', 'gray', color)}${paint(`total ${formatCount(snapshot.codex_totals.total_tokens)}`, 'yellow', color)}`,
    `${paint('│ Rate Limits: ', 'bold', color)}${formatRateLimits(snapshot.rate_limits, color)}`,
    `${paint('│ Project: ', 'bold', color)}${projectUrl === 'n/a' ? paint(projectUrl, 'gray', color) : paint(projectUrl, 'cyan', color)}`,
    ...(dashboardUrl ? [`${paint('│ Dashboard: ', 'bold', color)}${paint(dashboardUrl, 'cyan', color)}`] : []),
    `${paint('│ Next refresh: ', 'bold', color)}${paint(formatPolling(snapshot.polling), snapshot.polling['checking?'] ? 'cyan' : 'gray', color)}`,
    paint('├─ Running', 'bold', color),
    '│',
    runningHeader(runningEventWidth, color),
    runningSeparator(runningEventWidth, color),
    ...runningRows(snapshot, runningEventWidth, color),
    paint('├─ Blocked', 'bold', color),
    '│',
    ...blockedRows(snapshot, color),
    paint('├─ Backoff queue', 'bold', color),
    '│',
    ...retryRows(snapshot, color),
    closingBorder(),
  ].join('\n')
}

export function formatOfflineStatusDashboard(options: Pick<StatusDashboardOptions, 'color'> = {}): string {
  const color = options.color ?? false
  return [
    paint('╭─ SYMPHONY STATUS', 'bold', color),
    `${paint('│ app_status=', 'bold', color)}${paint('offline', 'red', color)}`,
    closingBorder(),
  ].join('\n')
}

export function rollingTps(
  samples: Array<TokenThroughputSample>,
  nowMs: number,
  currentTokens: number,
): number {
  const prunedSamples = pruneSamples([[nowMs, currentTokens], ...samples], nowMs, THROUGHPUT_WINDOW_MS)
  if (prunedSamples.length <= 1) {
    return 0
  }

  const [startMs, startTokens] = prunedSamples[prunedSamples.length - 1]!
  const elapsedMs = nowMs - startMs
  const deltaTokens = Math.max(0, currentTokens - startTokens)
  return elapsedMs <= 0 ? 0 : deltaTokens / (elapsedMs / 1000)
}

export function throttledTps(
  lastSecond: number | null,
  lastValue: number | null,
  nowMs: number,
  samples: Array<TokenThroughputSample>,
  currentTokens: number,
): { second: number; tps: number } {
  const second = Math.floor(nowMs / 1000)
  if (Number.isInteger(lastSecond) && lastSecond === second && typeof lastValue === 'number') {
    return { second, tps: lastValue }
  }
  return { second, tps: rollingTps(samples, nowMs, currentTokens) }
}

export function tpsGraph(
  samples: Array<TokenThroughputSample>,
  nowMs: number,
  currentTokens: number,
): string {
  const bucketMs = Math.floor(THROUGHPUT_GRAPH_WINDOW_MS / THROUGHPUT_GRAPH_COLUMNS)
  const activeBucketStart = Math.floor(nowMs / bucketMs) * bucketMs
  const graphWindowStart = activeBucketStart - (THROUGHPUT_GRAPH_COLUMNS - 1) * bucketMs
  const points = pruneSamples(
    [[nowMs, currentTokens], ...samples],
    nowMs,
    Math.max(THROUGHPUT_WINDOW_MS, THROUGHPUT_GRAPH_WINDOW_MS),
  ).sort((left, right) => left[0] - right[0])

  const rates = points.slice(0, -1).map((point, index): TokenThroughputSample => {
    const [startMs, startTokens] = point
    const [endMs, endTokens] = points[index + 1]!
    const elapsedMs = endMs - startMs
    const deltaTokens = Math.max(0, endTokens - startTokens)
    const tps = elapsedMs <= 0 ? 0 : deltaTokens / (elapsedMs / 1000)
    return [endMs, tps]
  })

  const bucketedTps = Array.from({ length: THROUGHPUT_GRAPH_COLUMNS }, (_, bucketIndex) => {
    const bucketStart = graphWindowStart + bucketIndex * bucketMs
    const bucketEnd = bucketStart + bucketMs
    const lastBucket = bucketIndex === THROUGHPUT_GRAPH_COLUMNS - 1
    const values = rates
      .filter(([timestamp]) => inBucket(timestamp, bucketStart, bucketEnd, lastBucket))
      .map(([, tps]) => tps)
    return values.length === 0 ? 0 : Math.max(...values)
  })

  const maxTps = Math.max(...bucketedTps, 0)
  return bucketedTps
    .map((value) => {
      const index = maxTps <= 0 ? 0 : Math.round((value / maxTps) * (SPARKLINE_BLOCKS.length - 1))
      return SPARKLINE_BLOCKS[index] ?? '▁'
    })
    .join('')
}

function runningHeader(eventWidth: number, color: boolean): string {
  const header = [
    formatCell('ID', RUNNING_ID_WIDTH),
    formatCell('STAGE', RUNNING_STAGE_WIDTH),
    formatCell('PID', RUNNING_PID_WIDTH),
    formatCell('AGE / TURN', RUNNING_AGE_WIDTH),
    formatCell('TOKENS', RUNNING_TOKENS_WIDTH),
    formatCell('SESSION', RUNNING_SESSION_WIDTH),
    formatCell('EVENT', eventWidth),
  ].join(' ')

  return `│   ${paint(header, 'gray', color)}`
}

function runningSeparator(eventWidth: number, color: boolean): string {
  const separatorWidth = RUNNING_FIXED_WIDTH + eventWidth + 6
  return `│   ${paint('─'.repeat(separatorWidth), 'gray', color)}`
}

function runningRows(snapshot: RuntimeSnapshot, eventWidth: number, color: boolean): Array<string> {
  if (snapshot.running.length === 0) {
    return [`│  ${paint('No active agents', 'gray', color)}`, '│']
  }

  return snapshot.running
    .slice()
    .sort((left, right) => left.issue_identifier.localeCompare(right.issue_identifier))
    .map((row) => {
      const issue = formatCell(row.issue_identifier || 'unknown', RUNNING_ID_WIDTH)
      const stage = formatCell(row.state || 'unknown', RUNNING_STAGE_WIDTH)
      const pid = formatCell(row.codex_app_server_pid || 'n/a', RUNNING_PID_WIDTH)
      const age = formatCell(formatRunningAgeAndTurns(row.started_at, snapshot.generated_at, row.turn_count), RUNNING_AGE_WIDTH)
      const tokens = formatCell(formatCount(row.tokens.total_tokens), RUNNING_TOKENS_WIDTH, 'right')
      const session = formatCell(compactSessionId(row.session_id), RUNNING_SESSION_WIDTH)
      const eventLabel = formatCell(summarizeCodexRuntimeMessage(row.last_event, row.last_message), eventWidth)
      const statusColor = runningStatusColor(row.last_event)
      return [
        '│ ',
        statusDot(statusColor, color),
        ' ',
        paint(issue, 'cyan', color),
        ' ',
        paint(stage, statusColor, color),
        ' ',
        paint(pid, 'yellow', color),
        ' ',
        paint(age, 'magenta', color),
        ' ',
        paint(tokens, 'yellow', color),
        ' ',
        paint(session, 'cyan', color),
        ' ',
        paint(eventLabel, statusColor, color),
      ].join('')
    })
}

function blockedRows(snapshot: RuntimeSnapshot, color: boolean): Array<string> {
  if (snapshot.blocked.length === 0) {
    return [`│  ${paint('No blocked sessions', 'gray', color)}`, '│']
  }

  return snapshot.blocked
    .slice()
    .sort((left, right) => left.issue_identifier.localeCompare(right.issue_identifier))
    .map((row) => {
      const reason = inline(row.reason || row.error || summarizeCodexRuntimeMessage(row.last_event, row.last_message))
      const session = compact(row.session_id, 16)
      return `│  ${pad(row.issue_identifier, 10)} ${pad(row.state || 'blocked', 14)} ${pad(session, 16)} reason=${reason}`
    })
}

function retryRows(snapshot: RuntimeSnapshot, color: boolean): Array<string> {
  if (snapshot.retrying.length === 0) {
    return [`│  ${paint('No queued retries', 'gray', color)}`]
  }

  return snapshot.retrying
    .slice()
    .sort((left, right) => retryDueInMs(left.due_at, snapshot.generated_at) - retryDueInMs(right.due_at, snapshot.generated_at))
    .map((row) => {
      const due = formatRetryDue(row.due_at, snapshot.generated_at)
      const error = formatRetryError(row.error)
      return [
        '│  ',
        paint('↻', 'yellow', color),
        ' ',
        paint(row.issue_identifier, 'red', color),
        ' ',
        paint(`attempt=${row.attempt}`, 'yellow', color),
        paint(' in ', 'dim', color),
        paint(due, 'cyan', color),
        error ? ` ${paint(`error=${error}`, 'dim', color)}` : '',
      ].join('')
    })
}

function statusValue(status: RuntimeSnapshot['service_status'], color: boolean): string {
  if (status === 'running') {
    return paint(status, 'green', color)
  }
  if (status === 'error') {
    return paint(status, 'red', color)
  }
  return paint(status, 'yellow', color)
}

function formatRateLimits(rateLimits: unknown, color: boolean): string {
  if (!isRecord(rateLimits)) {
    return paint(rateLimits == null ? 'unavailable' : inline(String(rateLimits)), 'gray', color)
  }

  const limitId = firstDefined(rateLimits, ['limit_id', 'limit_name']) ?? 'unknown'
  const primary = formatRateBucket(firstDefined(rateLimits, ['primary']))
  const secondary = formatRateBucket(firstDefined(rateLimits, ['secondary']))
  const credits = formatCredits(firstDefined(rateLimits, ['credits']))
  const separator = paint(' | ', 'gray', color)

  return [
    paint(inline(String(limitId)), 'yellow', color),
    paint(`primary ${primary}`, 'cyan', color),
    paint(`secondary ${secondary}`, 'cyan', color),
    paint(credits, 'green', color),
  ].join(separator)
}

function formatRateBucket(bucket: unknown): string {
  if (bucket == null) {
    return 'n/a'
  }
  if (!isRecord(bucket)) {
    return inline(String(bucket))
  }

  const remaining = numberValue(bucket.remaining)
  const limit = numberValue(bucket.limit)
  const reset = firstDefined(bucket, [
    'reset_in_seconds',
    'resetInSeconds',
    'reset_at',
    'resetAt',
    'resets_at',
    'resetsAt',
  ])
  const usedPercent = numberValue(bucket.usedPercent ?? bucket.used_percent)
  const windowMins = numberValue(bucket.windowDurationMins ?? bucket.window_duration_mins)

  if (remaining !== null && limit !== null) {
    const resetSuffix = reset == null ? '' : ` reset ${formatResetValue(reset)}`
    return `${formatCount(remaining)}/${formatCount(limit)}${resetSuffix}`
  }

  if (remaining !== null) {
    const resetSuffix = reset == null ? '' : ` reset ${formatResetValue(reset)}`
    return `remaining ${formatCount(remaining)}${resetSuffix}`
  }

  if (limit !== null) {
    return `limit ${formatCount(limit)}`
  }

  if (usedPercent !== null && windowMins !== null) {
    return `${usedPercent}%/${windowMins}m`
  }

  if (usedPercent !== null) {
    return `${usedPercent}% used`
  }

  if (Object.keys(bucket).length === 0) {
    return 'n/a'
  }

  return inline(JSON.stringify(bucket))
}

function formatCredits(credits: unknown): string {
  if (credits == null) {
    return 'credits n/a'
  }
  if (!isRecord(credits)) {
    return `credits ${inline(String(credits))}`
  }
  if (credits.unlimited === true) {
    return 'credits unlimited'
  }
  if (credits.has_credits === true || credits.hasCredits === true) {
    const balance = numberValue(credits.balance)
    return balance === null ? 'credits available' : `credits ${formatNumber(balance)}`
  }
  return 'credits none'
}

function formatResetValue(value: unknown): string {
  const numeric = numberValue(value)
  if (numeric !== null) {
    return `${formatCount(numeric)}s`
  }
  return inline(String(value))
}

function formatPolling(polling: RuntimeSnapshot['polling']): string {
  if (polling['checking?']) {
    return 'checking now…'
  }
  if (typeof polling.next_poll_in_ms === 'number') {
    return `${Math.ceil(Math.max(0, polling.next_poll_in_ms) / 1000)}s`
  }
  return 'n/a'
}

function projectSlugFromSnapshot(snapshot: RuntimeSnapshot): string | null {
  const projectSlug = snapshot.config.tracker_project_slug
  if (snapshot.config.tracker !== 'linear' || typeof projectSlug !== 'string') {
    return null
  }
  const trimmed = projectSlug.trim()
  return trimmed.length > 0 ? trimmed : null
}

function projectUrlFromSnapshot(snapshot: RuntimeSnapshot, projectSlug: string | null): string {
  if (projectSlug) {
    return `https://linear.app/project/${projectSlug}/issues`
  }

  const repository = snapshot.config.tracker_repository
  if (snapshot.config.tracker === 'github' && typeof repository === 'string' && repository.trim()) {
    return `https://github.com/${repository.trim()}/issues`
  }

  return 'n/a'
}

function dashboardUrlFromSnapshot(snapshot: RuntimeSnapshot): string | null {
  const port = snapshot.config.server_port
  if (!Number.isInteger(port) || port === null || port <= 0) {
    return null
  }

  return `http://${dashboardUrlHost(snapshot.config.server_host)}:${port}/`
}

function dashboardUrlHost(host: string | null): string {
  if (typeof host !== 'string') {
    return '127.0.0.1'
  }
  const trimmed = host.trim()
  if (trimmed === '' || trimmed === '0.0.0.0' || trimmed === '::' || trimmed === '[::]') {
    return '127.0.0.1'
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
  }
  if (trimmed.includes(':')) {
    return `[${trimmed}]`
  }
  return trimmed
}

function formatRunningAgeAndTurns(startedAt: string, generatedAt: string, turnCount: number): string {
  const age = formatAge(startedAt, generatedAt)
  return Number.isInteger(turnCount) && turnCount > 0 ? `${age} / ${turnCount}` : age
}

function formatAge(startedAt: string, generatedAt: string): string {
  const start = Date.parse(startedAt)
  const end = Date.parse(generatedAt)
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return 'n/a'
  }
  return formatRuntimeSeconds(Math.max(0, Math.floor((end - start) / 1000)))
}

function runningStatusColor(event: string | null): keyof typeof ANSI {
  if (!event) {
    return 'red'
  }

  switch (event) {
    case 'codex/event/token_count':
      return 'yellow'
    case 'codex/event/task_started':
      return 'green'
    case 'turn_completed':
      return 'magenta'
    default:
      return 'blue'
  }
}

function statusDot(colorName: keyof typeof ANSI, enabled: boolean): string {
  return paint('●', colorName, enabled)
}

function retryDueInMs(dueAt: string, generatedAt: string): number {
  const due = Date.parse(dueAt)
  const generated = Date.parse(generatedAt)
  if (Number.isNaN(due) || Number.isNaN(generated)) {
    return Number.MAX_SAFE_INTEGER
  }
  return Math.max(0, due - generated)
}

function formatRetryDue(dueAt: string, generatedAt: string): string {
  const dueInMs = retryDueInMs(dueAt, generatedAt)
  if (dueInMs === Number.MAX_SAFE_INTEGER) {
    return 'n/a'
  }
  const seconds = Math.floor(dueInMs / 1000)
  const milliseconds = dueInMs % 1000
  return `${seconds}.${String(milliseconds).padStart(3, '0')}s`
}

function formatRetryError(error: string | null): string {
  return error ? inline(error) : ''
}

function formatRuntimeSeconds(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.trunc(seconds))
  const minutes = Math.floor(wholeSeconds / 60)
  const rest = wholeSeconds % 60
  return `${minutes}m ${rest}s`
}

function formatTps(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0'
  }
  return formatCount(Math.trunc(value))
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return formatCount(value)
  }
  return value.toFixed(2)
}

function formatCell(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  const text = truncatePlain(inline(value), width)
  return align === 'right' ? text.padStart(width, ' ') : text.padEnd(width, ' ')
}

function truncatePlain(value: string, width: number): string {
  if (value.length <= width) {
    return value
  }
  if (width <= 3) {
    return value.slice(0, width)
  }
  return `${value.slice(0, width - 3)}...`
}

function compactSessionId(sessionId: string | null): string {
  if (!sessionId) {
    return 'n/a'
  }
  if (sessionId.length > 10) {
    return `${sessionId.slice(0, 4)}...${sessionId.slice(-6)}`
  }
  return sessionId
}

function pad(value: string, width: number): string {
  const text = inline(value)
  if (text.length > width) {
    return `${text.slice(0, Math.max(0, width - 1))}…`
  }
  return text.padEnd(width, ' ')
}

function compact(value: string | null, width: number): string {
  if (!value) {
    return 'n/a'
  }
  if (value.length <= width) {
    return value
  }
  if (width <= 4) {
    return value.slice(0, width)
  }
  return `${value.slice(0, width - 4)}…${value.slice(-3)}`
}

function inline(value: string): string {
  return inlineText(value)
}

function closingBorder(): string {
  return '╰─'
}

function pruneSamples(
  samples: Array<TokenThroughputSample>,
  nowMs: number,
  windowMs: number,
): Array<TokenThroughputSample> {
  const minTimestamp = nowMs - windowMs
  return samples.filter(([timestamp]) => timestamp >= minTimestamp)
}

function inBucket(timestamp: number, bucketStart: number, bucketEnd: number, lastBucket: boolean): boolean {
  return timestamp >= bucketStart && (lastBucket ? timestamp <= bucketEnd : timestamp < bucketEnd)
}

function paint(text: string, colorName: keyof typeof ANSI, enabled: boolean): string {
  if (!enabled) {
    return text
  }
  return `${ANSI[colorName]}${text}${ANSI.reset}`
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function firstDefined(record: Record<string, unknown>, keys: Array<string>): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key]
    }
  }
  return undefined
}

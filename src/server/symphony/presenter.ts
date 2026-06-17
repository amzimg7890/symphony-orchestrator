import { summarizeCodexRuntimeMessage } from './codexEventSummary'
import type { BlockedSnapshotRow, RunningSnapshotRow, RuntimeSnapshot, SymphonyErrorPayload } from './types'

export function presentRuntimeSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  return {
    ...snapshot,
    running: snapshot.running.map(presentRunningRow),
    retrying: snapshot.retrying.map((row) => ({ ...row })),
    blocked: snapshot.blocked.map(presentBlockedRow),
    rate_limits: cloneJsonLike(snapshot.rate_limits),
    recent_events: snapshot.recent_events.map((event) => cloneJsonLike(event)),
    config_errors: snapshot.config_errors.map(presentErrorPayload),
    last_error: snapshot.last_error ? presentErrorPayload(snapshot.last_error) : null,
    codex_totals: { ...snapshot.codex_totals },
    polling: { ...snapshot.polling },
    counts: { ...snapshot.counts },
    config: {
      ...snapshot.config,
      worker_ssh_hosts: [...snapshot.config.worker_ssh_hosts],
      active_states: [...snapshot.config.active_states],
      terminal_states: [...snapshot.config.terminal_states],
    },
  }
}

export function presentIssueDetailSnapshot(detail: unknown): unknown {
  if (!isRecord(detail)) {
    return detail
  }

  const projected = cloneJsonLike(detail)
  const running = presentRuntimeRowRecord(projected.running)
  const blocked = presentRuntimeRowRecord(projected.blocked)

  return {
    ...projected,
    running,
    blocked,
    recent_events: presentIssueRecentEvents(running, blocked),
  }
}

function presentRunningRow(row: RunningSnapshotRow): RunningSnapshotRow {
  return {
    ...row,
    last_message: presentRuntimeMessage(row.last_event, row.last_message),
    tokens: { ...row.tokens },
  }
}

function presentBlockedRow(row: BlockedSnapshotRow): BlockedSnapshotRow {
  return {
    ...row,
    last_message: presentRuntimeMessage(row.last_event, row.last_message),
  }
}

function presentRuntimeRowRecord(row: unknown): unknown {
  if (!isRecord(row)) {
    return row ?? null
  }

  return {
    ...row,
    last_message: presentRuntimeMessage(stringOrNull(row.last_event), stringOrNull(row.last_message)),
  }
}

function presentRuntimeMessage(event: string | null, message: string | null): string | null {
  return message === null ? null : summarizeCodexRuntimeMessage(event, message)
}

function presentErrorPayload(error: SymphonyErrorPayload): SymphonyErrorPayload {
  return {
    ...error,
    ...(error.details ? { details: cloneJsonLike(error.details) } : {}),
  }
}

function presentIssueRecentEvents(running: unknown, blocked: unknown): Array<Record<string, unknown>> {
  const latest = latestIssueRuntimeEvent(running) ?? latestIssueRuntimeEvent(blocked)
  return latest ? [latest] : []
}

function latestIssueRuntimeEvent(row: unknown): Record<string, unknown> | null {
  if (!isRecord(row)) {
    return null
  }

  const at = stringOrNull(row.last_event_at)
  if (!at) {
    return null
  }

  return {
    at,
    event: stringOrNull(row.last_event),
    message: stringOrNull(row.last_message),
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function cloneJsonLike<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(cloneJsonLike) as T
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJsonLike(child)]),
    ) as T
  }

  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

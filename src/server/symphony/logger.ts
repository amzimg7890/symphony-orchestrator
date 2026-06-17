import fs from 'node:fs'
import path from 'node:path'
import { SymphonyError } from './errors'
import type { CodexSessionLog, EffectiveConfig, RuntimeSnapshot } from './types'

export type StructuredLogEntry = {
  at: string
  event: string
  message: string
  issue_id?: string
  issue_identifier?: string
  session_id?: string
  thread_id?: string
  turn_id?: string
  codex_app_server_pid?: string
  workflow_path: string | null
  service_status: RuntimeSnapshot['service_status']
}

export function structuredLogPath(config: EffectiveConfig): string | null {
  if (!config.logging.enabled) {
    return null
  }

  const root = path.resolve(config.logging.root)
  const target = path.resolve(root, config.logging.file)
  const relative = path.relative(root, target)

  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SymphonyError('invalid_config', 'logging.file must resolve inside logging.root')
  }

  return target
}

export function writeStructuredLog(config: EffectiveConfig | null, entry: StructuredLogEntry): void {
  if (!config?.logging.enabled) {
    return
  }

  const target = structuredLogPath(config)
  if (!target) {
    return
  }

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8')
}

export function readIssueSessionLogs(
  config: EffectiveConfig | null,
  issueIdentifier: string,
  options: { maxBytes?: number } = {},
): Array<CodexSessionLog> {
  const maxBytes = options.maxBytes ?? 256 * 1024
  if (!config?.logging.enabled) {
    return []
  }

  const target = structuredLogPath(config)
  if (!target || !fs.existsSync(target)) {
    return []
  }

  const { content, truncated } = readLogTail(target, maxBytes)
  const sessions = new Map<string, CodexSessionLog>()
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }

    const entry = parseStructuredLogLine(line)
    if (!entry || entry.issue_identifier !== issueIdentifier) {
      continue
    }

    const key = entry.session_id ?? entry.thread_id ?? entry.turn_id
    if (!key) {
      continue
    }

    const existing = sessions.get(key)
    if (!existing) {
      sessions.set(key, {
        label: entry.session_id ?? entry.thread_id ?? entry.turn_id ?? 'latest',
        path: target,
        url: null,
        session_id: entry.session_id ?? null,
        thread_id: entry.thread_id ?? null,
        turn_id: entry.turn_id ?? null,
        codex_app_server_pid: entry.codex_app_server_pid ?? null,
        event_count: 1,
        first_event_at: entry.at ?? null,
        last_event_at: entry.at ?? null,
        latest_event: entry.event ?? null,
        latest_message: entry.message ?? null,
        source_truncated: truncated,
      })
      continue
    }

    existing.event_count += 1
    existing.session_id = existing.session_id ?? entry.session_id ?? null
    existing.thread_id = existing.thread_id ?? entry.thread_id ?? null
    existing.turn_id = entry.turn_id ?? existing.turn_id
    existing.codex_app_server_pid = entry.codex_app_server_pid ?? existing.codex_app_server_pid
    existing.last_event_at = entry.at ?? existing.last_event_at
    existing.latest_event = entry.event ?? existing.latest_event
    existing.latest_message = entry.message ?? existing.latest_message
    existing.source_truncated = existing.source_truncated || truncated
  }

  return Array.from(sessions.values()).sort((a, b) =>
    (b.last_event_at ?? '').localeCompare(a.last_event_at ?? ''),
  )
}

function readLogTail(target: string, maxBytes: number): { content: string; truncated: boolean } {
  const size = fs.statSync(target).size
  if (size <= maxBytes) {
    return {
      content: fs.readFileSync(target, 'utf8'),
      truncated: false,
    }
  }

  const start = Math.max(0, size - maxBytes)
  const fd = fs.openSync(target, 'r')
  try {
    const buffer = Buffer.alloc(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    const tail = buffer.toString('utf8')
    const firstLineBreak = tail.indexOf('\n')
    return {
      content: firstLineBreak >= 0 ? tail.slice(firstLineBreak + 1) : '',
      truncated: true,
    }
  } finally {
    fs.closeSync(fd)
  }
}

function parseStructuredLogLine(line: string): Partial<StructuredLogEntry> | null {
  try {
    const parsed = JSON.parse(line) as Partial<StructuredLogEntry>
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

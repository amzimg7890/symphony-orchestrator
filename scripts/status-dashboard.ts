import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { formatStatusDashboard } from '../src/server/symphony/statusDashboard'
import type { RuntimeSnapshot } from '../src/server/symphony/types'

type Args = {
  color: boolean
  dashboardUrl: string | null
  projectSlug: string | null
  snapshotPath: string | null
  terminalColumns: number | null
  tps: number
  url: string | null
}

const args = parseArgs(process.argv.slice(2))

try {
  const snapshot = await loadSnapshot(args)
  const dashboardUrl = args.dashboardUrl ?? dashboardUrlFromInput(args.url)
  process.stdout.write(
    `${formatStatusDashboard(snapshot, {
      color: args.color,
      dashboardUrl,
      projectSlug: args.projectSlug,
      terminalColumns: args.terminalColumns ?? undefined,
      tps: args.tps,
    })}\n`,
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

async function loadSnapshot(args: Args): Promise<RuntimeSnapshot> {
  if (args.snapshotPath) {
    const content = await readFile(path.resolve(args.snapshotPath), 'utf8')
    return snapshotFromPayload(JSON.parse(content))
  }

  const url = stateUrl(args.url ?? process.env.SYMPHONY_STATUS_URL ?? 'http://127.0.0.1:3001')
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`Unable to read Symphony status from ${url}: HTTP ${response.status}`)
  }
  return snapshotFromPayload(await response.json())
}

function snapshotFromPayload(payload: unknown): RuntimeSnapshot {
  const candidate = isRecord(payload) && isRecord(payload.snapshot) ? payload.snapshot : payload
  if (!isRuntimeSnapshot(candidate)) {
    throw new Error('Input did not contain a Symphony runtime snapshot')
  }
  return candidate
}

function isRuntimeSnapshot(value: unknown): value is RuntimeSnapshot {
  return (
    isRecord(value) &&
    typeof value.generated_at === 'string' &&
    typeof value.service_status === 'string' &&
    isRecord(value.counts) &&
    Array.isArray(value.running) &&
    Array.isArray(value.blocked) &&
    Array.isArray(value.retrying) &&
    isRecord(value.codex_totals) &&
    isRecord(value.polling) &&
    isRecord(value.config)
  )
}

function parseArgs(values: Array<string>): Args {
  const args: Args = {
    color: Boolean(process.stdout.isTTY),
    dashboardUrl: null,
    projectSlug: null,
    snapshotPath: null,
    terminalColumns: process.stdout.columns || null,
    tps: 0,
    url: null,
  }

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--snapshot') {
      args.snapshotPath = requireValue(values, index, '--snapshot')
      index += 1
      continue
    }
    if (value.startsWith('--snapshot=')) {
      args.snapshotPath = value.slice('--snapshot='.length)
      continue
    }
    if (value === '--url') {
      args.url = requireValue(values, index, '--url')
      index += 1
      continue
    }
    if (value.startsWith('--url=')) {
      args.url = value.slice('--url='.length)
      continue
    }
    if (value === '--dashboard-url') {
      args.dashboardUrl = requireValue(values, index, '--dashboard-url')
      index += 1
      continue
    }
    if (value.startsWith('--dashboard-url=')) {
      args.dashboardUrl = value.slice('--dashboard-url='.length)
      continue
    }
    if (value === '--project-slug') {
      args.projectSlug = requireValue(values, index, '--project-slug')
      index += 1
      continue
    }
    if (value.startsWith('--project-slug=')) {
      args.projectSlug = value.slice('--project-slug='.length)
      continue
    }
    if (value === '--columns') {
      args.terminalColumns = positiveInteger(requireValue(values, index, '--columns'), '--columns')
      index += 1
      continue
    }
    if (value.startsWith('--columns=')) {
      args.terminalColumns = positiveInteger(value.slice('--columns='.length), '--columns')
      continue
    }
    if (value === '--tps') {
      args.tps = nonNegativeNumber(requireValue(values, index, '--tps'), '--tps')
      index += 1
      continue
    }
    if (value.startsWith('--tps=')) {
      args.tps = nonNegativeNumber(value.slice('--tps='.length), '--tps')
      continue
    }
    if (value === '--color') {
      args.color = true
      continue
    }
    if (value === '--no-color') {
      args.color = false
      continue
    }
    if (value === '--help' || value === '-h') {
      printHelp()
      process.exit(0)
    }
    throw new Error(`Unknown option: ${value}`)
  }

  if (args.snapshotPath && args.url) {
    throw new Error('Use either --snapshot or --url, not both')
  }

  return args
}

function stateUrl(input: string): string {
  const url = new URL(input)
  if (url.pathname === '/' || url.pathname === '') {
    url.pathname = '/api/v1/state'
    return url.toString()
  }
  if (url.pathname === '/api/v1' || url.pathname === '/api/v1/') {
    url.pathname = '/api/v1/state'
    return url.toString()
  }
  return url.toString()
}

function dashboardUrlFromInput(input: string | null): string | null {
  if (!input) {
    return null
  }
  const url = new URL(input)
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function requireValue(values: Array<string>, index: number, flag: string): string {
  const value = values[index + 1]
  if (!value) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function positiveInteger(value: string, name: string): number {
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return numeric
}

function nonNegativeNumber(value: string, name: string): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }
  return numeric
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: npm run status:dashboard -- [options]',
      '',
      'Options:',
      '  --url URL               Read /api/v1/state from a running Symphony service.',
      '  --snapshot FILE         Render a saved runtime snapshot JSON file.',
      '  --dashboard-url URL     Include an explicit dashboard URL in the output.',
      '  --project-slug SLUG     Include a Linear project URL in the output.',
      '  --columns N             Format for a terminal width.',
      '  --tps N                 Show a tokens-per-second value.',
      '  --color / --no-color    Force ANSI color on or off.',
      '',
    ].join('\n'),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

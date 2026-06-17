import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatOfflineStatusDashboard,
  formatStatusDashboard,
  rollingTps,
  throttledTps,
  tpsGraph,
} from '../src/server/symphony/statusDashboard'
import type { TokenThroughputSample } from '../src/server/symphony/statusDashboard'
import type { RuntimeSnapshot } from '../src/server/symphony/types'

const projectRoot = path.resolve('.')
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const statusDashboardScript = path.join(projectRoot, 'scripts', 'status-dashboard.ts')

let cleanupDirs: Array<string> = []

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('terminal status dashboard formatter', () => {
  it('renders runtime, running, blocked, retry, polling, and rate-limit status', () => {
    const content = formatStatusDashboard(snapshotFixture(), {
      color: false,
      dashboardUrl: 'http://127.0.0.1:3001/',
      projectSlug: 'codex-automation-test-76ba15195432',
      terminalColumns: 115,
      tps: 42.25,
    })

    expect(content).toContain('SYMPHONY STATUS')
    expect(content).toContain('app_status=running')
    expect(content).toContain('Agents: 1/3')
    expect(content).toContain('Throughput: 42 tps')
    expect(content).toContain('Runtime: 2m 5s')
    expect(content).toContain('Tokens: in 1,000 | out 200 | total 1,200')
    expect(content).toContain('codex-api | primary 12/100 reset 30s | secondary n/a | credits 9.50')
    expect(content).toContain('Project: https://linear.app/project/codex-automation-test-76ba15195432/issues')
    expect(content).toContain('Dashboard: http://127.0.0.1:3001/')
    expect(content).toContain('Next refresh: checking now…')
    expect(content).toContain('ID       STAGE')
    expect(content).toContain('PID      AGE / TURN')
    expect(content).toContain('RUN-1')
    expect(content).toContain('● RUN-1')
    expect(content).toContain('4242')
    expect(content).toContain('0m 10s / 2')
    expect(content).toContain('thre...turn-1')
    expect(content).toContain('agent message streaming hello world')
    expect(content).not.toContain('StreamingTurn')
    expect(content).toContain('BLK-1')
    expect(content).toContain('reason=operator approval required')
    expect(content).toContain('↻ RET-1 attempt=3 in 5.000s')
    expect(content).toContain('error=worker crashed restarting')
    expect(content).not.toContain('\\n')
    expect(content).toContain('├─ Backoff queue\n│\n│  ↻')
    expect(content.endsWith('╰─')).toBe(true)
  })

  it('renders an offline status frame', () => {
    expect(formatOfflineStatusDashboard({ color: false })).toBe('╭─ SYMPHONY STATUS\n│ app_status=offline\n╰─')
  })

  it('uses upstream integer TPS and minute-second runtime formatting', () => {
    const idle = snapshotFixture()
    idle.counts.running = 0
    idle.running = []
    idle.codex_totals.seconds_running = 0

    const shortRun = snapshotFixture()
    shortRun.codex_totals.seconds_running = 45
    shortRun.running[0] = {
      ...shortRun.running[0]!,
      started_at: '2026-06-17T00:00:01.000Z',
    }

    const longRun = snapshotFixture()
    longRun.codex_totals.seconds_running = 4321

    expect(formatStatusDashboard(idle, { color: false, tps: 0 })).toContain('Throughput: 0 tps')
    expect(formatStatusDashboard(idle, { color: false })).toContain('Runtime: 0m 0s')
    expect(formatStatusDashboard(shortRun, { color: false, tps: 15.9 })).toContain('Throughput: 15 tps')
    expect(formatStatusDashboard(shortRun, { color: false })).toContain('Runtime: 0m 45s')
    expect(formatStatusDashboard(shortRun, { color: false })).toContain('0m 9s')
    expect(formatStatusDashboard(longRun, { color: false })).toContain('Runtime: 72m 1s')
  })

  it('computes upstream rolling and throttled TPS values', () => {
    expect(rollingTps([], 10_000, 0)).toBe(0)
    expect(rollingTps([[9_000, 20]], 10_000, 40)).toBe(20)
    expect(rollingTps([[4_900, 10]], 10_000, 90)).toBe(0)
    expect(
      rollingTps(
        [
          [9_500, 10],
          [9_000, 40],
          [8_000, 80],
        ],
        10_000,
        95,
      ),
    ).toBe(7.5)

    const first = throttledTps(null, null, 10_000, [[9_000, 20]], 40)
    const sameSecond = throttledTps(first.second, first.tps, 10_500, [[9_000, 20]], 200)
    const nextSecond = throttledTps(sameSecond.second, sameSecond.tps, 11_000, [[10_500, 200]], 260)

    expect(first).toEqual({ second: 10, tps: 20 })
    expect(sameSecond).toEqual(first)
    expect(nextSecond.second).toBe(11)
    expect(nextSecond.tps).not.toBe(sameSecond.tps)
  })

  it('renders upstream 10-minute TPS sparkline snapshots', () => {
    const nowMs = 600_000
    const steadySamples: Array<TokenThroughputSample> = []
    for (let timestamp = 575_000; timestamp >= 0; timestamp -= 25_000) {
      steadySamples.push([timestamp, Math.trunc(timestamp / 100)])
    }

    const ramp = graphSamplesFromRates(Array.from({ length: 24 }, (_, index) => (index + 1) * 2))
    const stabilitySamples = graphSamplesForStabilityTest(nowMs)
    const graphAtNow = tpsGraph(stabilitySamples, nowMs, 74_400)
    const graphNextSecond = tpsGraph(stabilitySamples, nowMs + 1_000, 74_520)
    const historicalChanges = Array.from(graphAtNow)
      .slice(0, 23)
      .filter((value, index) => value !== Array.from(graphNextSecond)[index]).length

    expect(tpsGraph(steadySamples, nowMs, 6_000)).toBe('████████████████████████')
    expect(tpsGraph(ramp.samples, nowMs, ramp.currentTokens)).toBe('▁▂▂▂▂▃▃▃▄▄▄▅▅▅▅▆▆▆▇▇▇▇██')
    expect(historicalChanges).toBe(0)
  })

  it('renders upstream-style retry queue rows', () => {
    const empty = snapshotFixture()
    empty.retrying = []

    const queued = snapshotFixture()
    queued.retrying = [
      {
        issue_id: 'issue-later',
        issue_identifier: 'RET-2',
        issue_url: null,
        attempt: 1,
        due_at: '2026-06-17T00:00:18.250Z',
        last_attempt_status: 'Failed',
        error: null,
        workspace_path: null,
        worker_host: null,
      },
      {
        issue_id: 'issue-sooner',
        issue_identifier: 'RET-1',
        issue_url: null,
        attempt: 4,
        due_at: '2026-06-17T00:00:11.250Z',
        last_attempt_status: 'Failed',
        error: 'rate limit exhausted\\nretrying cleanly',
        workspace_path: null,
        worker_host: null,
      },
    ]

    const plain = formatStatusDashboard(queued, { color: false })
    const colored = formatStatusDashboard(queued, { color: true })

    expect(formatStatusDashboard(empty, { color: false })).toContain('No queued retries')
    expect(plain.indexOf('RET-1')).toBeLessThan(plain.indexOf('RET-2'))
    expect(plain).toContain('↻ RET-1 attempt=4 in 1.250s error=rate limit exhausted retrying cleanly')
    expect(plain).toContain('↻ RET-2 attempt=1 in 8.250s')
    expect(colored).toContain(
      '\u001b[33m↻\u001b[0m \u001b[31mRET-1\u001b[0m \u001b[33mattempt=4\u001b[0m\u001b[2m in \u001b[0m\u001b[36m1.250s\u001b[0m',
    )
  })

  it('uses the runtime snapshot project slug when no explicit project slug option is passed', () => {
    const content = formatStatusDashboard(snapshotFixture(), { color: false })

    expect(content).toContain('Project: https://linear.app/project/codex-automation-test-76ba15195432/issues')
  })

  it('uses the runtime snapshot server config when no explicit dashboard URL option is passed', () => {
    const wildcard = snapshotFixture()
    wildcard.config.server_host = '0.0.0.0'
    wildcard.config.server_port = 4000

    const ipv6 = snapshotFixture()
    ipv6.config.server_host = '2001:db8::1'
    ipv6.config.server_port = 4001

    const disabled = snapshotFixture()
    disabled.config.server_port = 0

    expect(formatStatusDashboard(wildcard, { color: false })).toContain('Dashboard: http://127.0.0.1:4000/')
    expect(formatStatusDashboard(ipv6, { color: false })).toContain('Dashboard: http://[2001:db8::1]:4001/')
    expect(formatStatusDashboard(disabled, { color: false })).not.toContain('Dashboard:')
  })

  it('renders upstream-style rate-limit fallback states', () => {
    const unlimited = snapshotFixture()
    unlimited.rate_limits = {
      limit_name: 'workspace',
      primary: {
        remaining: '5',
      },
      secondary: {
        limit: 100,
      },
      credits: {
        unlimited: true,
      },
    }

    const available = snapshotFixture()
    available.rate_limits = {
      limit_id: 'codex',
      primary: {},
      secondary: null,
      credits: {
        hasCredits: true,
      },
    }

    const none = snapshotFixture()
    none.rate_limits = {
      limit_id: 'codex',
      primary: null,
      secondary: {
        usedPercent: 25,
        windowDurationMins: 5,
      },
      credits: {
        has_credits: false,
      },
    }

    expect(formatStatusDashboard(unlimited, { color: false })).toContain(
      'workspace | primary remaining 5 | secondary limit 100 | credits unlimited',
    )
    expect(formatStatusDashboard(available, { color: false })).toContain(
      'codex | primary n/a | secondary n/a | credits available',
    )
    expect(formatStatusDashboard(none, { color: false })).toContain(
      'codex | primary n/a | secondary 25%/5m | credits none',
    )
  })

  it('colors upstream-style rate-limit segments in color mode', () => {
    const content = formatStatusDashboard(snapshotFixture(), { color: true })

    expect(content).toContain(
      '\u001b[33mcodex-api\u001b[0m\u001b[90m | \u001b[0m\u001b[36mprimary 12/100 reset 30s\u001b[0m',
    )
    expect(content).toContain(
      '\u001b[36msecondary n/a\u001b[0m\u001b[90m | \u001b[0m\u001b[32mcredits 9.50\u001b[0m',
    )
  })

  it('colors upstream-style running status dots from the latest Codex event', () => {
    const defaultEvent = snapshotFixture()

    const tokenCount = snapshotFixture()
    tokenCount.running[0] = {
      ...tokenCount.running[0]!,
      last_event: 'codex/event/token_count',
      last_message: null,
    }

    const taskStarted = snapshotFixture()
    taskStarted.running[0] = {
      ...taskStarted.running[0]!,
      last_event: 'codex/event/task_started',
      last_message: null,
    }

    const turnCompleted = snapshotFixture()
    turnCompleted.running[0] = {
      ...turnCompleted.running[0]!,
      last_event: 'turn_completed',
      last_message: null,
    }

    const noEvent = snapshotFixture()
    noEvent.running[0] = {
      ...noEvent.running[0]!,
      last_event: null,
      last_message: null,
    }

    expect(formatStatusDashboard(defaultEvent, { color: true })).toContain('\u001b[34m●\u001b[0m')
    expect(formatStatusDashboard(tokenCount, { color: true })).toContain('\u001b[33m●\u001b[0m')
    expect(formatStatusDashboard(taskStarted, { color: true })).toContain('\u001b[32m●\u001b[0m')
    expect(formatStatusDashboard(turnCompleted, { color: true })).toContain('\u001b[35m●\u001b[0m')
    expect(formatStatusDashboard(noEvent, { color: true })).toContain('\u001b[31m●\u001b[0m')
  })

  it('humanizes auto-handled Codex runtime events in running rows', () => {
    const approval = snapshotFixture()
    approval.running[0] = {
      ...approval.running[0]!,
      last_event: 'approval_auto_approved',
      last_message: 'acceptForSession',
    }

    const toolInput = snapshotFixture()
    toolInput.running[0] = {
      ...toolInput.running[0]!,
      last_event: 'tool_input_auto_answered',
      last_message: 'This is a non-interactive session. Operator input is unavailable.',
    }

    const malformed = snapshotFixture()
    malformed.running[0] = {
      ...malformed.running[0]!,
      last_event: 'malformed',
      last_message: 'ignored raw payload',
    }

    const wideDashboardOptions = { color: false, terminalColumns: 240 }

    expect(formatStatusDashboard(approval, wideDashboardOptions)).toContain(
      'approval request auto-approved: acceptForSession',
    )
    expect(formatStatusDashboard(toolInput, wideDashboardOptions)).toContain(
      'tool input auto-answered: This is a non-interactive session. Operator input is unavailable.',
    )
    expect(formatStatusDashboard(malformed, wideDashboardOptions)).toContain('malformed JSON event from codex')
  })

  it('humanizes dynamic tool runtime events in running rows', () => {
    const completed = snapshotFixture()
    completed.running[0] = {
      ...completed.running[0]!,
      last_event: 'tool_call_completed',
      last_message: 'linear_graphql',
    }

    const failed = snapshotFixture()
    failed.running[0] = {
      ...failed.running[0]!,
      last_event: 'tool_call_failed',
      last_message: 'linear_graphql',
    }

    const unsupported = snapshotFixture()
    unsupported.running[0] = {
      ...unsupported.running[0]!,
      last_event: 'unsupported_tool_call',
      last_message: 'unknown_tool',
    }

    const wideDashboardOptions = { color: false, terminalColumns: 180 }

    expect(formatStatusDashboard(completed, wideDashboardOptions)).toContain(
      'dynamic tool call completed (linear_graphql)',
    )
    expect(formatStatusDashboard(failed, wideDashboardOptions)).toContain(
      'dynamic tool call failed (linear_graphql)',
    )
    expect(formatStatusDashboard(unsupported, wideDashboardOptions)).toContain(
      'unsupported dynamic tool call rejected (unknown_tool)',
    )
  })

  it('strips ANSI escapes and control bytes from runtime row text', () => {
    const snapshot = snapshotFixture()
    snapshot.running[0] = {
      ...snapshot.running[0]!,
      last_event: 'notification',
      last_message: 'cmd: \x1B[31mRED\x1B[0m after\nline\x07',
    }

    const content = formatStatusDashboard(snapshot, {
      color: false,
      terminalColumns: 180,
    })

    expect(content).toContain('cmd: RED after line')
    expect(content).not.toContain('\x1B')
    expect(content).not.toContain('\x07')
  })

  it('renders a saved snapshot through the CLI script', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-status-dashboard-'))
    cleanupDirs.push(dir)
    const snapshotPath = path.join(dir, 'snapshot.json')
    await writeFile(snapshotPath, JSON.stringify({ snapshot: snapshotFixture() }), 'utf8')

    const result = await runStatusDashboard([
      '--snapshot',
      snapshotPath,
      '--no-color',
      '--columns',
      '115',
      '--project-slug',
      'codex-automation-test-76ba15195432',
    ])

    if (result.exitCode !== 0) {
      throw new Error(`status dashboard exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }

    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('SYMPHONY STATUS')
    expect(result.stdout).toContain('RUN-1')
    expect(result.stdout).toContain('https://linear.app/project/codex-automation-test-76ba15195432/issues')
    expect(result.stdout).toContain('Dashboard: http://127.0.0.1:3001/')
  })
})

function graphSamplesFromRates(ratesPerBucket: Array<number>): {
  currentTokens: number
  samples: Array<TokenThroughputSample>
} {
  const bucketMs = 25_000
  let timestamp = 0
  let tokens = 0
  const samples: Array<TokenThroughputSample> = []

  for (const rate of ratesPerBucket) {
    const nextTimestamp = timestamp + bucketMs
    const nextTokens = tokens + Math.trunc((rate * bucketMs) / 1000)
    samples.unshift([timestamp, tokens])
    timestamp = nextTimestamp
    tokens = nextTokens
  }

  return {
    currentTokens: tokens,
    samples: [[timestamp, tokens], ...samples],
  }
}

function graphSamplesForStabilityTest(nowMs: number): Array<TokenThroughputSample> {
  const ratesPerBucket = Array.from({ length: 24 }, (_, index) => (index + 1) * 5)
  const bucketMs = 25_000
  let tokens = 0
  const samples: Array<TokenThroughputSample> = []

  for (let timestamp = 0; timestamp <= nowMs - 1_000; timestamp += 1_000) {
    const bucketIndex = Math.min(Math.floor(Math.max(timestamp, 0) / bucketMs), 23)
    tokens += ratesPerBucket[bucketIndex] ?? 0
    samples.unshift([timestamp, tokens])
  }

  return samples
}

function snapshotFixture(): RuntimeSnapshot {
  const generatedAt = '2026-06-17T00:00:10.000Z'
  return {
    generated_at: generatedAt,
    service_status: 'running',
    workflow_path: 'C:/repo/WORKFLOW.md',
    counts: {
      running: 1,
      retrying: 1,
      blocked: 1,
      claimed: 3,
      completed: 2,
    },
    running: [
      {
        issue_id: 'issue-run-1',
        issue_identifier: 'RUN-1',
        issue_url: 'https://linear.local/RUN-1',
        state: 'In Progress',
        session_id: 'thread-abcdef1234567890-turn-1',
        thread_id: 'thread-abcdef1234567890',
        turn_id: 'turn-1',
        codex_app_server_pid: '4242',
        turn_count: 2,
        last_event: 'notification',
        last_message: 'agent message streaming\nhello world',
        started_at: '2026-06-17T00:00:00.000Z',
        last_event_at: generatedAt,
        workspace_path: 'C:/repo/workspaces/RUN-1',
        worker_host: null,
        status: 'StreamingTurn',
        tokens: {
          input_tokens: 700,
          output_tokens: 80,
          total_tokens: 780,
        },
      },
    ],
    retrying: [
      {
        issue_id: 'issue-retry-1',
        issue_identifier: 'RET-1',
        issue_url: null,
        attempt: 3,
        due_at: '2026-06-17T00:00:15.000Z',
        last_attempt_status: 'Failed',
        error: 'worker crashed\\nrestarting',
        workspace_path: 'C:/repo/workspaces/RET-1',
        worker_host: null,
      },
    ],
    blocked: [
      {
        issue_id: 'issue-blocked-1',
        issue_identifier: 'BLK-1',
        issue_url: null,
        state: 'Blocked',
        reason: 'operator approval required',
        error: 'operator approval required',
        blocked_at: generatedAt,
        workspace_path: 'C:/repo/workspaces/BLK-1',
        worker_host: null,
        session_id: 'thread-blocked-turn-1',
        thread_id: 'thread-blocked',
        turn_id: 'turn-1',
        codex_app_server_pid: '5252',
        last_event: 'approval_requested',
        last_message: null,
        last_event_at: generatedAt,
      },
    ],
    codex_totals: {
      input_tokens: 1000,
      output_tokens: 200,
      total_tokens: 1200,
      seconds_running: 125,
    },
    rate_limits: {
      limit_id: 'codex-api',
      primary: {
        remaining: 12,
        limit: 100,
        reset_in_seconds: 30,
      },
      credits: {
        has_credits: true,
        balance: 9.5,
      },
    },
    polling: {
      'checking?': true,
      next_poll_in_ms: 2500,
      poll_interval_ms: 5000,
    },
    recent_events: [],
    config_errors: [],
    last_error: null,
    config: {
      poll_interval_ms: 5000,
      max_concurrent_agents: 3,
      workspace_root: 'C:/repo/workspaces',
      worker_ssh_hosts: [],
      worker_max_concurrent_agents_per_host: null,
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done'],
      runner: 'codex',
      tracker: 'linear',
      tracker_project_slug: 'codex-automation-test-76ba15195432',
      server_port: 3001,
      server_host: '127.0.0.1',
      observability_dashboard_enabled: true,
      observability_refresh_ms: 1000,
      observability_render_interval_ms: 16,
      logging_path: 'C:/repo/log/symphony.jsonl',
    },
  }
}

async function runStatusDashboard(args: Array<string>): Promise<{
  exitCode: number | null
  stdout: string
  stderr: string
}> {
  const child = spawn(process.execPath, [tsxCli, statusDashboardScript, ...args], {
    cwd: projectRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`status dashboard timed out: ${stderr || stdout}`))
    }, 15_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (exitCode) => {
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr })
    })
  })
}

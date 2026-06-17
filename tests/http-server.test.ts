import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  startSymphonyHttpServer,
  type SymphonyHttpService,
} from '../src/server/symphony/httpServer'
import {
  broadcastObservabilityUpdate,
  observabilitySubscriberCount,
} from '../src/server/symphony/observability'
import { SymphonyError } from '../src/server/symphony/errors'
import type { RuntimeSnapshot } from '../src/server/symphony/types'

describe('Symphony HTTP server extension', () => {
  it('serves the upstream dashboard and JSON API baseline on loopback', async () => {
    const calls = {
      starts: [] as Array<string>,
      stops: 0,
      refreshes: 0,
    }
    const service: SymphonyHttpService = {
      snapshot: () => snapshotFixture(),
      start: async (workflowPath) => {
        calls.starts.push(workflowPath)
        return snapshotFixture()
      },
      stop: async () => {
        calls.stops += 1
        return snapshotFixture({ status: 'stopped' })
      },
      refresh: async () => {
        calls.refreshes += 1
        return snapshotFixture()
      },
      issueDetail: (identifier) =>
        identifier === 'SYM-1'
          ? {
              issue_identifier: 'SYM-1',
              issue_id: 'issue-1',
              status: 'running',
              running: snapshotFixture().running[0],
              recent_events: [
                {
                  at: new Date(10_000).toISOString(),
                  event: 'stale_internal_event',
                  message: 'stale internal history',
                },
              ],
            }
          : identifier === 'SYM-2'
            ? {
                issue_identifier: 'SYM-2',
                issue_id: 'issue-2',
                status: 'retrying',
                retry: snapshotFixture().retrying[0],
                recent_events: [
                  {
                    at: new Date(20_000).toISOString(),
                    event: 'worker_failed',
                    message: 'historical retry failure',
                  },
                ],
              }
          : identifier === 'SYM-DONE'
            ? {
                issue_identifier: 'SYM-DONE',
                issue_id: 'issue-done',
                status: 'completed',
              }
          : null,
    }
    const server = await startSymphonyHttpServer({
      port: 0,
      service,
      defaultWorkflowPath: () => path.resolve('WORKFLOW.md'),
    })

    try {
      expect(server.host).toBe('127.0.0.1')
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`)

      const dashboard = await fetch(`${server.url}/`)
      expect(dashboard.status).toBe(200)
      expect(dashboard.headers.get('content-type')).toContain('text/html')
      const dashboardHtml = await dashboard.text()
      expect(dashboardHtml).toContain('<title>Symphony Observability</title>')
      expect(dashboardHtml).toContain('Operations Dashboard')
      expect(dashboardHtml).toContain('Running sessions')
      expect(dashboardHtml).toContain('Blocked sessions')
      expect(dashboardHtml).toContain('Retry queue')
      expect(dashboardHtml).toContain('Rate limits')
      expect(dashboardHtml).toContain('Next refresh')
      expect(dashboardHtml).toContain('SYM-1')
      expect(dashboardHtml).toContain('/api/v1/SYM-1')
      expect(dashboardHtml).toContain('/api/v1/SYM-2')
      expect(dashboardHtml).toContain('/api/v1/SYM-3')
      expect(dashboardHtml).toContain('Copy ID')
      expect(dashboardHtml).toContain('dynamic tool call failed (linear_graphql)')
      expect(dashboardHtml).toContain(
        'tool input auto-answered: This is a non-interactive session. Operator input is unavailable.',
      )
      expect(dashboardHtml).toContain(new Date(45_000).toISOString())
      expect(dashboardHtml).toMatch(/\/dashboard\.css\?v=[0-9a-f]{12}/)
      expect(dashboardHtml).toMatch(/\/favicon\.png\?v=[0-9a-f]{12}/)
      expect(dashboardHtml).toContain('/vendor/phoenix_html/phoenix_html.js')
      expect(dashboardHtml).toContain('/vendor/phoenix/phoenix.js')
      expect(dashboardHtml).toContain('/vendor/phoenix_live_view/phoenix_live_view.js')
      expect(dashboardHtml).toContain('meta name="csrf-token"')
      expect(dashboardHtml).toContain('new window.LiveView.LiveSocket("/live", window.Phoenix.Socket')
      expect(dashboardHtml).toContain('window.liveSocket = liveSocket')

      const dashboardCss = await fetch(`${server.url}/dashboard.css`)
      expect(dashboardCss.status).toBe(200)
      expect(dashboardCss.headers.get('content-type')).toContain('text/css')
      expect(await dashboardCss.text()).toContain(':root {')

      const favicon = await fetch(`${server.url}/favicon.png?v=ignored`)
      expect(favicon.status).toBe(200)
      expect(favicon.headers.get('content-type')).toContain('image/png')
      expect(new Uint8Array(await favicon.arrayBuffer()).slice(0, 8)).toEqual(
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      )

      const phoenixJs = await fetch(`${server.url}/vendor/phoenix/phoenix.js`)
      expect(phoenixJs.status).toBe(200)
      expect(phoenixJs.headers.get('content-type')).toContain('application/javascript')
      expect(await phoenixJs.text()).toContain('var Phoenix = (() => {')

      const liveViewJs = await fetch(`${server.url}/vendor/phoenix_live_view/phoenix_live_view.js`)
      expect(liveViewJs.status).toBe(200)
      const liveViewBody = await liveViewJs.text()
      expect(liveViewBody).toContain('var LiveView = (() => {')
      expect(liveViewBody).toContain('connect()')

      const index = await getJson<{ endpoints: { state: string; events: string }; snapshot: RuntimeSnapshot }>(
        `${server.url}/api/v1/`,
      )
      expect(index.endpoints.state).toBe('/api/v1/state')
      expect(index.endpoints).toMatchObject({ events: '/api/v1/events' })
      expect(index.snapshot.service_status).toBe('running')
      expect(index.snapshot.running[0]?.last_message).toBe('dynamic tool call failed (linear_graphql)')
      expect(index.snapshot.polling).toEqual({
        'checking?': false,
        next_poll_in_ms: 2000,
        poll_interval_ms: 30_000,
      })

      const state = await getJson<RuntimeSnapshot>(`${server.url}/api/v1/state`)
      expect(state.running[0]?.last_message).toBe('dynamic tool call failed (linear_graphql)')
      expect(state.blocked[0]?.last_message).toBe(
        'tool input auto-answered: This is a non-interactive session. Operator input is unavailable.',
      )

      const stateMethod = await fetch(`${server.url}/api/v1/state`, { method: 'POST' })
      expect(stateMethod.status).toBe(405)
      expect(stateMethod.headers.get('allow')).toBe('GET, HEAD')
      expect(await stateMethod.json()).toMatchObject({
        error: { code: 'method_not_allowed', message: 'Method not allowed' },
      })

      const invalidControl = await postJson(`${server.url}/api/v1/control`, { action: 'restart' })
      expect(invalidControl.status).toBe(400)
      expect(await invalidControl.json()).toMatchObject({
        error: { code: 'invalid_control_action' },
      })

      const started = await postJson(`${server.url}/api/v1/control`, {})
      expect(started.status).toBe(202)
      expect(calls.starts).toEqual([path.resolve('WORKFLOW.md')])

      const formStarted = await postForm(`${server.url}/api/v1/control`, {
        workflow_path: path.resolve('FORM_WORKFLOW.md'),
      })
      expect(formStarted.status).toBe(202)
      expect(calls.starts).toEqual([path.resolve('WORKFLOW.md'), path.resolve('FORM_WORKFLOW.md')])

      const refreshed = await postForm(`${server.url}/api/v1/refresh`, {})
      expect(refreshed.status).toBe(202)
      expect(await refreshed.json()).toMatchObject({
        queued: true,
        operations: ['poll', 'reconcile'],
        snapshot: {
          service_status: 'running',
          running: [
            expect.objectContaining({
              last_message: 'dynamic tool call failed (linear_graphql)',
            }),
          ],
        },
      })
      expect(calls.refreshes).toBe(1)

      const detail = await getJson<{
        issue_identifier: string
        status: string
        running: { last_message: string }
        recent_events: Array<{ at: string; event: string; message: string }>
      }>(`${server.url}/api/v1/SYM-1`)
      expect(detail).toMatchObject({
        issue_identifier: 'SYM-1',
        status: 'running',
        running: {
          last_message: 'dynamic tool call failed (linear_graphql)',
        },
        recent_events: [
          {
            at: new Date(30_000).toISOString(),
            event: 'tool_call_failed',
            message: 'dynamic tool call failed (linear_graphql)',
          },
        ],
      })
      expect(detail.recent_events).toHaveLength(1)

      const retryDetail = await getJson<{
        issue_identifier: string
        status: string
        retry: { attempt: number; error: string }
        recent_events: Array<unknown>
      }>(`${server.url}/api/v1/SYM-2`)
      expect(retryDetail).toMatchObject({
        issue_identifier: 'SYM-2',
        status: 'retrying',
        retry: {
          attempt: 2,
          error: 'agent turn failed',
        },
        recent_events: [],
      })

      const completedDetail = await fetch(`${server.url}/api/v1/SYM-DONE`)
      expect(completedDetail.status).toBe(404)
      expect(await completedDetail.json()).toMatchObject({
        error: { code: 'issue_not_found', message: 'Issue not found' },
      })

      const missing = await fetch(`${server.url}/api/v1/MISSING-1`)
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({
        error: { code: 'issue_not_found', message: 'Issue not found' },
      })

      const nestedApiPath = await fetch(`${server.url}/api/v1/SYM-1/extra`)
      expect(nestedApiPath.status).toBe(404)
      expect(await nestedApiPath.json()).toMatchObject({
        error: { code: 'not_found', message: 'Route not found' },
      })

      const encodedNestedApiPath = await fetch(`${server.url}/api/v1/SYM-1%2Fextra`)
      expect(encodedNestedApiPath.status).toBe(404)
      expect(await encodedNestedApiPath.json()).toMatchObject({
        error: { code: 'not_found', message: 'Route not found' },
      })

      const unknownRoute = await fetch(`${server.url}/api/v2/state`)
      expect(unknownRoute.status).toBe(404)
      expect(await unknownRoute.json()).toMatchObject({
        error: { code: 'not_found', message: 'Route not found' },
      })
    } finally {
      await server.close()
    }
  })

  it('rejects invalid bind hosts before listening', async () => {
    await expect(
      startSymphonyHttpServer({
        port: 0,
        host: 'bad host',
        service: {
          snapshot: () => snapshotFixture(),
          start: async () => snapshotFixture(),
          stop: async () => snapshotFixture({ status: 'stopped' }),
          refresh: async () => snapshotFixture(),
          issueDetail: () => null,
        },
      }),
    ).rejects.toMatchObject({
      code: 'invalid_config',
      message: 'server.host is invalid: bad host',
    })
  })

  it('normalizes all-interface bind hosts to a loopback dashboard URL', async () => {
    const server = await startSymphonyHttpServer({
      port: 0,
      host: '0.0.0.0',
      service: {
        snapshot: () => snapshotFixture(),
        start: async () => snapshotFixture(),
        stop: async () => snapshotFixture({ status: 'stopped' }),
        refresh: async () => snapshotFixture(),
        issueDetail: () => null,
      },
    })

    try {
      expect(server.host).toBe('0.0.0.0')
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`)

      const state = await getJson<RuntimeSnapshot>(`${server.url}/api/v1/state`)
      expect(state.service_status).toBe('running')
    } finally {
      await server.close()
    }
  })

  it('streams observability updates over server-sent events', async () => {
    let currentSnapshot = snapshotFixture()
    const service: SymphonyHttpService = {
      snapshot: () => currentSnapshot,
      start: async () => currentSnapshot,
      stop: async () => currentSnapshot,
      refresh: async () => currentSnapshot,
      issueDetail: () => null,
    }
    const server = await startSymphonyHttpServer({
      port: 0,
      service,
    })
    const abort = new AbortController()

    try {
      const response = await fetch(`${server.url}/api/v1/events`, { signal: abort.signal })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      expect(response.body).not.toBeNull()
      const reader = response.body!.getReader()
      const sse = createSseReader(reader)

      const first = await sse.next()
      expect(first.event).toBe('snapshot')
      expect(JSON.parse(first.data)).toMatchObject({
        service_status: 'running',
        running: [
          expect.objectContaining({
            last_message: 'dynamic tool call failed (linear_graphql)',
          }),
        ],
      })
      expect(observabilitySubscriberCount()).toBeGreaterThanOrEqual(1)

      currentSnapshot = snapshotFixture({ status: 'stopped' })
      broadcastObservabilityUpdate()
      const second = await sse.next()
      expect(second.event).toBe('snapshot')
      expect(JSON.parse(second.data)).toMatchObject({ service_status: 'stopped' })

      await reader.cancel()
      abort.abort()
      await eventually(() => observabilitySubscriberCount() === 0)
    } finally {
      abort.abort()
      await server.close()
    }
  })

  it('surfaces snapshot failures with upstream state payloads', async () => {
    const service: SymphonyHttpService = {
      snapshot: () => {
        throw new Error('snapshot store offline')
      },
      start: async () => snapshotFixture(),
      stop: async () => snapshotFixture({ status: 'stopped' }),
      refresh: async () => snapshotFixture(),
      issueDetail: () => null,
    }
    const server = await startSymphonyHttpServer({
      port: 0,
      service,
    })

    try {
      for (const pathname of ['/', '/api/v1/']) {
        const response = await fetch(`${server.url}${pathname}`)
        expect(response.status).toBe(503)
        expect(response.headers.get('content-type')).toContain('application/json')
        expect(await response.json()).toMatchObject({
          error: {
            code: 'unavailable',
            message: 'Runtime snapshot unavailable',
            details: {
              cause: 'snapshot store offline',
            },
          },
        })
      }

      const state = await fetch(`${server.url}/api/v1/state`)
      expect(state.status).toBe(200)
      expect(state.headers.get('content-type')).toContain('application/json')
      expect(await state.json()).toMatchObject({
        generated_at: expect.any(String),
        error: {
          code: 'snapshot_unavailable',
          message: 'Snapshot unavailable',
        },
      })
    } finally {
      await server.close()
    }
  })

  it('surfaces snapshot timeouts with upstream state payloads', async () => {
    const service: SymphonyHttpService = {
      snapshot: () => {
        throw new SymphonyError('snapshot_timeout', 'snapshot call timed out')
      },
      start: async () => snapshotFixture(),
      stop: async () => snapshotFixture({ status: 'stopped' }),
      refresh: async () => snapshotFixture(),
      issueDetail: () => null,
    }
    const server = await startSymphonyHttpServer({
      port: 0,
      service,
    })

    try {
      const state = await fetch(`${server.url}/api/v1/state`)
      expect(state.status).toBe(200)
      expect(state.headers.get('content-type')).toContain('application/json')
      expect(await state.json()).toMatchObject({
        generated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
        error: {
          code: 'snapshot_timeout',
          message: 'Snapshot timed out',
        },
      })
    } finally {
      await server.close()
    }
  })

  it('surfaces refresh failures as upstream orchestrator unavailable responses', async () => {
    const service: SymphonyHttpService = {
      snapshot: () => snapshotFixture(),
      start: async () => snapshotFixture(),
      stop: async () => snapshotFixture({ status: 'stopped' }),
      refresh: async () => {
        throw new Error('orchestrator mailbox offline')
      },
      issueDetail: () => null,
    }
    const server = await startSymphonyHttpServer({
      port: 0,
      service,
    })

    try {
      const response = await postJson(`${server.url}/api/v1/refresh`, {})
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        error: {
          code: 'orchestrator_unavailable',
          message: 'Orchestrator is unavailable',
        },
      })
    } finally {
      await server.close()
    }
  })
})

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  expect(response.ok).toBe(true)
  return await response.json() as T
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

function postForm(url: string, body: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  })
}

function createSseReader(reader: ReadableStreamDefaultReader<Uint8Array>): {
  next(): Promise<{ event: string; data: string }>
} {
  const decoder = new TextDecoder()
  let buffer = ''

  return {
    async next() {
      for (;;) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          return parseSseFrame(frame)
        }

        const { done, value } = await reader.read()
        if (done) {
          throw new Error('SSE stream closed before the next event')
        }
        buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n')
      }
    },
  }
}

function parseSseFrame(frame: string): { event: string; data: string } {
  let event = 'message'
  const data: Array<string> = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trimStart())
    }
  }

  return {
    event,
    data: data.join('\n'),
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  expect(predicate()).toBe(true)
}

function snapshotFixture(
  options: { status?: RuntimeSnapshot['service_status'] } = {},
): RuntimeSnapshot {
  return {
    generated_at: new Date(0).toISOString(),
    service_status: options.status ?? 'running',
    workflow_path: path.resolve('WORKFLOW.md'),
    counts: {
      running: 1,
      retrying: 1,
      blocked: 1,
      claimed: 3,
      completed: 0,
    },
    running: [
      {
        issue_id: 'issue-1',
        issue_identifier: 'SYM-1',
        issue_url: 'https://linear.app/project/sym-1',
        state: 'In Progress',
        session_id: 'thread-1-turn-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        codex_app_server_pid: '12345',
        turn_count: 1,
        last_event: 'tool_call_failed',
        last_message: 'linear_graphql',
        started_at: new Date(0).toISOString(),
        last_event_at: new Date(30_000).toISOString(),
        workspace_path: path.resolve('workspaces', 'SYM-1'),
        worker_host: null,
        status: 'StreamingTurn',
        tokens: {
          input_tokens: 1200,
          output_tokens: 340,
          total_tokens: 1540,
        },
      },
    ],
    retrying: [
      {
        issue_id: 'issue-2',
        issue_identifier: 'SYM-2',
        issue_url: null,
        attempt: 2,
        due_at: new Date(60_000).toISOString(),
        last_attempt_status: 'Failed',
        error: 'agent turn failed',
        workspace_path: path.resolve('workspaces', 'SYM-2'),
        worker_host: null,
      },
    ],
    blocked: [
      {
        issue_id: 'issue-3',
        issue_identifier: 'SYM-3',
        issue_url: null,
        state: 'Blocked',
        reason: 'tool requires user input',
        error: 'tool requires user input',
        blocked_at: new Date(45_000).toISOString(),
        workspace_path: path.resolve('workspaces', 'SYM-3'),
        worker_host: 'worker-a',
        session_id: 'thread-3-turn-1',
        thread_id: 'thread-3',
        turn_id: 'turn-1',
        codex_app_server_pid: '12346',
        last_event: 'tool_input_auto_answered',
        last_message: 'This is a non-interactive session. Operator input is unavailable.',
        last_event_at: new Date(45_000).toISOString(),
      },
    ],
    codex_totals: {
      input_tokens: 1200,
      output_tokens: 340,
      total_tokens: 1540,
      seconds_running: 75,
    },
    rate_limits: {
      primary: {
        usedPercent: 10,
        windowDurationMins: 300,
      },
    },
    polling: {
      'checking?': false,
      next_poll_in_ms: 2000,
      poll_interval_ms: 30_000,
    },
    recent_events: [],
    config_errors: [],
    last_error: null,
    config: {
      poll_interval_ms: 30_000,
      max_concurrent_agents: 1,
      workspace_root: path.resolve('workspaces'),
      worker_ssh_hosts: [],
      worker_max_concurrent_agents_per_host: null,
      active_states: ['Todo'],
      terminal_states: ['Done'],
      runner: 'simulated',
      tracker: 'mock-linear',
      server_port: 0,
      server_host: '127.0.0.1',
      observability_dashboard_enabled: true,
      observability_refresh_ms: 1000,
      observability_render_interval_ms: 16,
      logging_path: null,
    },
  }
}

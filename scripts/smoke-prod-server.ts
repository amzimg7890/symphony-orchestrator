import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

type Snapshot = {
  service_status: string
  workflow_path: string | null
  counts: {
    completed: number
    running: number
  }
  config: {
    runner: string
    tracker: string
  }
  polling: {
    'checking?': boolean
    next_poll_in_ms: number | null
    poll_interval_ms: number | null
  }
  recent_events: Array<{ event: string; issue_identifier?: string }>
}

type ApiIndex = {
  service: string
  version: string
  endpoints: {
    state: string
    control: string
    refresh: string
    events: string
  }
  snapshot: Snapshot
}

const root = process.cwd()
const serverEntry = path.join(root, '.output', 'server', 'index.mjs')
const smokeRoot = path.join(root, '.tmp', 'smoke-prod-server')
const workflowPath = path.join(smokeRoot, 'WORKFLOW.md')
const logPath = path.join(smokeRoot, 'logs', 'prod-smoke.jsonl')
const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`
let server: ChildProcess | null = null
const expectedStops = new WeakSet<ChildProcess>()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stopServer(server).finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  })
}

try {
  await removeSmokeRoot()
  await mkdir(smokeRoot, { recursive: true })
  await writeWorkflow()

  console.log(`[prod-smoke] starting built server at ${baseUrl}`)
  server = startProdServer(port)
  await waitForServer(baseUrl)

  console.log('[prod-smoke] checking dashboard and static assets')
  const dashboard = await textRequest(`${baseUrl}/`)
  assert(dashboard.includes('Symphony'), 'production dashboard should render Symphony')
  assert(dashboard.includes('Operations Dashboard'), 'production dashboard should render upstream dashboard hero')
  assert(dashboard.includes('Running sessions'), 'production dashboard should render running sessions')
  assert(dashboard.includes('Blocked sessions'), 'production dashboard should render blocked sessions')
  assert(dashboard.includes('Retry queue'), 'production dashboard should render retry queue')
  assert(dashboard.includes('Rate limits'), 'production dashboard should render rate limits')
  assert(dashboard.includes('Next refresh'), 'production dashboard should render polling state')
  const css = await textRequest(`${baseUrl}/dashboard.css`)
  assert(css.includes(':root {'), 'production server should serve dashboard.css')
  await headRequest(`${baseUrl}/dashboard.css`, {
    contentType: 'text/css',
    cacheControl: 'public, max-age=31536000',
  })
  const phoenixHtml = await textRequest(`${baseUrl}/vendor/phoenix_html/phoenix_html.js`)
  assert(phoenixHtml.includes('phoenix.link.click'), 'production server should serve phoenix_html asset')
  const phoenix = await textRequest(`${baseUrl}/vendor/phoenix/phoenix.js`)
  assert(phoenix.includes('var Phoenix = (() => {'), 'production server should serve Phoenix asset')
  await headRequest(`${baseUrl}/vendor/phoenix/phoenix.js`, {
    contentType: 'application/javascript',
    cacheControl: 'public, max-age=31536000',
  })
  const liveView = await textRequest(`${baseUrl}/vendor/phoenix_live_view/phoenix_live_view.js`)
  assert(liveView.includes('var LiveView = (() => {'), 'production server should serve LiveView asset')
  assert(liveView.includes('connect()'), 'production LiveView stub should expose connect()')
  const favicon = await bytesRequest(`${baseUrl}/favicon.png?v=prod-smoke`)
  assert(isPng(favicon), 'production server should serve favicon.png as PNG bytes')
  await headRequest(`${baseUrl}/favicon.png?v=prod-smoke`, {
    contentType: 'image/png',
    cacheControl: 'public, max-age=31536000',
  })

  console.log('[prod-smoke] checking API and SSE')
  const index = await getJson<ApiIndex>(`${baseUrl}/api/v1/`)
  await headRequest(`${baseUrl}/api/v1/`, { contentType: 'application/json' })
  await headRequest(`${baseUrl}/api/v1/state`, { contentType: 'application/json' })
  assert(index.service === 'symphony', 'production API index should identify the service')
  assert(index.version === 'v1', 'production API index should expose v1')
  assert(index.endpoints.events === '/api/v1/events', 'production API index should expose events endpoint')
  assert(index.snapshot.service_status === 'idle', 'production API index should include idle snapshot')
  assert(index.snapshot.polling['checking?'] === false, 'production API index should expose idle polling status')
  const sseSnapshot = await readSseSnapshot(`${baseUrl}/api/v1/events`)
  assert(sseSnapshot.service_status === 'idle', 'production SSE should send idle snapshot immediately')

  console.log('[prod-smoke] starting orchestrator through form control POST')
  const started = await postForm<Snapshot>(`${baseUrl}/api/v1/control`, {
    action: 'start',
    workflow_path: workflowPath,
  })
  assert(started.service_status === 'running', 'production control endpoint should start service')
  assert(started.workflow_path === workflowPath, 'production control endpoint should use requested workflow')
  assert(started.polling.poll_interval_ms === 60000, 'production control endpoint should expose polling interval')

  const completed = await waitForSnapshot(baseUrl, (snapshot) => snapshot.counts.completed >= 1)
  assert(completed.config.runner === 'simulated', 'production smoke should use simulated runner')
  assert(completed.config.tracker === 'mock-linear', 'production smoke should use mock tracker')
  assert(
    completed.recent_events.some((event) => event.event === 'worker_completed' && event.issue_identifier),
    'production smoke should complete one demo worker with issue context',
  )

  const logBody = await readFile(logPath, 'utf8')
  assert(logBody.includes('"event":"worker_completed"'), 'production smoke should write JSONL worker logs')

  console.log('[prod-smoke] stopping orchestrator')
  const stopped = await postJson<Snapshot>(`${baseUrl}/api/v1/control`, { action: 'stop' })
  assert(stopped.service_status === 'stopped', 'production control endpoint should stop service')
  assert(stopped.counts.running === 0, 'production stop should leave no running workers')

  console.log(
    JSON.stringify(
      {
        ok: true,
        base_url: baseUrl,
        workflow_path: workflowPath,
        completed: completed.counts.completed,
        log_path: logPath,
      },
      null,
      2,
    ),
  )
} finally {
  if (server) {
    await stopServer(server)
  }
  await removeSmokeRoot()
}

function startProdServer(port: number): ChildProcess {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString('utf8')}`.slice(-4000)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000)
  })
  child.once('exit', (code) => {
    if (!expectedStops.has(child) && code !== null && code !== 0) {
      console.error(stdout.trim())
      console.error(stderr.trim())
    }
  })

  return child
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(`${url}/api/v1/state`, {}, 2000)
      if (response.ok) {
        return
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }

  throw new Error(`Timed out waiting for production server: ${readError(lastError)}`)
}

async function waitForSnapshot(
  baseUrl: string,
  predicate: (snapshot: Snapshot) => boolean,
): Promise<Snapshot> {
  const deadline = Date.now() + 20_000
  let lastSnapshot: Snapshot | null = null
  while (Date.now() < deadline) {
    const snapshot = await getJson<Snapshot>(`${baseUrl}/api/v1/state`)
    lastSnapshot = snapshot
    if (predicate(snapshot)) {
      return snapshot
    }
    await delay(250)
  }

  throw new Error(`Timed out waiting for production snapshot. Last snapshot: ${JSON.stringify(lastSnapshot)}`)
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetchWithTimeout(url)
  const body = await response.json()
  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}: ${JSON.stringify(body)}`)
  }
  return body as T
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json()
  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}: ${JSON.stringify(body)}`)
  }
  return body as T
}

async function postForm<T>(url: string, payload: Record<string, string>): Promise<T> {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload).toString(),
  })
  const body = await response.json()
  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}: ${JSON.stringify(body)}`)
  }
  return body as T
}

async function readSseSnapshot(url: string): Promise<Snapshot> {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal })
  try {
    assert(response.ok, `SSE endpoint should return HTTP 200, got ${response.status}`)
    assert(
      response.headers.get('content-type')?.includes('text/event-stream'),
      'SSE endpoint should return text/event-stream',
    )
    assert(response.body, 'SSE endpoint should return a response body')
    const reader = response.body.getReader()
    let buffer = ''
    const decoder = new TextDecoder()
    try {
      while (!buffer.includes('\n\n')) {
        const { done, value } = await reader.read()
        assert(!done, 'SSE stream closed before the first event')
        buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n')
      }
    } finally {
      await reader.cancel().catch(() => {})
    }

    const frame = buffer.slice(0, buffer.indexOf('\n\n'))
    const event = frame.split('\n').find((line) => line.startsWith('event:'))?.slice('event:'.length).trim()
    const data = frame.split('\n').find((line) => line.startsWith('data:'))?.slice('data:'.length).trim()
    assert(event === 'snapshot', `SSE first event should be snapshot, got ${event ?? 'missing'}`)
    assert(data, 'SSE snapshot event should include data')
    return JSON.parse(data) as Snapshot
  } finally {
    controller.abort()
  }
}

async function textRequest(url: string): Promise<string> {
  const response = await fetchWithTimeout(url)
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}: ${body}`)
  }
  return body
}

async function headRequest(
  url: string,
  expected: { contentType: string; cacheControl?: string },
): Promise<void> {
  const response = await fetchWithTimeout(url, { method: 'HEAD' })
  assert(response.ok, `HEAD ${url} should return HTTP 200, got ${response.status}`)
  assert(
    response.headers.get('content-type')?.includes(expected.contentType),
    `HEAD ${url} should include content-type ${expected.contentType}`,
  )
  if (expected.cacheControl) {
    assert(
      response.headers.get('cache-control') === expected.cacheControl,
      `HEAD ${url} should include cache-control ${expected.cacheControl}`,
    )
  }
}

async function bytesRequest(url: string): Promise<Uint8Array> {
  const response = await fetchWithTimeout(url)
  const body = new Uint8Array(await response.arrayBuffer())
  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}: ${new TextDecoder().decode(body)}`)
  }
  return body
}

async function writeWorkflow(): Promise<void> {
  await writeFile(
    workflowPath,
    [
      '---',
      'tracker:',
      '  kind: linear',
      '  api_key: prod-smoke-token',
      '  project_slug: prod-smoke',
      '  required_labels:',
      '    - automation',
      'polling:',
      '  interval_ms: 60000',
      'workspace:',
      '  root: ./workspaces',
      'agent:',
      '  max_concurrent_agents: 1',
      '  max_turns: 1',
      'codex:',
      '  command: codex app-server',
      'logging:',
      '  root: ./logs',
      '  file: prod-smoke.jsonl',
      'demo:',
      '  mock_tracker: true',
      '---',
      'Production smoke prompt for {{ issue.identifier }}.',
      '',
    ].join('\n'),
    'utf8',
  )
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a free port')))
        return
      }
      const allocatedPort = address.port
      server.close(() => resolve(allocatedPort))
    })
  })
}

async function stopServer(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return
  }

  expectedStops.add(child)
  const exited = waitForExit(child, 5000)
  child.kill('SIGINT')
  try {
    await exited
  } catch {
    child.kill()
    await waitForExit(child, 5000).catch(() => {})
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      reject(new Error(`Timed out waiting for child process ${child.pid ?? 'unknown'} to exit`))
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve()
    }
    child.once('exit', onExit)
  })
}

async function removeSmokeRoot(): Promise<void> {
  await rm(smokeRoot, { recursive: true, force: true })
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.slice(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

type Snapshot = {
  service_status: string
  workflow_path: string | null
  counts: {
    running: number
    retrying: number
    blocked: number
    claimed: number
    completed: number
  }
  config_errors: Array<{ code: string; message: string }>
  recent_events: Array<{ event: string; message: string; issue_identifier?: string }>
  config: {
    runner: string
    tracker: string
    workspace_root: string | null
  }
  polling: {
    'checking?': boolean
    next_poll_in_ms: number | null
    poll_interval_ms: number | null
  }
}

type ApiIndex = {
  service: string
  version: string
  dashboard: string
  endpoints: {
    state: string
    control: string
    refresh: string
    events: string
    issue_detail: string
  }
  snapshot: Snapshot
}

const root = process.cwd()
const smokeRoot = path.join(root, '.tmp', 'smoke-dev-server')
const workflowPath = path.join(smokeRoot, 'WORKFLOW.md')
const logPath = path.join(smokeRoot, 'logs', 'smoke.jsonl')
const requestTimeoutMs = 10_000

const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`
let server: ChildProcess | null = null
const expectedStops = new WeakSet<ChildProcess>()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stopDevServer(server).finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  })
}

try {
  console.log(`[smoke] preparing workflow at ${workflowPath}`)
  await removeSmokeRoot()
  await mkdir(smokeRoot, { recursive: true })
  await writeWorkflow({ maxConcurrentAgents: 1 })
  console.log(`[smoke] starting Vite dev server at ${baseUrl}`)
  server = startDevServer(port)
  await waitForServer(baseUrl)

  console.log('[smoke] checking dashboard HTML')
  const html = await textRequest(`${baseUrl}/`)
  assert(html.includes('Symphony'), 'dashboard HTML should include Symphony')
  assert(html.includes('Operations Dashboard'), 'dashboard HTML should include the upstream dashboard hero')
  assert(html.includes('Running sessions'), 'dashboard HTML should include running sessions')
  assert(html.includes('Blocked sessions'), 'dashboard HTML should include blocked sessions')
  assert(html.includes('Retry queue'), 'dashboard HTML should include retry queue')
  assert(html.includes('Rate limits'), 'dashboard HTML should include rate limits')
  assert(html.includes('Next refresh'), 'dashboard HTML should include polling state')

  console.log('[smoke] checking upstream-compatible static assets')
  const dashboardCss = await textRequest(`${baseUrl}/dashboard.css`)
  assert(dashboardCss.includes(':root {'), 'dashboard CSS asset should be served by TanStack runtime')
  await headRequest(`${baseUrl}/dashboard.css`, {
    contentType: 'text/css',
    cacheControl: 'public, max-age=31536000',
  })
  const phoenixJs = await textRequest(`${baseUrl}/vendor/phoenix/phoenix.js`)
  assert(phoenixJs.includes('var Phoenix = (() => {'), 'Phoenix vendor asset should be served by TanStack runtime')
  await headRequest(`${baseUrl}/vendor/phoenix/phoenix.js`, {
    contentType: 'application/javascript',
    cacheControl: 'public, max-age=31536000',
  })
  const liveViewJs = await textRequest(`${baseUrl}/vendor/phoenix_live_view/phoenix_live_view.js`)
  assert(
    liveViewJs.includes('var LiveView = (() => {'),
    'LiveView vendor asset should be served by TanStack runtime',
  )
  assert(liveViewJs.includes('connect()'), 'LiveView vendor stub should expose connect()')
  const favicon = await bytesRequest(`${baseUrl}/favicon.png?v=smoke`)
  assert(
    favicon.slice(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index]),
    'favicon asset should be served as a PNG by TanStack runtime',
  )
  await headRequest(`${baseUrl}/favicon.png?v=smoke`, {
    contentType: 'image/png',
    cacheControl: 'public, max-age=31536000',
  })

  console.log('[smoke] checking API index')
  const apiIndex = await getJson<ApiIndex>(`${baseUrl}/api/v1/`)
  await headRequest(`${baseUrl}/api/v1/`, { contentType: 'application/json' })
  await headRequest(`${baseUrl}/api/v1/state`, { contentType: 'application/json' })
  assert(apiIndex.service === 'symphony', 'API index should identify the service')
  assert(apiIndex.version === 'v1', 'API index should identify API version')
  assert(apiIndex.dashboard === '/', 'API index should point at the dashboard')
  assert(apiIndex.endpoints.state === '/api/v1/state', 'API index should link state endpoint')
  assert(apiIndex.endpoints.control === '/api/v1/control', 'API index should link control endpoint')
  assert(apiIndex.endpoints.refresh === '/api/v1/refresh', 'API index should link refresh endpoint')
  assert(apiIndex.endpoints.events === '/api/v1/events', 'API index should link events endpoint')
  assert(apiIndex.endpoints.issue_detail === '/api/v1/{issue_identifier}', 'API index should describe issue detail endpoint')
  assert(apiIndex.snapshot.service_status === 'idle', 'API index should include current snapshot')
  assert(apiIndex.snapshot.polling['checking?'] === false, 'API index snapshot should expose idle polling status')

  console.log('[smoke] checking observability SSE')
  const eventSnapshot = await readSseSnapshot(`${baseUrl}/api/v1/events`)
  assert(eventSnapshot.service_status === 'idle', 'SSE should send the current snapshot immediately')

  console.log('[smoke] checking invalid control action')
  const invalidControl = await postJsonResponse<{ error: { code: string; message: string } }>(
    `${baseUrl}/api/v1/control`,
    { action: 'restart' },
  )
  assert(invalidControl.status === 400, 'invalid control action should return HTTP 400')
  assert(
    invalidControl.body.error.code === 'invalid_control_action',
    'invalid control action should return a typed error',
  )

  console.log('[smoke] checking API method-not-allowed responses')
  const stateMethodNotAllowed = await requestJsonResponse<{ error: { code: string; message: string } }>(
    `${baseUrl}/api/v1/state`,
    { method: 'POST' },
  )
  assert(stateMethodNotAllowed.status === 405, 'POST /api/v1/state should return HTTP 405')
  assert(
    stateMethodNotAllowed.body.error.code === 'method_not_allowed',
    'POST /api/v1/state should return a typed method_not_allowed error',
  )
  assert(
    stateMethodNotAllowed.body.error.message === 'Method not allowed',
    'POST /api/v1/state should use the upstream method-not-allowed message',
  )
  assert(
    stateMethodNotAllowed.headers.get('allow') === 'GET, HEAD',
    'POST /api/v1/state should advertise GET and HEAD in Allow',
  )

  const refreshMethodNotAllowed = await requestJsonResponse<{ error: { code: string; message: string } }>(
    `${baseUrl}/api/v1/refresh`,
    { method: 'GET' },
  )
  assert(refreshMethodNotAllowed.status === 405, 'GET /api/v1/refresh should return HTTP 405')
  assert(
    refreshMethodNotAllowed.body.error.code === 'method_not_allowed',
    'GET /api/v1/refresh should return a typed method_not_allowed error',
  )
  assert(
    refreshMethodNotAllowed.body.error.message === 'Method not allowed',
    'GET /api/v1/refresh should use the upstream method-not-allowed message',
  )
  assert(
    refreshMethodNotAllowed.headers.get('allow') === 'POST',
    'GET /api/v1/refresh should advertise POST in Allow',
  )

  console.log('[smoke] checking API not-found response')
  const unknownApiRoute = await requestJsonResponse<{ error: { code: string; message: string } }>(
    `${baseUrl}/api/v1/SYM-1/extra`,
  )
  assert(unknownApiRoute.status === 404, 'unknown /api/v1/* route should return HTTP 404')
  assert(
    unknownApiRoute.body.error.code === 'not_found',
    'unknown /api/v1/* route should return a typed not_found error',
  )
  assert(
    unknownApiRoute.body.error.message === 'Route not found',
    'unknown /api/v1/* route should use the upstream route-not-found message',
  )

  console.log('[smoke] starting orchestrator with form control POST')
  const started = await postForm<Snapshot>(`${baseUrl}/api/v1/control`, {
    action: 'start',
    workflow_path: workflowPath,
  })
  assert(started.service_status === 'running', 'service should start')
  assert(started.workflow_path === workflowPath, 'service should use smoke workflow')
  assert(started.polling.poll_interval_ms === 60000, 'started snapshot should expose polling interval')

  console.log('[smoke] waiting for demo worker completion')
  const completed = await waitForSnapshot(baseUrl, (snapshot) => snapshot.counts.completed >= 1)
  assert(completed.config.runner === 'simulated', 'smoke should use simulated runner')
  assert(completed.config.tracker === 'mock-linear', 'smoke should use mock Linear tracker')
  assert(
    completed.recent_events.some((event) => event.event === 'worker_completed'),
    'smoke should complete a demo worker',
  )
  const completedIssueIdentifier = completed.recent_events.find(
    (event) => event.event === 'worker_completed',
  )?.issue_identifier
  assert(completedIssueIdentifier, 'worker_completed event should include an issue identifier')

  console.log('[smoke] checking completed issue detail API')
  const completedIssue = await requestJsonResponse<{ error: { code: string; message: string } }>(
    `${baseUrl}/api/v1/${encodeURIComponent(completedIssueIdentifier)}`,
  )
  assert(completedIssue.status === 404, 'completed issue detail should return HTTP 404 like upstream')
  assert(completedIssue.body.error.code === 'issue_not_found', 'completed issue detail should use issue_not_found')
  assert(
    completedIssue.body.error.message === 'Issue not found',
    'completed issue detail should use the upstream issue-not-found message',
  )
  const missingIssue = await requestJsonResponse<{ error: { code: string; message: string } }>(
    `${baseUrl}/api/v1/NOPE-1`,
  )
  assert(missingIssue.status === 404, 'missing issue detail should return HTTP 404')
  assert(missingIssue.body.error.code === 'issue_not_found', 'missing issue detail should use issue_not_found')
  assert(
    missingIssue.body.error.message === 'Issue not found',
    'missing issue detail should use the upstream issue-not-found message',
  )

  console.log('[smoke] checking invalid reload')
  await writeWorkflow({ maxConcurrentAgents: 0 })
  const invalidReload = await postJson<{ snapshot: Snapshot }>(`${baseUrl}/api/v1/refresh`, {})
  assert(
    invalidReload.snapshot.config_errors.some(
      (error) =>
        error.code === 'invalid_config' &&
        error.message === 'agent.max_concurrent_agents must be a positive integer',
    ),
    'invalid reload should surface config_errors',
  )

  console.log('[smoke] checking valid reload recovery')
  await writeWorkflow({ maxConcurrentAgents: 1 })
  const validReload = await postJson<{ snapshot: Snapshot }>(`${baseUrl}/api/v1/refresh`, {})
  assert(validReload.snapshot.config_errors.length === 0, 'valid reload should clear config_errors')

  console.log('[smoke] checking JSONL logs')
  const logBody = await readFile(logPath, 'utf8')
  const logEvents = logBody.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
    event: string
    issue_id?: string
    issue_identifier?: string
    session_id?: string
  })
  assert(logEvents.some((event) => event.event === 'workflow_loaded'), 'log should include workflow_loaded')
  assert(
    logEvents.some((event) => event.event === 'dispatch_started' && event.issue_id && event.issue_identifier),
    'dispatch log should include issue context',
  )
  assert(
    logEvents.some((event) => event.event === 'session_started' && event.issue_id && event.issue_identifier && event.session_id),
    'session log should include issue and session context',
  )
  assert(
    logEvents.some((event) => event.event === 'worker_completed' && event.issue_id && event.issue_identifier),
    'worker completion log should include issue context',
  )

  console.log('[smoke] stopping orchestrator')
  const stopped = await postJson<Snapshot>(`${baseUrl}/api/v1/control`, { action: 'stop' })
  assert(stopped.service_status === 'stopped', 'service should stop')
  assert(stopped.counts.running === 0, 'no workers should remain running after stop')

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
    await stopDevServer(server)
  }
  await removeSmokeRoot()
}

function startDevServer(port: number): ChildProcess {
  const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  const child = spawn(process.execPath, [viteBin, 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: root,
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

async function waitForServer(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/api/v1/state`, {}, 2000)
      if (response.ok) {
        return
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }

  throw new Error(`Timed out waiting for dev server: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
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

  throw new Error(`Timed out waiting for snapshot predicate. Last snapshot: ${JSON.stringify(lastSnapshot)}`)
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
  const { response, body } = await postJsonRaw<T>(url, payload)
  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}: ${JSON.stringify(body)}`)
  }
  return body
}

async function postForm<T>(url: string, payload: Record<string, string>): Promise<T> {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload).toString(),
  })
  const body = await response.json() as T
  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}: ${JSON.stringify(body)}`)
  }
  return body
}

async function postJsonResponse<T>(url: string, payload: unknown): Promise<{ status: number; body: T }> {
  const { response, body } = await postJsonRaw<T>(url, payload)
  return {
    status: response.status,
    body,
  }
}

async function requestJsonResponse<T>(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; headers: Headers; body: T }> {
  const response = await fetchWithTimeout(url, init)
  const body = await response.json()
  return {
    status: response.status,
    headers: response.headers,
    body: body as T,
  }
}

async function postJsonRaw<T>(
  url: string,
  payload: unknown,
): Promise<{ response: Response; body: T }> {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json()
  return { response, body: body as T }
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

async function writeWorkflow(args: { maxConcurrentAgents: number }): Promise<void> {
  await writeFile(
    workflowPath,
    [
      '---',
      'tracker:',
      '  kind: linear',
      '  api_key: demo-token',
      '  project_slug: demo',
      '  required_labels:',
      '    - automation',
      'polling:',
      '  interval_ms: 60000',
      'workspace:',
      '  root: ./workspaces',
      'agent:',
      `  max_concurrent_agents: ${args.maxConcurrentAgents}`,
      '  max_turns: 1',
      'codex:',
      '  command: codex app-server',
      'logging:',
      '  root: ./logs',
      '  file: smoke.jsonl',
      'demo:',
      '  mock_tracker: true',
      '---',
      'Smoke prompt for {{ issue.identifier }}.',
      '',
    ].join('\n'),
    'utf8',
  )
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

async function stopDevServer(child: ChildProcess | null): Promise<void> {
  if (!child) {
    return
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  expectedStops.add(child)
  const exited = waitForExit(child, 5000)
  if (process.platform === 'win32' && child.pid) {
    await runCommand('taskkill', ['/pid', String(child.pid), '/t', '/f'], 5000).catch(() => {
      child.kill()
    })
  } else {
    child.kill()
  }

  await exited
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = requestTimeoutMs,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function runCommand(
  executable: string,
  args: Array<string>,
  timeoutMs: number,
): Promise<void> {
  const child = spawn(executable, args, {
    cwd: root,
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

async function removeSmokeRoot(): Promise<void> {
  await rm(smokeRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  })
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

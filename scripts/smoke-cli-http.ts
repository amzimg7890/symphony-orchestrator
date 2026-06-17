import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'

type CliChild = ChildProcessByStdio<null, Readable, Readable>

const root = process.cwd()
const smokeRoot = path.join(root, '.tmp', 'cli-http-smoke')
const workflowPath = path.join(smokeRoot, 'WORKFLOW.md')
const logsRoot = path.join(smokeRoot, 'logs')

let child: CliChild | null = null

try {
  await rm(smokeRoot, { recursive: true, force: true })
  await mkdir(smokeRoot, { recursive: true })
  await writeFile(workflowPath, workflowFixture(), 'utf8')

  const cli = spawn(process.execPath, [
    '--import',
    'tsx',
    'src/cli.ts',
    workflowPath,
    '--logs-root',
    logsRoot,
    '--port',
    '0',
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child = cli

  const url = await waitForHttpUrl(cli)

  const dashboard = await getText(`${url}/`)
  assert(dashboard.includes('Symphony'), 'CLI HTTP dashboard should render Symphony HTML')
  assert(dashboard.includes('Operations Dashboard'), 'CLI HTTP dashboard should render the upstream dashboard hero')
  assert(dashboard.includes('Running sessions'), 'CLI HTTP dashboard should render running sessions')
  assert(dashboard.includes('Blocked sessions'), 'CLI HTTP dashboard should render blocked sessions')
  assert(dashboard.includes('Retry queue'), 'CLI HTTP dashboard should render retry queue')
  assert(dashboard.includes('Rate limits'), 'CLI HTTP dashboard should render rate limits')
  assert(dashboard.includes('Next refresh'), 'CLI HTTP dashboard should render polling state')
  assert(
    /\/dashboard\.css\?v=[0-9a-f]{12}/.test(dashboard),
    'CLI HTTP dashboard should reference the upstream-style dashboard CSS asset URL',
  )
  assert(
    /\/favicon\.png\?v=[0-9a-f]{12}/.test(dashboard),
    'CLI HTTP dashboard should reference the upstream-style favicon asset URL',
  )
  assert(dashboard.includes('/vendor/phoenix_html/phoenix_html.js'), 'CLI HTTP dashboard should reference phoenix_html')
  assert(dashboard.includes('/vendor/phoenix/phoenix.js'), 'CLI HTTP dashboard should reference phoenix')
  assert(
    dashboard.includes('/vendor/phoenix_live_view/phoenix_live_view.js'),
    'CLI HTTP dashboard should reference phoenix_live_view',
  )
  assert(dashboard.includes('meta name="csrf-token"'), 'CLI HTTP dashboard should include upstream LiveView csrf meta')
  assert(dashboard.includes('new window.LiveView.LiveSocket("/live"'), 'CLI HTTP dashboard should bootstrap LiveView')

  const dashboardCss = await getText(`${url}/dashboard.css`)
  assert(dashboardCss.includes(':root {'), 'CLI HTTP dashboard CSS should be served')
  const liveViewJs = await getText(`${url}/vendor/phoenix_live_view/phoenix_live_view.js`)
  assert(liveViewJs.includes('var LiveView = (() => {'), 'CLI HTTP LiveView asset should be served')
  assert(liveViewJs.includes('connect()'), 'CLI HTTP LiveView stub should expose connect()')
  const favicon = await getBytes(`${url}/favicon.png?v=smoke`)
  assert(
    favicon.slice(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index]),
    'CLI HTTP favicon should be a PNG',
  )

  const index = await getJson<{ service: string; endpoints: { state: string } }>(`${url}/api/v1/`)
  assert(index.service === 'symphony', 'CLI HTTP API index should identify Symphony')
  assert(index.endpoints.state === '/api/v1/state', 'CLI HTTP API index should expose state endpoint')

  const state = await getJson<{
    service_status: string
    config: {
      server_port: number | null
      server_host: string | null
      observability_dashboard_enabled: boolean | null
      observability_refresh_ms: number | null
    }
    polling: {
      'checking?': boolean
      next_poll_in_ms: number | null
      poll_interval_ms: number | null
    }
  }>(`${url}/api/v1/state`)
  assert(state.service_status === 'running', 'CLI HTTP state should report the running service')
  assert(state.polling.poll_interval_ms === 10000, 'CLI HTTP state should expose polling interval')
  assert(typeof state.polling['checking?'] === 'boolean', 'CLI HTTP state should expose polling checking status')
  assert(
    state.polling['checking?'] || typeof state.polling.next_poll_in_ms === 'number',
    'CLI HTTP state should expose checking status or next poll countdown',
  )
  assert(state.config.server_port === 0, 'CLI runtime snapshot should preserve the requested ephemeral port')
  assert(state.config.server_host === '127.0.0.1', 'CLI runtime snapshot should expose the default host')
  assert(state.config.observability_dashboard_enabled === true, 'CLI snapshot should expose dashboard_enabled')
  assert(state.config.observability_refresh_ms === 750, 'CLI snapshot should expose observability refresh interval')

  const refresh = await postFormJson<{ queued: boolean }>(`${url}/api/v1/refresh`, {})
  assert(refresh.status === 202, 'CLI HTTP form refresh should return HTTP 202')
  assert(refresh.body.queued === true, 'CLI HTTP form refresh should queue refresh work')

  const stateMethodNotAllowed = await requestJson<{
    error: { code: string; message: string }
  }>(`${url}/api/v1/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '',
  })
  assert(stateMethodNotAllowed.status === 405, 'CLI HTTP POST /api/v1/state should return HTTP 405')
  assert(
    stateMethodNotAllowed.body.error.code === 'method_not_allowed',
    'CLI HTTP POST /api/v1/state should return method_not_allowed',
  )
  assert(
    stateMethodNotAllowed.body.error.message === 'Method not allowed',
    'CLI HTTP POST /api/v1/state should use the upstream method-not-allowed message',
  )

  console.log(
    JSON.stringify(
      {
        ok: true,
        url,
        workflow_path: workflowPath,
        service_status: state.service_status,
        requested_port: state.config.server_port,
        bind_host: state.config.server_host,
        polling: state.polling,
        dashboard_refresh_ms: state.config.observability_refresh_ms,
        static_assets_checked: true,
        form_refresh_checked: true,
      },
      null,
      2,
    ),
  )
} finally {
  if (child) {
    await stopCli(child)
  }
  await rm(smokeRoot, { recursive: true, force: true })
}

function workflowFixture(): string {
  return [
    '---',
    'tracker:',
    '  kind: linear',
    '  api_key: cli-http-smoke-token',
    '  project_slug: cli-http-smoke',
    '  required_labels:',
    '    - automation',
    'polling:',
    '  interval_ms: 10000',
    'agent:',
    '  runner: simulated',
    '  max_concurrent_agents: 1',
    '  max_turns: 1',
    'logging:',
    '  enabled: true',
    '  root: ./logs',
    'observability:',
    '  dashboard_enabled: true',
    '  refresh_ms: 750',
    '  render_interval_ms: 16',
    'demo:',
    '  mock_tracker: true',
    '---',
    'CLI HTTP smoke for {{ issue.identifier }}.',
    '',
  ].join('\n')
}

async function waitForHttpUrl(child: CliChild): Promise<string> {
  let stdout = ''
  let stderr = ''

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for CLI HTTP URL. stdout=${stdout} stderr=${stderr}`))
    }, 20_000)

    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const match = stdout.match(/HTTP: (http:\/\/127\.0\.0\.1:\d+)/)
      if (match?.[1]) {
        cleanup()
        resolve(match[1])
      }
    }
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(`CLI exited before HTTP URL (${code ?? signal}). stdout=${stdout} stderr=${stderr}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', onStdout)
      child.stderr.off('data', onStderr)
      child.off('exit', onExit)
    }

    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('exit', onExit)
  })
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json()
  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}: ${JSON.stringify(body)}`)
  }

  return body as T
}

async function getText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}: ${body}`)
  }

  return body
}

async function getBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  })
  const body = new Uint8Array(await response.arrayBuffer())
  if (!response.ok) {
    throw new Error(`${url} failed with HTTP ${response.status}: ${new TextDecoder().decode(body)}`)
  }

  return body
}

async function postFormJson<T>(
  url: string,
  payload: Record<string, string>,
): Promise<{ status: number; body: T }> {
  return await requestJson<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload).toString(),
  })
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json()
  return {
    status: response.status,
    body: body as T,
  }
}

async function stopCli(child: CliChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  const exited = waitForExit(child, 5000)
  child.kill('SIGINT')
  try {
    await exited
  } catch {
    child.kill()
    await waitForExit(child, 5000).catch(() => {})
  }
}

async function waitForExit(child: CliChild, timeoutMs: number): Promise<void> {
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

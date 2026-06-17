import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { SymphonyError } from './errors'
import {
  currentIssueDetailPayload,
  errorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  orchestratorUnavailableResponse,
  readRequestBody,
  routeNotFoundResponse,
  snapshotStateErrorResponse,
  unavailableResponse,
} from './http'
import { subscribeObservabilityUpdates } from './observability'
import { presentRuntimeSnapshot } from './presenter'
import { defaultWorkflowPath, getSymphonyService } from './service'
import { DASHBOARD_CSS_DIGEST, FAVICON_DIGEST, staticAssetResponse } from './staticAssets'
import { dashboardBody } from './dashboardHtml'
import type { RuntimeSnapshot } from './types'

export type SymphonyHttpService = {
  snapshot(): RuntimeSnapshot
  start(workflowPath: string): Promise<RuntimeSnapshot>
  stop(): Promise<RuntimeSnapshot>
  refresh(): Promise<RuntimeSnapshot>
  issueDetail(identifier: string): unknown | null
}

export type SymphonyHttpServer = {
  host: string
  port: number
  url: string
  close(): Promise<void>
}

export async function startSymphonyHttpServer(options: {
  port: number
  host?: string
  service?: SymphonyHttpService
  defaultWorkflowPath?: () => string
}): Promise<SymphonyHttpServer> {
  const host = normalizeBindHost(options.host)
  const service = options.service ?? getSymphonyService()
  const resolveDefaultWorkflowPath = options.defaultWorkflowPath ?? defaultWorkflowPath
  const server = createServer((request, response) => {
    void respondToNodeRequest(request, response, service, resolveDefaultWorkflowPath)
  })

  await listen(server, options.port, host)
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : options.port

  return {
    host,
    port: actualPort,
    url: `http://${urlHost(host)}:${actualPort}`,
    close: async () => {
      if (!server.listening) {
        return
      }

      server.close()
      await once(server, 'close')
    },
  }
}

export async function handleSymphonyHttpRequest(
  service: SymphonyHttpService,
  request: Request,
  options: { defaultWorkflowPath?: () => string } = {},
): Promise<Response> {
  const url = new URL(request.url)
  const method = request.method.toUpperCase()
  const readMethod = method === 'GET' || method === 'HEAD'
  const resolveDefaultWorkflowPath = options.defaultWorkflowPath ?? defaultWorkflowPath

  try {
    if (url.pathname === '/') {
      if (!readMethod) {
        return methodNotAllowedResponse(request, ['GET'])
      }

      return snapshotResponse(service, dashboardResponse)
    }

    const staticAsset = staticAssetResponse(url.pathname)
    if (staticAsset) {
      if (!readMethod) {
        return methodNotAllowedResponse(request, ['GET'])
      }

      return staticAsset
    }

    if (url.pathname === '/api/v1/' || url.pathname === '/api/v1') {
      if (!readMethod) {
        return methodNotAllowedResponse(request, ['GET'])
      }

      return snapshotResponse(service, (snapshot) => jsonResponse(apiIndex(snapshot)))
    }

    if (url.pathname === '/api/v1/state') {
      if (!readMethod) {
        return methodNotAllowedResponse(request, ['GET'])
      }

      return stateResponse(service)
    }

    if (url.pathname === '/api/v1/events') {
      if (!readMethod) {
        return methodNotAllowedResponse(request, ['GET'])
      }

      return observabilityEventsResponse(service)
    }

    if (url.pathname === '/api/v1/control') {
      if (method !== 'POST') {
        return methodNotAllowedResponse(request, ['POST'])
      }

      const body = await readRequestBody(request)
      const action = typeof body.action === 'string' ? body.action : undefined
      if (body.action !== undefined && action !== 'start' && action !== 'stop') {
        throw new SymphonyError('invalid_control_action', 'control.action must be "start" or "stop"')
      }

      if (action === 'stop') {
        return jsonResponse(await service.stop())
      }

      const workflowPath =
        typeof body.workflow_path === 'string' && body.workflow_path.trim()
          ? body.workflow_path
          : resolveDefaultWorkflowPath()
      return jsonResponse(await service.start(workflowPath), { status: 202 })
    }

    if (url.pathname === '/api/v1/refresh') {
      if (method !== 'POST') {
        return methodNotAllowedResponse(request, ['POST'])
      }

      let snapshot: RuntimeSnapshot
      try {
        snapshot = await service.refresh()
      } catch (error) {
        return orchestratorUnavailableResponse()
      }

      return jsonResponse({
        queued: true,
        coalesced: false,
        requested_at: new Date().toISOString(),
        operations: ['poll', 'reconcile'],
        snapshot: presentRuntimeSnapshot(snapshot),
      }, { status: 202 })
    }

    const issuePrefix = '/api/v1/'
    if (url.pathname.startsWith(issuePrefix) && url.pathname.length > issuePrefix.length) {
      if (!readMethod) {
        return methodNotAllowedResponse(request, ['GET'])
      }

      const rawIssueIdentifier = url.pathname.slice(issuePrefix.length)
      if (rawIssueIdentifier.includes('/')) {
        return routeNotFoundResponse()
      }

      let issueIdentifier: string
      try {
        issueIdentifier = decodeURIComponent(rawIssueIdentifier)
      } catch {
        return routeNotFoundResponse()
      }
      if (issueIdentifier.includes('/')) {
        return routeNotFoundResponse()
      }

      const detail = service.issueDetail(issueIdentifier)
      return jsonResponse(currentIssueDetailPayload(detail))
    }

    return routeNotFoundResponse()
  } catch (error) {
    return errorResponse(error)
  }
}

function snapshotResponse(
  service: Pick<SymphonyHttpService, 'snapshot'>,
  render: (snapshot: RuntimeSnapshot) => Response,
): Response {
  try {
    return render(service.snapshot())
  } catch (error) {
    return unavailableResponse(error)
  }
}

function stateResponse(service: Pick<SymphonyHttpService, 'snapshot'>): Response {
  try {
    return jsonResponse(presentRuntimeSnapshot(service.snapshot()))
  } catch (error) {
    return snapshotStateErrorResponse(error)
  }
}

async function respondToNodeRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  service: SymphonyHttpService,
  resolveDefaultWorkflowPath: () => string,
): Promise<void> {
  try {
    const request = await requestFromIncoming(incoming)
    const response = await handleSymphonyHttpRequest(service, request, {
      defaultWorkflowPath: resolveDefaultWorkflowPath,
    })
    await sendNodeResponse(outgoing, response, incoming.method?.toUpperCase() === 'HEAD')
  } catch (error) {
    await sendNodeResponse(outgoing, errorResponse(error), false)
  }
}

function dashboardResponse(snapshot: RuntimeSnapshot): Response {
  const body = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="csrf-token" content="">',
    '<title>Symphony Observability</title>',
    `<link rel="icon" type="image/png" sizes="128x128" href="/favicon.png?v=${FAVICON_DIGEST}">`,
    '<script defer src="/vendor/phoenix_html/phoenix_html.js"></script>',
    '<script defer src="/vendor/phoenix/phoenix.js"></script>',
    '<script defer src="/vendor/phoenix_live_view/phoenix_live_view.js"></script>',
    '<script>window.addEventListener("DOMContentLoaded", function () { var csrfToken = document.querySelector("meta[name=\'csrf-token\']")?.getAttribute("content"); if (!window.Phoenix || !window.LiveView) return; var liveSocket = new window.LiveView.LiveSocket("/live", window.Phoenix.Socket, { params: { _csrf_token: csrfToken } }); liveSocket.connect(); window.liveSocket = liveSocket; });</script>',
    `<link rel="stylesheet" href="/dashboard.css?v=${DASHBOARD_CSS_DIGEST}">`,
    '</head>',
    '<body>',
    dashboardBody(snapshot),
    '</body>',
    '</html>',
  ].join('')

  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  })
}

function apiIndex(snapshot: RuntimeSnapshot): Record<string, unknown> {
  return {
    service: 'symphony',
    version: 'v1',
    dashboard: '/',
    endpoints: {
      state: '/api/v1/state',
      control: '/api/v1/control',
      refresh: '/api/v1/refresh',
      events: '/api/v1/events',
      issue_detail: '/api/v1/{issue_identifier}',
    },
    snapshot: presentRuntimeSnapshot(snapshot),
  }
}

async function requestFromIncoming(incoming: IncomingMessage): Promise<Request> {
  const host = incoming.headers.host ?? '127.0.0.1'
  const body = await readIncomingBody(incoming)
  const method = incoming.method ?? 'GET'

  return new Request(`http://${host}${incoming.url ?? '/'}`, {
    method,
    headers: headersFromIncoming(incoming),
    body: method === 'GET' || method === 'HEAD' || !body ? undefined : new Uint8Array(body),
  })
}

async function readIncomingBody(incoming: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Array<Buffer> = []
  for await (const chunk of incoming) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return chunks.length > 0 ? Buffer.concat(chunks) : undefined
}

function headersFromIncoming(incoming: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item)
      }
    } else if (value !== undefined) {
      headers.set(key, value)
    }
  }

  return headers
}

async function sendNodeResponse(
  outgoing: ServerResponse,
  response: Response,
  omitBody: boolean,
): Promise<void> {
  response.headers.forEach((value, key) => {
    outgoing.setHeader(key, value)
  })
  outgoing.writeHead(response.status)
  if (omitBody) {
    outgoing.end()
    return
  }

  if (!response.body) {
    outgoing.end()
    return
  }

  const reader = response.body.getReader()
  outgoing.once('close', () => {
    void reader.cancel().catch(() => {})
  })

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value && !outgoing.write(Buffer.from(value))) {
        await once(outgoing, 'drain')
      }
    }
  } catch (error) {
    if (!outgoing.destroyed) {
      throw error
    }
  } finally {
    if (!outgoing.destroyed && !outgoing.writableEnded) {
      outgoing.end()
    }
  }
}

export function observabilityEventsResponse(
  service: Pick<SymphonyHttpService, 'snapshot'>,
): Response {
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sendSnapshot = () => {
        try {
          controller.enqueue(sseFrame(encoder, 'snapshot', presentRuntimeSnapshot(service.snapshot())))
        } catch (error) {
          controller.enqueue(
            sseFrame(encoder, 'error', {
              error: {
                code: 'unavailable',
                message: 'Runtime snapshot unavailable',
                details: {
                  cause: error instanceof Error ? error.message : String(error),
                },
              },
            }),
          )
        }
      }

      sendSnapshot()
      unsubscribe = subscribeObservabilityUpdates(sendSnapshot)
    },
    cancel() {
      unsubscribe?.()
      unsubscribe = null
    },
  })

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  })
}

function sseFrame(encoder: TextEncoder, event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error)
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

function normalizeBindHost(host: string | undefined): string {
  const trimmed = host?.trim() || '127.0.0.1'
  const normalized = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
  if (!isValidBindHost(normalized)) {
    throw new SymphonyError('invalid_config', `server.host is invalid: ${trimmed}`)
  }

  return normalized
}

function isValidBindHost(host: string): boolean {
  if (isIP(host) !== 0 || host === 'localhost') {
    return true
  }

  return /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/.test(host)
}

function urlHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '[::]' || host === '') {
    return '127.0.0.1'
  }

  if (host.includes(':')) {
    return `[${host.replace(/^\[(.*)\]$/, '$1')}]`
  }

  return host
}

import { SymphonyError, toErrorPayload } from './errors'
import { presentIssueDetailSnapshot } from './presenter'

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

export function errorResponse(error: unknown, status = statusForError(error)): Response {
  return jsonResponse(
    {
      error: toErrorPayload(error),
    },
    { status },
  )
}

export function methodNotAllowedResponse(
  request: Request,
  allowedMethods: Array<string>,
): Response {
  const allow = allowedMethodHeader(allowedMethods)
  return jsonResponse(
    {
      error: {
        code: 'method_not_allowed',
        message: 'Method not allowed',
      },
    },
    {
      status: 405,
      headers: {
        Allow: allow,
      },
    },
  )
}

export function routeNotFoundResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: 'not_found',
        message: 'Route not found',
      },
    },
    { status: 404 },
  )
}

export function unavailableResponse(
  error: unknown,
  message = 'Runtime snapshot unavailable',
): Response {
  return jsonResponse(
    {
      error: {
        code: 'unavailable',
        message,
        details: {
          cause: errorMessage(error),
        },
      },
    },
    { status: 503 },
  )
}

export function snapshotUnavailableResponse(): Response {
  return jsonResponse({
    generated_at: generatedAtIsoSeconds(),
    error: {
      code: 'snapshot_unavailable',
      message: 'Snapshot unavailable',
    },
  })
}

export function snapshotTimeoutResponse(): Response {
  return jsonResponse({
    generated_at: generatedAtIsoSeconds(),
    error: {
      code: 'snapshot_timeout',
      message: 'Snapshot timed out',
    },
  })
}

export function snapshotStateErrorResponse(error: unknown): Response {
  if (error instanceof SymphonyError && error.code === 'snapshot_timeout') {
    return snapshotTimeoutResponse()
  }

  return snapshotUnavailableResponse()
}

export function orchestratorUnavailableResponse(): Response {
  return jsonResponse(
    {
      error: {
        code: 'orchestrator_unavailable',
        message: 'Orchestrator is unavailable',
      },
    },
    { status: 503 },
  )
}

export function currentIssueDetailPayload(detail: unknown): unknown {
  if (isCurrentIssueDetailPayload(detail)) {
    return presentIssueDetailSnapshot(detail)
  }

  throw new SymphonyError('issue_not_found', 'Issue not found')
}

export async function readRequestBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (!text.trim()) {
    return {}
  }

  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text).entries())
  }

  try {
    const parsed = JSON.parse(text) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function statusForError(error: unknown): number {
  if (error instanceof SymphonyError) {
    if (error.code === 'issue_not_found') {
      return 404
    }
    if (error.code === 'invalid_control_action') {
      return 400
    }
    if (error.code === 'service_not_running') {
      return 409
    }
    if (error.code === 'method_not_allowed') {
      return 405
    }
    if (error.code === 'orchestrator_unavailable' || error.code === 'unavailable') {
      return 503
    }
  }

  return 500
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function allowedMethodHeader(allowedMethods: Array<string>): string {
  const normalized = allowedMethods.map((method) => method.toUpperCase())
  if (normalized.includes('GET') && !normalized.includes('HEAD')) {
    normalized.push('HEAD')
  }

  return Array.from(new Set(normalized)).join(', ')
}

function generatedAtIsoSeconds(): string {
  const timestamp = Math.floor(Date.now() / 1000) * 1000
  return new Date(timestamp).toISOString().replace('.000Z', 'Z')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCurrentIssueDetailPayload(detail: unknown): boolean {
  if (!isRecord(detail)) {
    return false
  }

  return detail.status === 'running' || detail.status === 'retrying' || detail.status === 'blocked'
}

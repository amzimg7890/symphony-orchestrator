import type { SymphonyErrorCode, SymphonyErrorPayload } from './types'

export class SymphonyError extends Error {
  readonly code: SymphonyErrorCode
  readonly details?: Record<string, unknown>

  constructor(
    code: SymphonyErrorCode,
    message: string,
    options?: ErrorOptions & { details?: Record<string, unknown> },
  ) {
    super(message, options)
    this.name = 'SymphonyError'
    this.code = code
    this.details = options?.details
  }

  toPayload(): SymphonyErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    }
  }
}

export function toErrorPayload(error: unknown): SymphonyErrorPayload {
  if (error instanceof SymphonyError) {
    return error.toPayload()
  }

  if (error instanceof Error) {
    return {
      code: 'invalid_config',
      message: error.message,
    }
  }

  return {
    code: 'invalid_config',
    message: String(error),
  }
}

import { SymphonyError } from './errors'
import { executeRawLinearGraphql } from './linearTracker'
import type { EffectiveConfig } from './types'

export type DynamicToolResult = {
  success: boolean
  output: string
  contentItems: Array<{ type: 'inputText'; text: string }>
}

export type LinearGraphqlExecutor = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<unknown>

const LINEAR_GRAPHQL_TOOL = 'linear_graphql'

export async function executeDynamicToolCall(
  config: EffectiveConfig,
  params: unknown,
  executor: LinearGraphqlExecutor = (query, variables) =>
    executeRawLinearGraphql(config, query, variables),
): Promise<DynamicToolResult> {
  const request = asRecord(params)
  const toolName = stringValue(request.tool, stringValue(request.name, null))

  if (toolName !== LINEAR_GRAPHQL_TOOL) {
    return failureResponse({
      error: {
        message: `Unsupported dynamic tool: ${formatToolName(toolName)}.`,
        supportedTools: supportedToolNames(),
      },
    })
  }

  const normalized = normalizeLinearGraphqlArguments(request.arguments ?? {})
  if (!normalized.ok) {
    return failureResponse(toolErrorPayload(normalized))
  }

  try {
    const response = await executor(normalized.query, normalized.variables)
    return dynamicToolResponse(graphqlResponseSucceeded(response), encodePayload(response))
  } catch (error) {
    return failureResponse(toolErrorPayload(error))
  }
}

export function linearGraphqlToolSpec(): Record<string, unknown> {
  return {
    name: LINEAR_GRAPHQL_TOOL,
    description: 'Execute a raw Linear GraphQL query using the Symphony tracker credentials.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'GraphQL query or mutation document to execute against Linear.',
        },
        variables: {
          type: ['object', 'null'],
          description: 'Optional GraphQL variables object.',
          additionalProperties: true,
        },
      },
      additionalProperties: false,
    },
  }
}

function normalizeLinearGraphqlArguments(
  argumentsValue: unknown,
):
  | { ok: true; query: string; variables: Record<string, unknown> }
  | {
      ok: false
      error: 'missing_query' | 'invalid_arguments' | 'invalid_variables'
    } {
  if (typeof argumentsValue === 'string') {
    const query = argumentsValue.trim()
    if (!query) {
      return { ok: false, error: 'missing_query' }
    }
    return { ok: true, query, variables: {} }
  }

  if (!isRecord(argumentsValue)) {
    return { ok: false, error: 'invalid_arguments' }
  }

  const query = stringValue(argumentsValue.query, null)?.trim()
  if (!query) {
    return { ok: false, error: 'missing_query' }
  }

  const variables = argumentsValue.variables
  if (variables === undefined || variables === null) {
    return { ok: true, query, variables: {} }
  }
  if (!isRecord(variables)) {
    return { ok: false, error: 'invalid_variables' }
  }

  return { ok: true, query, variables }
}

function graphqlResponseSucceeded(response: unknown): boolean {
  const payload = asRecord(response)
  const errors = payload.errors
  return !(Array.isArray(errors) && errors.length > 0)
}

function failureResponse(payload: unknown): DynamicToolResult {
  return dynamicToolResponse(false, encodePayload(payload))
}

function dynamicToolResponse(success: boolean, output: string): DynamicToolResult {
  return {
    success,
    output,
    contentItems: [
      {
        type: 'inputText',
        text: output,
      },
    ],
  }
}

function toolErrorPayload(
  error:
    | unknown
    | { error: 'missing_query' | 'invalid_arguments' | 'invalid_variables' },
): Record<string, unknown> {
  if (isNormalizeError(error, 'missing_query')) {
    return {
      error: {
        message: '`linear_graphql` requires a non-empty `query` string.',
      },
    }
  }
  if (isNormalizeError(error, 'invalid_arguments')) {
    return {
      error: {
        message:
          '`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`.',
      },
    }
  }
  if (isNormalizeError(error, 'invalid_variables')) {
    return {
      error: {
        message: '`linear_graphql.variables` must be a JSON object when provided.',
      },
    }
  }

  if (error instanceof SymphonyError) {
    if (error.code === 'linear_api_status') {
      return {
        error: {
          message: error.message,
          details: error.details ?? null,
        },
      }
    }
    if (error.code === 'linear_graphql_errors') {
      return {
        error: {
          message: error.message,
          details: error.details ?? null,
        },
      }
    }
    if (error.code === 'linear_api_request') {
      return {
        error: {
          message: 'Linear GraphQL request failed before receiving a successful response.',
          reason: error.cause instanceof Error ? error.cause.message : String(error.cause ?? error.message),
        },
      }
    }
  }

  return {
    error: {
      message: 'Linear GraphQL tool execution failed.',
      reason: error instanceof Error ? error.message : String(error),
    },
  }
}

function isNormalizeError(
  value: unknown,
  error: 'missing_query' | 'invalid_arguments' | 'invalid_variables',
): value is { error: typeof error } {
  if (typeof value === 'string') {
    return value === error
  }

  return isRecord(value) && value.error === error
}

function encodePayload(payload: unknown): string {
  if (payload !== null && typeof payload === 'object') {
    return JSON.stringify(payload, null, 2)
  }

  return String(payload)
}

function supportedToolNames(): Array<string> {
  return [LINEAR_GRAPHQL_TOOL]
}

function formatToolName(toolName: string | null): string {
  return toolName === null ? 'null' : JSON.stringify(toolName)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown, fallback: string | null): string | null {
  return typeof value === 'string' ? value : fallback
}

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeDynamicToolCall, linearGraphqlToolSpec } from '../src/server/symphony/dynamicTool'
import { SymphonyError } from '../src/server/symphony/errors'
import { resolveWorkflowConfig } from '../src/server/symphony/config'
import { parseWorkflow } from '../src/server/symphony/workflow'

describe('Codex dynamic tools', () => {
  it('advertises the linear_graphql input contract', () => {
    expect(linearGraphqlToolSpec()).toMatchObject({
      name: 'linear_graphql',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'string',
          },
          variables: {
            type: ['object', 'null'],
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      },
    })
  })

  it('returns a structured failure for unsupported tools', async () => {
    const response = await executeDynamicToolCall(dynamicToolConfig(), {
      tool: 'not_a_real_tool',
      arguments: {},
    })

    expect(response.success).toBe(false)
    expect(JSON.parse(response.output)).toEqual({
      error: {
        message: 'Unsupported dynamic tool: "not_a_real_tool".',
        supportedTools: ['linear_graphql'],
      },
    })
    expect(response.contentItems).toEqual([{ type: 'inputText', text: response.output }])
  })

  it('executes linear_graphql object arguments and preserves successful GraphQL responses', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = []
    const response = await executeDynamicToolCall(
      dynamicToolConfig(),
      {
        name: 'linear_graphql',
        arguments: {
          query: '  query Viewer { viewer { id } }  ',
          variables: { includeTeams: false },
        },
      },
      async (query, variables) => {
        calls.push({ query, variables })
        return { data: { viewer: { id: 'usr_123' } } }
      },
    )

    expect(calls).toEqual([
      {
        query: 'query Viewer { viewer { id } }',
        variables: { includeTeams: false },
      },
    ])
    expect(response.success).toBe(true)
    expect(JSON.parse(response.output)).toEqual({ data: { viewer: { id: 'usr_123' } } })
  })

  it('ignores legacy operationName arguments while forwarding the GraphQL document', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = []
    const response = await executeDynamicToolCall(
      dynamicToolConfig(),
      {
        tool: 'linear_graphql',
        arguments: {
          query: 'query Viewer { viewer { id } }',
          operationName: 'Viewer',
        },
      },
      async (query, variables) => {
        calls.push({ query, variables })
        return { data: { viewer: { id: 'usr_789' } } }
      },
    )

    expect(calls).toEqual([
      {
        query: 'query Viewer { viewer { id } }',
        variables: {},
      },
    ])
    expect(response.success).toBe(true)
  })

  it('accepts a raw GraphQL query string as shorthand input', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = []
    const response = await executeDynamicToolCall(
      dynamicToolConfig(),
      {
        tool: 'linear_graphql',
        arguments: '  query Viewer { viewer { id } }  ',
      },
      async (query, variables) => {
        calls.push({ query, variables })
        return { data: { viewer: { id: 'usr_456' } } }
      },
    )

    expect(calls).toEqual([
      {
        query: 'query Viewer { viewer { id } }',
        variables: {},
      },
    ])
    expect(response.success).toBe(true)
  })

  it('passes multi-operation GraphQL documents through unchanged', async () => {
    const query = [
      'query Viewer { viewer { id } }',
      'mutation UpdateIssue { issueUpdate(id: "issue-1", input: {}) { success } }',
    ].join('\n')
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = []

    const response = await executeDynamicToolCall(
      dynamicToolConfig(),
      {
        tool: 'linear_graphql',
        arguments: {
          query: `\n${query}\n`,
        },
      },
      async (forwardedQuery, variables) => {
        calls.push({ query: forwardedQuery, variables })
        return {
          errors: [{ message: 'Must provide operation name if query contains multiple operations.' }],
        }
      },
    )

    expect(response.success).toBe(false)
    expect(calls).toEqual([{ query, variables: {} }])
    expect(JSON.parse(response.output)).toEqual({
      errors: [{ message: 'Must provide operation name if query contains multiple operations.' }],
    })
  })

  it('allows one operation with fragments and ignores operation words in comments and strings', async () => {
    const calls: Array<string> = []
    const query = [
      '# mutation NotAnOperation { nope }',
      'fragment ViewerFields on User { id name }',
      'query Viewer {',
      '  viewer {',
      '    ...ViewerFields',
      '    note: customField(name: "query mutation subscription")',
      '  }',
      '}',
    ].join('\n')

    const response = await executeDynamicToolCall(
      dynamicToolConfig(),
      {
        tool: 'linear_graphql',
        arguments: { query },
      },
      async (receivedQuery) => {
        calls.push(receivedQuery)
        return { data: { viewer: { id: 'user-1' } } }
      },
    )

    expect(response.success).toBe(true)
    expect(calls).toEqual([query])
  })

  it('marks GraphQL error responses as failures while preserving the response body', async () => {
    const response = await executeDynamicToolCall(
      dynamicToolConfig(),
      {
        tool: 'linear_graphql',
        arguments: { query: 'mutation BadMutation { nope }' },
      },
      async () => ({
        data: null,
        errors: [{ message: 'Unknown field `nope`' }],
      }),
    )

    expect(response.success).toBe(false)
    expect(JSON.parse(response.output)).toEqual({
      data: null,
      errors: [{ message: 'Unknown field `nope`' }],
    })
  })

  it('validates linear_graphql query and variables before calling Linear', async () => {
    const executor = async () => {
      throw new Error('executor should not be called')
    }

    const missingQuery = await executeDynamicToolCall(
      dynamicToolConfig(),
      {
        tool: 'linear_graphql',
        arguments: { variables: { id: 'issue-1' } },
      },
      executor,
    )
    const invalidArguments = await executeDynamicToolCall(
      dynamicToolConfig(),
      {
        tool: 'linear_graphql',
        arguments: ['not', 'valid'],
      },
      executor,
    )
    const invalidVariables = await executeDynamicToolCall(
      dynamicToolConfig(),
      {
        tool: 'linear_graphql',
        arguments: { query: 'query Viewer { viewer { id } }', variables: ['bad'] },
      },
      executor,
    )

    expect(JSON.parse(missingQuery.output)).toEqual({
      error: { message: '`linear_graphql` requires a non-empty `query` string.' },
    })
    expect(JSON.parse(invalidArguments.output)).toEqual({
      error: {
        message:
          '`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`.',
      },
    })
    expect(JSON.parse(invalidVariables.output)).toEqual({
      error: { message: '`linear_graphql.variables` must be a JSON object when provided.' },
    })
  })

  it('formats Linear transport failures as tool failures', async () => {
    const response = await executeDynamicToolCall(
      dynamicToolConfig(),
      {
        tool: 'linear_graphql',
        arguments: { query: 'query Viewer { viewer { id } }' },
      },
      async () => {
        throw new SymphonyError('linear_api_request', 'Linear API request failed', {
          cause: new Error('socket hang up'),
        })
      },
    )

    expect(response.success).toBe(false)
    expect(JSON.parse(response.output)).toEqual({
      error: {
        message: 'Linear GraphQL request failed before receiving a successful response.',
        reason: 'socket hang up',
      },
    })
  })

  it('returns Linear status details to the agent for failed GraphQL tool calls', async () => {
    const response = await executeDynamicToolCall(
      dynamicToolConfig(),
      {
        tool: 'linear_graphql',
        arguments: { query: 'query Bad { issues { nodes { id } } }' },
      },
      async () => {
        throw new SymphonyError('linear_api_status', 'Linear API returned HTTP 400 body="{\\"errors\\":[\\"bad\\"]}"', {
          details: {
            status: 400,
            body: '{"errors":["bad"]}',
            body_truncated: false,
          },
        })
      },
    )

    expect(response.success).toBe(false)
    expect(JSON.parse(response.output)).toEqual({
      error: {
        message: 'Linear API returned HTTP 400 body="{\\"errors\\":[\\"bad\\"]}"',
        details: {
          status: 400,
          body: '{"errors":["bad"]}',
          body_truncated: false,
        },
      },
    })
  })
})

function dynamicToolConfig() {
  const workflow = parseWorkflow(
    [
      '---',
      'tracker:',
      '  kind: linear',
      '  api_key: demo-token',
      '  project_slug: demo',
      'workspace:',
      '  root: ./workspaces',
      'demo:',
      '  mock_tracker: false',
      '---',
      'Prompt',
    ].join('\n'),
    path.resolve('WORKFLOW.md'),
  )
  const result = resolveWorkflowConfig(workflow, {})
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error('expected valid config')
  }

  return result.config
}

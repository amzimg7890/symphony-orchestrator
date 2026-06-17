import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveWorkflowConfig } from '../src/server/symphony/config'
import { SymphonyError } from '../src/server/symphony/errors'
import { LinearTracker } from '../src/server/symphony/linearTracker'
import { parseWorkflow } from '../src/server/symphony/workflow'

describe('Linear tracker assignee routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches candidate issues with the configured project slug and active states', async () => {
    const config = resolveConfig([])
    const requests: Array<{
      query: string
      variables: { projectSlug: string; stateNames: Array<string>; after: string | null }
    }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const request = JSON.parse(String(init.body)) as {
          query: string
          variables: { projectSlug: string; stateNames: Array<string>; after: string | null }
        }
        requests.push(request)
        return jsonResponse({
          data: {
            issues: {
              nodes: [linearIssueNode('issue-1', 'SYM-1', null)],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        })
      }),
    )

    const issues = await new LinearTracker().fetchCandidateIssues(config)

    expect(issues.map((issue) => issue.identifier)).toEqual(['SYM-1'])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.variables).toEqual({
      projectSlug: 'demo',
      stateNames: ['Todo', 'In Progress'],
      after: null,
    })
    expect(requests[0]?.query).toContain('project: { slugId: { eq: $projectSlug } }')
  })

  it('normalizes Linear issue labels for required-label routing', async () => {
    const config = resolveConfig([])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                linearIssueNode('issue-1', 'SYM-1', null, [], [
                  { name: ' Codex ' },
                  { name: 'BACKEND' },
                  { name: '' },
                  { name: null },
                  {},
                ]),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      ),
    )

    const issues = await new LinearTracker().fetchCandidateIssues(config)

    expect(issues[0]?.labels).toEqual(['codex', 'backend'])
  })

  it('resolves tracker.assignee=me and filters candidates to the viewer', async () => {
    const config = resolveConfig(['  assignee: me'])
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { viewer: { id: 'user-me' } } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                linearIssueNode('issue-1', 'SYM-1', 'user-me', [
                  {
                    id: 'issue-blocker',
                    identifier: 'SYM-0',
                    state: { name: 'In Progress' },
                    createdAt: '2025-12-31T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                  },
                ]),
                linearIssueNode('issue-2', 'SYM-2', 'user-other'),
                linearIssueNode('issue-3', 'SYM-3', null),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const issues = await new LinearTracker().fetchCandidateIssues(config)

    expect(issues.map((issue) => issue.identifier)).toEqual(['SYM-1'])
    expect(issues[0]).toMatchObject({
      assignee_id: 'user-me',
      assigned_to_worker: true,
    })
    expect(issues[0]?.blocked_by).toEqual([
      expect.objectContaining({
        identifier: 'SYM-0',
        state: 'In Progress',
      }),
    ])
  })

  it('preserves reassigned issue state so the orchestrator can release claims', async () => {
    const config = resolveConfig(['  assignee: user-me'])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [linearIssueNode('issue-1', 'SYM-1', 'user-other')],
            },
          },
        }),
      ),
    )

    const issues = await new LinearTracker().fetchIssueStatesByIds(['issue-1'], config)

    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      identifier: 'SYM-1',
      assignee_id: 'user-other',
      assigned_to_worker: false,
    })
  })

  it('fetches issue states in 50-id batches and preserves requested order', async () => {
    const config = resolveConfig([])
    const ids = Array.from({ length: 55 }, (_, index) => `issue-${index + 1}`)
    const requests: Array<{ query: string; variables: { ids: Array<string>; first: number } }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const request = JSON.parse(String(init.body)) as {
          query: string
          variables: { ids: Array<string>; first: number }
        }
        requests.push(request)
        return jsonResponse({
          data: {
            issues: {
              nodes: [...request.variables.ids]
                .reverse()
                .map((id) => linearIssueNode(id, id.toUpperCase(), null)),
            },
          },
        })
      }),
    )

    const issues = await new LinearTracker().fetchIssueStatesByIds(ids, config)

    expect(requests).toHaveLength(2)
    expect(requests[0]?.variables).toMatchObject({
      ids: ids.slice(0, 50),
      first: 50,
    })
    expect(requests[1]?.variables).toMatchObject({
      ids: ids.slice(50),
      first: 5,
    })
    expect(requests[0]?.query).toContain('$ids: [ID!]')
    expect(requests[0]?.query).toContain('$first: Int!')
    expect(issues.map((issue) => issue.id)).toEqual(ids)
  })

  it('creates Linear comments through the tracker write boundary', async () => {
    const config = resolveConfig([])
    const requests: Array<{ query: string; variables: { issueId: string; body: string } }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const request = JSON.parse(String(init.body)) as {
          query: string
          variables: { issueId: string; body: string }
        }
        requests.push(request)
        return jsonResponse({
          data: {
            commentCreate: {
              success: true,
            },
          },
        })
      }),
    )

    await expect(new LinearTracker().createComment('issue-1', 'Ready for review', config)).resolves.toBeUndefined()

    expect(requests).toHaveLength(1)
    expect(requests[0]?.query).toContain('commentCreate')
    expect(requests[0]?.variables).toEqual({
      issueId: 'issue-1',
      body: 'Ready for review',
    })
  })

  it('updates Linear issue state by resolving the target state id first', async () => {
    const config = resolveConfig([])
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const request = JSON.parse(String(init.body)) as {
          query: string
          variables: Record<string, unknown>
        }
        requests.push(request)
        if (request.query.includes('SymphonyResolveStateId')) {
          return jsonResponse({
            data: {
              issue: {
                team: {
                  states: {
                    nodes: [{ id: 'state-done' }],
                  },
                },
              },
            },
          })
        }

        return jsonResponse({
          data: {
            issueUpdate: {
              success: true,
            },
          },
        })
      }),
    )

    await expect(new LinearTracker().updateIssueState('issue-1', 'Done', config)).resolves.toBeUndefined()

    expect(requests).toHaveLength(2)
    expect(requests[0]?.query).toContain('states(filter: { name: { eq: $stateName } }, first: 1)')
    expect(requests[0]?.variables).toEqual({
      issueId: 'issue-1',
      stateName: 'Done',
    })
    expect(requests[1]?.query).toContain('issueUpdate')
    expect(requests[1]?.variables).toEqual({
      issueId: 'issue-1',
      stateId: 'state-done',
    })
  })

  it('reports a typed error when the requested Linear state name is missing', async () => {
    const config = resolveConfig([])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          data: {
            issue: {
              team: {
                states: {
                  nodes: [],
                },
              },
            },
          },
        }),
      ),
    )

    const error = await new LinearTracker()
      .updateIssueState('issue-1', 'Missing', config)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SymphonyError)
    expect((error as SymphonyError).code).toBe('linear_state_not_found')
    expect((error as SymphonyError).message).toContain('Linear state Missing was not found for issue issue-1')
  })

  it('fetches issues by state across Linear pages', async () => {
    const config = resolveConfig([])
    const requests: Array<{ variables: { after: string | null } }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockImplementationOnce(async (_url: string, init: RequestInit) => {
          const request = JSON.parse(String(init.body)) as { variables: { after: string | null } }
          requests.push(request)
          return jsonResponse({
            data: {
              issues: {
                nodes: [linearIssueNode('done-1', 'DONE-1', null)],
                pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
              },
            },
          })
        })
        .mockImplementationOnce(async (_url: string, init: RequestInit) => {
          const request = JSON.parse(String(init.body)) as { variables: { after: string | null } }
          requests.push(request)
          return jsonResponse({
            data: {
              issues: {
                nodes: [linearIssueNode('done-2', 'DONE-2', null)],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          })
        }),
    )

    const issues = await new LinearTracker().fetchIssuesByStates(['Done'], config)

    expect(requests.map((request) => request.variables.after)).toEqual([null, 'cursor-2'])
    expect(issues.map((issue) => issue.identifier)).toEqual(['DONE-1', 'DONE-2'])
  })

  it('rejects candidate pagination that omits the next cursor', async () => {
    const config = resolveConfig([])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [linearIssueNode('issue-1', 'SYM-1', null)],
              pageInfo: { hasNextPage: true, endCursor: null },
            },
          },
        }),
      ),
    )

    const error = await new LinearTracker()
      .fetchCandidateIssues(config)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SymphonyError)
    expect((error as SymphonyError).code).toBe('linear_missing_end_cursor')
    expect((error as SymphonyError).message).toBe('Linear pagination did not include endCursor')
  })

  it('rejects state pagination that omits the next cursor', async () => {
    const config = resolveConfig([])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [linearIssueNode('done-1', 'DONE-1', null)],
              pageInfo: { hasNextPage: true, endCursor: null },
            },
          },
        }),
      ),
    )

    const error = await new LinearTracker()
      .fetchIssuesByStates(['Done'], config)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SymphonyError)
    expect((error as SymphonyError).code).toBe('linear_missing_end_cursor')
    expect((error as SymphonyError).message).toBe('Linear pagination did not include endCursor')
  })

  it('returns no issues for an empty state list without calling Linear', async () => {
    const config = resolveConfig([])
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const issues = await new LinearTracker().fetchIssuesByStates([], config)

    expect(issues).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces non-200 GraphQL response bodies as truncated error details', async () => {
    const config = resolveConfig([])
    const body = {
      errors: [
        {
          message: `Variable "$ids" got invalid value ${'x'.repeat(1200)}`,
          extensions: { code: 'BAD_USER_INPUT' },
        },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(body), {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    const error = await new LinearTracker()
      .fetchIssueStatesByIds(['issue-1'], config)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SymphonyError)
    expect((error as SymphonyError).code).toBe('linear_api_status')
    expect((error as SymphonyError).message).toContain('Linear API returned HTTP 400')
    expect((error as SymphonyError).message).toContain('BAD_USER_INPUT')
    expect((error as SymphonyError).message).toContain('...<truncated>')
    expect((error as SymphonyError).message).not.toContain('x'.repeat(300))
    expect((error as SymphonyError).toPayload().details).toMatchObject({
      status: 400,
      status_text: 'Bad Request',
      content_type: 'application/json',
      body_truncated: true,
    })
    expect((error as SymphonyError).toPayload().details?.body).toContain('BAD_USER_INPUT')
    expect((error as SymphonyError).toPayload().details?.body).toContain('...<truncated>')
  })

  it('maps Linear transport failures to linear_api_request', async () => {
    const config = resolveConfig([])
    const cause = new Error('network unreachable')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(cause))

    const error = await new LinearTracker()
      .fetchCandidateIssues(config)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SymphonyError)
    expect((error as SymphonyError).code).toBe('linear_api_request')
    expect((error as SymphonyError).message).toBe('Linear API request failed')
    expect((error as SymphonyError).cause).toBe(cause)
  })

  it('surfaces top-level GraphQL errors with bounded details', async () => {
    const config = resolveConfig([])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          errors: [
            {
              message: `Variable "$projectSlug" got invalid value ${'x'.repeat(1200)}`,
              extensions: { code: 'BAD_USER_INPUT' },
            },
          ],
        }),
      ),
    )

    const error = await new LinearTracker()
      .fetchCandidateIssues(config)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SymphonyError)
    expect((error as SymphonyError).code).toBe('linear_graphql_errors')
    expect((error as SymphonyError).message).toContain('...<truncated>')
    expect((error as SymphonyError).message).not.toContain('x'.repeat(400))
    expect((error as SymphonyError).toPayload().details).toMatchObject({
      errors_truncated: true,
      errors: [
        {
          extensions: { code: 'BAD_USER_INPUT' },
        },
      ],
    })
    const details = (error as SymphonyError).toPayload().details as {
      errors?: Array<{ message?: string }>
      errors_bytes?: number
    }
    expect(details.errors?.[0]?.message).toContain('...<truncated>')
    expect(details.errors?.[0]?.message).not.toContain('x'.repeat(400))
    expect(details.errors_bytes).toBeGreaterThan(300)
  })

  it('maps successful malformed JSON responses to linear_unknown_payload', async () => {
    const config = resolveConfig([])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response('not-json-response', {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'text/plain' },
        }),
      ),
    )

    const error = await new LinearTracker()
      .fetchCandidateIssues(config)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SymphonyError)
    expect((error as SymphonyError).code).toBe('linear_unknown_payload')
    expect((error as SymphonyError).message).toBe('Linear API response was not valid JSON')
    expect((error as SymphonyError).toPayload().details).toMatchObject({
      status: 200,
      status_text: 'OK',
      content_type: 'text/plain',
      body: 'not-json-response',
      body_bytes: 17,
      body_truncated: false,
    })
  })

  it('maps malformed candidate issue payloads to linear_unknown_payload', async () => {
    const config = resolveConfig([])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [linearIssueNode('issue-1', 'SYM-1', null)],
            },
          },
        }),
      ),
    )

    const error = await new LinearTracker()
      .fetchCandidateIssues(config)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SymphonyError)
    expect((error as SymphonyError).code).toBe('linear_unknown_payload')
    expect((error as SymphonyError).message).toBe('Linear candidate issue payload was malformed')
  })

  it('maps malformed issue-state payloads to linear_unknown_payload', async () => {
    const config = resolveConfig([])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {},
          },
        }),
      ),
    )

    const error = await new LinearTracker()
      .fetchIssueStatesByIds(['issue-1'], config)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SymphonyError)
    expect((error as SymphonyError).code).toBe('linear_unknown_payload')
    expect((error as SymphonyError).message).toBe('Linear issue state payload was malformed')
  })
})

function resolveConfig(extraTrackerLines: Array<string>) {
  const workflow = parseWorkflow(
    [
      '---',
      'tracker:',
      '  kind: linear',
      '  api_key: demo-token',
      '  project_slug: demo',
      ...extraTrackerLines,
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

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function linearIssueNode(
  id: string,
  identifier: string,
  assigneeId: string | null,
  blockers: Array<Record<string, unknown>> = [],
  labels: Array<{ name?: string | null }> = [{ name: 'codex' }],
) {
  return {
    id,
    identifier,
    title: `${identifier} title`,
    description: null,
    priority: 1,
    state: { name: 'Todo' },
    branchName: null,
    url: `https://linear.example/${identifier}`,
    assignee: assigneeId ? { id: assigneeId } : null,
    labels: { nodes: labels },
    inverseRelations: {
      nodes: blockers.map((issue) => ({
        type: 'blocks',
        issue,
      })),
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

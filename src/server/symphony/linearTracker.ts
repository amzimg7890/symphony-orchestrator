import { SymphonyError } from './errors'
import type { EffectiveConfig, Issue, IssueTracker } from './types'

type LinearGraphQlResponse<T> = {
  data?: T
  errors?: Array<{ message?: string }>
}

type LinearIssueNode = {
  id?: string
  identifier?: string
  title?: string
  description?: string | null
  priority?: number | null
  url?: string | null
  branchName?: string | null
  assignee?: { id?: string | null } | null
  createdAt?: string | null
  updatedAt?: string | null
  state?: { name?: string | null } | null
  labels?: { nodes?: Array<{ name?: string | null }> } | null
  inverseRelations?: {
    nodes?: Array<{
      type?: string | null
      issue?: {
        id?: string | null
        identifier?: string | null
        state?: { name?: string | null } | null
        createdAt?: string | null
        updatedAt?: string | null
      } | null
      relatedIssue?: {
        id?: string | null
        identifier?: string | null
        state?: { name?: string | null } | null
        createdAt?: string | null
        updatedAt?: string | null
      } | null
    }>
  } | null
}

type CandidateIssuesPayload = {
  issues?: {
    nodes?: Array<LinearIssueNode>
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
  }
}

type IssueConnectionPayload = {
  issues?: { nodes?: Array<LinearIssueNode> }
}

type ViewerPayload = {
  viewer?: { id?: string | null } | null
}

type CommentCreatePayload = {
  commentCreate?: { success?: boolean | null } | null
}

type StateLookupPayload = {
  issue?: {
    team?: {
      states?: {
        nodes?: Array<{ id?: string | null }>
      } | null
    } | null
  } | null
}

type IssueUpdatePayload = {
  issueUpdate?: { success?: boolean | null } | null
}

type AssigneeFilter = {
  configured_assignee: string
  match_values: Set<string>
}

const linearIssuePageSize = 50
const linearErrorBodyMaxBytes = 1000

export class LinearTracker implements IssueTracker {
  async fetchCandidateIssues(config: EffectiveConfig): Promise<Array<Issue>> {
    const issues: Array<Issue> = []
    let after: string | null = null
    const assigneeFilter = await resolveAssigneeFilter(config)

    do {
      const result: CandidateIssuesPayload = await requestLinear<CandidateIssuesPayload>(config, CANDIDATE_ISSUES_QUERY, {
        projectSlug: config.tracker.project_slug,
        stateNames: config.tracker.active_states,
        after,
      })

      const connection: CandidateIssuesPayload['issues'] = result.issues
      if (!connection?.nodes || !connection.pageInfo) {
        throw new SymphonyError('linear_unknown_payload', 'Linear candidate issue payload was malformed')
      }

      issues.push(
        ...connection.nodes
          .map((node) => normalizeIssue(node, assigneeFilter))
          .filter(isIssue)
          .filter((issue) => issue.assigned_to_worker),
      )

      if (connection.pageInfo.hasNextPage && !connection.pageInfo.endCursor) {
        throw new SymphonyError('linear_missing_end_cursor', 'Linear pagination did not include endCursor')
      }

      after = connection.pageInfo.hasNextPage ? (connection.pageInfo.endCursor ?? null) : null
    } while (after)

    return issues
  }

  async fetchIssuesByStates(states: Array<string>, config: EffectiveConfig): Promise<Array<Issue>> {
    if (states.length === 0) {
      return []
    }

    const issues: Array<Issue> = []
    let after: string | null = null
    do {
      const result: CandidateIssuesPayload = await requestLinear<CandidateIssuesPayload>(config, ISSUES_BY_STATES_QUERY, {
        projectSlug: config.tracker.project_slug,
        stateNames: states,
        after,
      })

      const connection = result.issues
      if (!connection?.nodes || !connection.pageInfo) {
        throw new SymphonyError('linear_unknown_payload', 'Linear state issue payload was malformed')
      }

      issues.push(...connection.nodes.map((node) => normalizeIssue(node, null)).filter(isIssue))
      if (connection.pageInfo.hasNextPage && !connection.pageInfo.endCursor) {
        throw new SymphonyError('linear_missing_end_cursor', 'Linear pagination did not include endCursor')
      }

      after = connection.pageInfo.hasNextPage ? (connection.pageInfo.endCursor ?? null) : null
    } while (after)

    return issues
  }

  async fetchIssueStatesByIds(ids: Array<string>, config: EffectiveConfig): Promise<Array<Issue>> {
    if (ids.length === 0) {
      return []
    }

    const uniqueIds = [...new Set(ids)]
    const assigneeFilter = await resolveAssigneeFilter(config)
    const issueOrder = new Map(uniqueIds.map((id, index) => [id, index]))
    const issues: Array<Issue> = []
    for (const batchIds of chunk(uniqueIds, linearIssuePageSize)) {
      const result: IssueConnectionPayload = await requestLinear<IssueConnectionPayload>(config, ISSUE_STATES_BY_IDS_QUERY, {
        ids: batchIds,
        first: batchIds.length,
      })
      if (!result.issues?.nodes) {
        throw new SymphonyError('linear_unknown_payload', 'Linear issue state payload was malformed')
      }

      issues.push(...result.issues.nodes.map((node) => normalizeIssue(node, assigneeFilter)).filter(isIssue))
    }

    return issues.sort(
      (a, b) =>
        (issueOrder.get(a.id) ?? Number.POSITIVE_INFINITY) -
        (issueOrder.get(b.id) ?? Number.POSITIVE_INFINITY),
    )
  }

  async createComment(issueId: string, body: string, config: EffectiveConfig): Promise<void> {
    const result = await requestLinear<CommentCreatePayload>(config, CREATE_COMMENT_MUTATION, {
      issueId,
      body,
    })

    if (result.commentCreate?.success !== true) {
      throw new SymphonyError('linear_unknown_payload', 'Linear comment create response was unsuccessful')
    }
  }

  async updateIssueState(issueId: string, stateName: string, config: EffectiveConfig): Promise<void> {
    const stateId = await resolveIssueStateId(issueId, stateName, config)
    const result = await requestLinear<IssueUpdatePayload>(config, UPDATE_ISSUE_STATE_MUTATION, {
      issueId,
      stateId,
    })

    if (result.issueUpdate?.success !== true) {
      throw new SymphonyError('linear_unknown_payload', 'Linear issue update response was unsuccessful')
    }
  }
}

export async function executeLinearGraphql<T = unknown>(
  config: EffectiveConfig,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  return requestLinear<T>(config, query, variables)
}

export async function executeRawLinearGraphql<T = unknown>(
  config: EffectiveConfig,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  return requestLinearPayload<T>(config, query, variables)
}

async function requestLinear<T>(
  config: EffectiveConfig,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const payload = await requestLinearPayload<LinearGraphQlResponse<T>>(config, query, variables)
  if (payload.errors?.length) {
    const summarizedErrors = summarizeGraphqlErrors(payload.errors)
    throw new SymphonyError(
      'linear_graphql_errors',
      summarizedErrors.errors.map((error) => error.message).join('; '),
      {
        details: {
          errors: summarizedErrors.errors,
          errors_truncated: summarizedErrors.truncated,
          errors_bytes: summarizedErrors.bytes,
        },
      },
    )
  }

  if (!payload.data) {
    throw new SymphonyError('linear_unknown_payload', 'Linear API response did not include data')
  }

  return payload.data
}

async function requestLinearPayload<T>(
  config: EffectiveConfig,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(config.tracker.endpoint, {
      method: 'POST',
      headers: {
        Authorization: config.tracker.api_key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new SymphonyError('linear_api_request', 'Linear API request failed', { cause: error })
  }

  if (!response.ok) {
    const body = await summarizeLinearErrorBody(response)
    throw new SymphonyError(
      'linear_api_status',
      `Linear API returned HTTP ${response.status}${body.text ? ` body=${JSON.stringify(body.text)}` : ''}`,
      {
        details: {
          status: response.status,
          status_text: response.statusText,
          content_type: response.headers.get('content-type'),
          body: body.text,
          body_bytes: body.bytes,
          body_truncated: body.truncated,
          ...(body.read_error ? { body_read_error: body.read_error } : {}),
        },
      },
    )
  }

  const body = await summarizeLinearResponseBody(response)
  try {
    return JSON.parse(body.raw) as T
  } catch (error) {
    throw new SymphonyError('linear_unknown_payload', 'Linear API response was not valid JSON', {
      cause: error,
      details: {
        status: response.status,
        status_text: response.statusText,
        content_type: response.headers.get('content-type'),
        body: body.text,
        body_bytes: body.bytes,
        body_truncated: body.truncated,
        ...(body.read_error ? { body_read_error: body.read_error } : {}),
      },
    })
  }
}

async function summarizeLinearErrorBody(
  response: Response,
): Promise<{ text: string; bytes: number; truncated: boolean; read_error?: string }> {
  let raw: string
  try {
    raw = await response.text()
  } catch (error) {
    return {
      text: '',
      bytes: 0,
      truncated: false,
      read_error: error instanceof Error ? error.message : String(error),
    }
  }

  const normalized = raw.replace(/\s+/g, ' ').trim()
  const bytes = Buffer.byteLength(normalized, 'utf8')
  const summarized = summarizeGraphqlErrorJson(normalized)
  if (Buffer.byteLength(summarized, 'utf8') <= linearErrorBodyMaxBytes) {
    return {
      text: summarized,
      bytes,
      truncated: summarized !== normalized,
    }
  }

  return {
    text: `${Buffer.from(summarized).subarray(0, linearErrorBodyMaxBytes).toString('utf8')}...<truncated>`,
    bytes,
    truncated: true,
  }
}

async function summarizeLinearResponseBody(
  response: Response,
): Promise<{ raw: string; text: string; bytes: number; truncated: boolean; read_error?: string }> {
  let raw: string
  try {
    raw = await response.text()
  } catch (error) {
    return {
      raw: '',
      text: '',
      bytes: 0,
      truncated: false,
      read_error: error instanceof Error ? error.message : String(error),
    }
  }

  const normalized = raw.replace(/\s+/g, ' ').trim()
  const bytes = Buffer.byteLength(normalized, 'utf8')
  if (bytes <= linearErrorBodyMaxBytes) {
    return {
      raw,
      text: normalized,
      bytes,
      truncated: false,
    }
  }

  return {
    raw,
    text: `${Buffer.from(normalized).subarray(0, linearErrorBodyMaxBytes).toString('utf8')}...<truncated>`,
    bytes,
    truncated: true,
  }
}

function summarizeGraphqlErrorJson(body: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.errors)) {
    return body
  }

  return JSON.stringify({
    ...parsed,
    errors: parsed.errors.map((error) => {
      if (!isRecord(error)) {
        return error
      }

      return {
        message: truncateStringValue(error.message, 300),
        ...(error.extensions !== undefined ? { extensions: error.extensions } : {}),
      }
    }),
  })
}

function summarizeGraphqlErrors(
  errors: Array<{ message?: string }>,
): { errors: Array<Record<string, unknown> & { message: string }>; bytes: number; truncated: boolean } {
  let truncated = false
  const summarized = errors.map((error) => {
    const normalizedError: Record<string, unknown> = isRecord(error) ? error : {}
    const originalMessage = error.message ?? 'GraphQL error'
    const message = String(truncateStringValue(originalMessage, 300))
    truncated ||= message !== originalMessage
    return {
      message,
      ...(normalizedError.extensions !== undefined ? { extensions: normalizedError.extensions } : {}),
    }
  })
  const serialized = JSON.stringify(summarized)
  const bytes = Buffer.byteLength(serialized, 'utf8')

  if (bytes <= linearErrorBodyMaxBytes) {
    return {
      errors: summarized,
      bytes,
      truncated,
    }
  }

  return {
    errors: [
      {
        message: `${Buffer.from(serialized).subarray(0, linearErrorBodyMaxBytes).toString('utf8')}...<truncated>`,
      },
    ],
    bytes,
    truncated: true,
  }
}

function truncateStringValue(value: unknown, maxBytes: number): unknown {
  if (typeof value !== 'string') {
    return value
  }

  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value
  }

  return `${Buffer.from(value).subarray(0, maxBytes).toString('utf8')}...<truncated>`
}

async function resolveAssigneeFilter(config: EffectiveConfig): Promise<AssigneeFilter | null> {
  const configured = config.tracker.assignee?.trim()
  if (!configured) {
    return null
  }

  if (configured.toLowerCase() === 'me') {
    const result = await requestLinear<ViewerPayload>(config, VIEWER_QUERY, {})
    const viewerId = normalizeAssigneeValue(result.viewer?.id)
    if (!viewerId) {
      throw new SymphonyError('linear_unknown_payload', 'Linear viewer payload did not include an id')
    }

    return {
      configured_assignee: configured,
      match_values: new Set([viewerId]),
    }
  }

  const assigneeId = normalizeAssigneeValue(configured)
  return assigneeId
    ? {
        configured_assignee: configured,
        match_values: new Set([assigneeId]),
      }
    : null
}

async function resolveIssueStateId(
  issueId: string,
  stateName: string,
  config: EffectiveConfig,
): Promise<string> {
  const result = await requestLinear<StateLookupPayload>(config, STATE_LOOKUP_QUERY, {
    issueId,
    stateName,
  })
  const stateId = result.issue?.team?.states?.nodes?.[0]?.id
  if (!stateId) {
    throw new SymphonyError('linear_state_not_found', `Linear state ${stateName} was not found for issue ${issueId}`)
  }

  return stateId
}

function normalizeIssue(node: LinearIssueNode, assigneeFilter: AssigneeFilter | null): Issue | null {
  if (!node.id || !node.identifier || !node.title || !node.state?.name) {
    return null
  }

  const assigneeId = normalizeAssigneeValue(node.assignee?.id)

  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? null,
    priority: typeof node.priority === 'number' ? node.priority : null,
    state: node.state.name,
    branch_name: node.branchName ?? null,
    url: node.url ?? null,
    assignee_id: assigneeId,
    assigned_to_worker: assignedToWorker(assigneeId, assigneeFilter),
    labels:
      node.labels?.nodes
        ?.map((label) => label.name?.trim().toLowerCase())
        .filter((label): label is string => Boolean(label)) ?? [],
    blocked_by:
      node.inverseRelations?.nodes
        ?.filter((relation) => relation.type === 'blocks')
        .map((relation) => {
          const blocker = relation.issue ?? relation.relatedIssue
          return {
            id: blocker?.id ?? null,
            identifier: blocker?.identifier ?? null,
            state: blocker?.state?.name ?? null,
            created_at: blocker?.createdAt ?? null,
            updated_at: blocker?.updatedAt ?? null,
          }
        }) ?? [],
    created_at: node.createdAt ?? null,
    updated_at: node.updatedAt ?? null,
  }
}

function isIssue(issue: Issue | null): issue is Issue {
  return issue !== null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assignedToWorker(assigneeId: string | null, assigneeFilter: AssigneeFilter | null): boolean {
  if (!assigneeFilter) {
    return true
  }

  return Boolean(assigneeId && assigneeFilter.match_values.has(assigneeId))
}

function normalizeAssigneeValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function chunk<T>(values: Array<T>, size: number): Array<Array<T>> {
  const chunks: Array<Array<T>> = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  url
  branchName
  assignee { id }
  createdAt
  updatedAt
  state { name }
  labels { nodes { name } }
  inverseRelations(first: 50) {
    nodes {
      type
      issue {
        id
        identifier
        createdAt
        updatedAt
        state { name }
      }
    }
  }
`

const VIEWER_QUERY = `
  query SymphonyLinearViewer {
    viewer { id }
  }
`

const CANDIDATE_ISSUES_QUERY = `
  query CandidateIssues($projectSlug: String!, $stateNames: [String!], $after: String) {
    issues(
      first: 50
      after: $after
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $stateNames } }
      }
    ) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`

const ISSUES_BY_STATES_QUERY = `
  query IssuesByStates($projectSlug: String!, $stateNames: [String!], $after: String) {
    issues(
      first: 50
      after: $after
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $stateNames } }
      }
    ) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`

const ISSUE_STATES_BY_IDS_QUERY = `
  query IssueStatesByIds($ids: [ID!], $first: Int!) {
    issues(first: $first, filter: { id: { in: $ids } }) {
      nodes { ${ISSUE_FIELDS} }
    }
  }
`

const CREATE_COMMENT_MUTATION = `
  mutation SymphonyCreateComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
    }
  }
`

const STATE_LOOKUP_QUERY = `
  query SymphonyResolveStateId($issueId: String!, $stateName: String!) {
    issue(id: $issueId) {
      team {
        states(filter: { name: { eq: $stateName } }, first: 1) {
          nodes { id }
        }
      }
    }
  }
`

const UPDATE_ISSUE_STATE_MUTATION = `
  mutation SymphonyUpdateIssueState($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) {
      success
    }
  }
`

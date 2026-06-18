import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stateInList } from './config'
import { SymphonyError } from './errors'
import type { EffectiveConfig, Issue, IssueTracker } from './types'

export type GithubCliResult = {
  stdout: string
  stderr: string
}

export type GithubCliExecutor = (
  command: string,
  args: Array<string>,
  options: { cwd?: string },
) => Promise<GithubCliResult>

type GithubIssuePayload = {
  number?: number
  title?: string
  body?: string | null
  state?: string
  url?: string
  labels?: Array<string | { name?: string | null }>
  assignees?: Array<string | { login?: string | null }>
  createdAt?: string | null
  updatedAt?: string | null
}

const execFileAsync = promisify(execFile)
const ISSUE_JSON_FIELDS = [
  'number',
  'title',
  'body',
  'state',
  'url',
  'labels',
  'assignees',
  'createdAt',
  'updatedAt',
].join(',')
const GITHUB_ISSUE_LIMIT = '1000'
const CLOSED_STATE_ALIASES = new Set(['closed', 'done', 'cancelled', 'canceled', 'duplicate'])
const OPEN_STATE_ALIASES = new Set(['open', 'todo', 'in progress', 'in-progress'])

export class GithubTracker implements IssueTracker {
  private viewerLogin: string | null | undefined

  constructor(private readonly executor: GithubCliExecutor = defaultGithubCliExecutor) {}

  async fetchCandidateIssues(config: EffectiveConfig): Promise<Array<Issue>> {
    if (config.tracker.required_labels.some((label) => label.trim() === '')) {
      return []
    }

    const issues = await this.fetchIssuesForStates(config.tracker.active_states, config, {
      filterRequiredLabels: true,
    })
    return issues.filter((issue) => issue.assigned_to_worker)
  }

  async fetchIssuesByStates(states: Array<string>, config: EffectiveConfig): Promise<Array<Issue>> {
    return this.fetchIssuesForStates(states, config, {
      filterRequiredLabels: false,
    })
  }

  async fetchIssueStatesByIds(ids: Array<string>, config: EffectiveConfig): Promise<Array<Issue>> {
    if (ids.length === 0) {
      return []
    }

    const uniqueIds = [...new Set(ids)]
    const assigneeFilter = await this.resolveAssigneeFilter(config)
    const issues: Array<Issue> = []
    for (const id of uniqueIds) {
      const issueNumber = githubIssueNumber(id)
      if (issueNumber === null) {
        continue
      }

      const payload = await this.githubJson<GithubIssuePayload>(
        [
          'issue',
          'view',
          String(issueNumber),
          ...repoArgs(config),
          '--json',
          ISSUE_JSON_FIELDS,
        ],
        config,
      )
      const issue = normalizeGithubIssue(payload, config, assigneeFilter)
      if (issue) {
        issues.push(issue)
      }
    }

    const issueOrder = new Map(uniqueIds.map((id, index) => [id, index]))
    return issues.sort(
      (left, right) =>
        (issueOrder.get(left.id) ?? Number.POSITIVE_INFINITY) -
        (issueOrder.get(right.id) ?? Number.POSITIVE_INFINITY),
    )
  }

  async createComment(issueId: string, body: string, config: EffectiveConfig): Promise<void> {
    const issueNumber = requireGithubIssueNumber(issueId)
    await this.runGithub(
      [
        'issue',
        'comment',
        String(issueNumber),
        ...repoArgs(config),
        '--body',
        body,
      ],
      config,
    )
  }

  async updateIssueState(issueId: string, stateName: string, config: EffectiveConfig): Promise<void> {
    const issueNumber = requireGithubIssueNumber(issueId)
    const state = githubCliStateForStateName(stateName)
    if (!state) {
      throw new SymphonyError(
        'github_unsupported_state',
        `GitHub issue state ${stateName} is not supported; use Open/Closed or Todo/In Progress/Done aliases`,
      )
    }

    await this.runGithub(
      ['issue', state === 'closed' ? 'close' : 'reopen', String(issueNumber), ...repoArgs(config)],
      config,
    )
  }

  private async fetchIssuesForStates(
    states: Array<string>,
    config: EffectiveConfig,
    options: { filterRequiredLabels: boolean },
  ): Promise<Array<Issue>> {
    const ghStates = githubCliStatesForStateNames(states)
    if (ghStates.length === 0) {
      return []
    }

    const assigneeFilter = await this.resolveAssigneeFilter(config)
    const issues: Array<Issue> = []
    for (const ghState of ghStates) {
      const payload = await this.githubJson<Array<GithubIssuePayload>>(
        [
          'issue',
          'list',
          ...repoArgs(config),
          '--state',
          ghState,
          '--limit',
          GITHUB_ISSUE_LIMIT,
          '--json',
          ISSUE_JSON_FIELDS,
          ...labelArgs(options.filterRequiredLabels ? config.tracker.required_labels : []),
        ],
        config,
      )
      if (!Array.isArray(payload)) {
        throw new SymphonyError('github_unknown_payload', 'GitHub issue list payload was malformed')
      }

      issues.push(
        ...payload
          .map((issue) => normalizeGithubIssue(issue, config, assigneeFilter))
          .filter((issue): issue is Issue => Boolean(issue)),
      )
    }

    return dedupeIssues(issues).filter((issue) => githubStateInList(issue.state, states))
  }

  private async resolveAssigneeFilter(config: EffectiveConfig): Promise<Set<string> | null> {
    const configured = config.tracker.assignee?.trim()
    if (!configured) {
      return null
    }

    if (configured.toLowerCase() !== 'me') {
      return new Set([configured.replace(/^@/, '').toLowerCase()])
    }

    if (this.viewerLogin !== undefined) {
      return this.viewerLogin ? new Set([this.viewerLogin]) : null
    }

    const result = await this.runGithub(['api', 'user', '--jq', '.login'], config)
    this.viewerLogin = result.stdout.trim().toLowerCase() || null
    if (!this.viewerLogin) {
      throw new SymphonyError('github_unknown_payload', 'GitHub viewer payload did not include a login')
    }

    return new Set([this.viewerLogin])
  }

  private async githubJson<T>(args: Array<string>, config: EffectiveConfig): Promise<T> {
    const result = await this.runGithub(args, config)
    try {
      return JSON.parse(result.stdout) as T
    } catch (error) {
      throw new SymphonyError('github_unknown_payload', 'GitHub CLI response was not valid JSON', {
        cause: error,
        details: {
          stdout: truncateCliText(result.stdout),
          stderr: truncateCliText(result.stderr),
        },
      })
    }
  }

  private async runGithub(args: Array<string>, config: EffectiveConfig): Promise<GithubCliResult> {
    const command = githubCommandParts(config.tracker.gh_command)
    try {
      return await this.executor(command.executable, [...command.args, ...args], {
        cwd: config.workflow_directory,
      })
    } catch (error) {
      if (isFailedGithubCliResult(error)) {
        throw new SymphonyError(
          'github_cli_status',
          `GitHub CLI failed: ${truncateCliText(error.stderr || error.stdout || error.message)}`,
          {
            cause: error,
            details: {
              exit_code: error.code,
              stdout: truncateCliText(error.stdout),
              stderr: truncateCliText(error.stderr),
            },
          },
        )
      }

      throw new SymphonyError('github_cli_request', 'GitHub CLI request failed', { cause: error })
    }
  }
}

export function githubCommandParts(command: string): { executable: string; args: Array<string> } {
  const parts: Array<string> = []
  let current = ''
  let quote: '"' | "'" | null = null
  const input = command.trim()

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!
    if (char === '\\') {
      const next = input[index + 1]
      if (next && (next === '"' || next === "'" || next === '\\' || /\s/.test(next))) {
        current += next
        index += 1
      } else {
        current += char
      }
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        parts.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current) {
    parts.push(current)
  }

  const [executable, ...args] = parts.length > 0 ? parts : ['gh']
  return { executable, args }
}

async function defaultGithubCliExecutor(
  command: string,
  args: Array<string>,
  options: { cwd?: string },
): Promise<GithubCliResult> {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    windowsHide: true,
    maxBuffer: 5 * 1024 * 1024,
  })

  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  }
}

function normalizeGithubIssue(
  payload: GithubIssuePayload,
  config: EffectiveConfig,
  assigneeFilter: Set<string> | null,
): Issue | null {
  const issueNumber = payload.number
  if (typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || !payload.title || !payload.state) {
    return null
  }

  const assignees = normalizeAssignees(payload.assignees)
  const labels = normalizeLabels(payload.labels)
  const state = normalizeGithubState(payload.state)

  return {
    id: String(issueNumber),
    identifier: `GH-${issueNumber}`,
    title: payload.title,
    description: payload.body ?? null,
    priority: priorityFromLabels(labels),
    state,
    branch_name: null,
    url: payload.url ?? issueUrlFromConfig(config, issueNumber),
    assignee_id: assignees[0] ?? null,
    assigned_to_worker: assignedToWorker(assignees, assigneeFilter),
    labels,
    blocked_by: [],
    created_at: payload.createdAt ?? null,
    updated_at: payload.updatedAt ?? null,
  }
}

function normalizeGithubState(state: string): string {
  return state.trim().toLowerCase() === 'closed' ? 'Closed' : 'Open'
}

function normalizeLabels(labels: GithubIssuePayload['labels']): Array<string> {
  if (!Array.isArray(labels)) {
    return []
  }

  return labels
    .map((label) => typeof label === 'string' ? label : label.name)
    .filter((label): label is string => typeof label === 'string' && label.trim().length > 0)
    .map((label) => label.trim().toLowerCase())
}

function normalizeAssignees(assignees: GithubIssuePayload['assignees']): Array<string> {
  if (!Array.isArray(assignees)) {
    return []
  }

  return assignees
    .map((assignee) => typeof assignee === 'string' ? assignee : assignee.login)
    .filter((assignee): assignee is string => typeof assignee === 'string' && assignee.trim().length > 0)
    .map((assignee) => assignee.trim().toLowerCase())
}

function assignedToWorker(assignees: Array<string>, assigneeFilter: Set<string> | null): boolean {
  if (!assigneeFilter) {
    return true
  }

  return assignees.some((assignee) => assigneeFilter.has(assignee))
}

function priorityFromLabels(labels: Array<string>): number | null {
  for (const label of labels) {
    const match = label.match(/^priority[:/\-\s]+([0-9]+)$/)
    if (match?.[1]) {
      return Number(match[1])
    }
  }
  return null
}

function githubCliStatesForStateNames(states: Array<string>): Array<'open' | 'closed'> {
  return Array.from(
    new Set(
      states
        .map(githubCliStateForStateName)
        .filter((state): state is 'open' | 'closed' => state !== null),
    ),
  )
}

function githubCliStateForStateName(state: string): 'open' | 'closed' | null {
  const normalized = state.trim().toLowerCase()
  if (OPEN_STATE_ALIASES.has(normalized)) {
    return 'open'
  }
  if (CLOSED_STATE_ALIASES.has(normalized)) {
    return 'closed'
  }
  return null
}

function githubStateInList(issueState: string, states: Array<string>): boolean {
  if (stateInList(issueState, states)) {
    return true
  }

  const normalizedIssueState = githubCliStateForStateName(issueState)
  return Boolean(
    normalizedIssueState &&
      states.some((state) => githubCliStateForStateName(state) === normalizedIssueState),
  )
}

function labelArgs(labels: Array<string>): Array<string> {
  return labels
    .map((label) => label.trim())
    .filter(Boolean)
    .flatMap((label) => ['--label', label])
}

function repoArgs(config: EffectiveConfig): Array<string> {
  return config.tracker.repository ? ['--repo', config.tracker.repository] : []
}

function githubIssueNumber(issueId: string): number | null {
  const direct = Number(issueId)
  if (Number.isInteger(direct) && direct > 0) {
    return direct
  }

  const hashMatch = issueId.match(/#([0-9]+)$/)
  if (hashMatch?.[1]) {
    return Number(hashMatch[1])
  }

  const identifierMatch = issueId.match(/^GH-([0-9]+)$/i)
  if (identifierMatch?.[1]) {
    return Number(identifierMatch[1])
  }

  return null
}

function requireGithubIssueNumber(issueId: string): number {
  const issueNumber = githubIssueNumber(issueId)
  if (issueNumber === null) {
    throw new SymphonyError('github_unknown_payload', `GitHub issue id ${issueId} does not include an issue number`)
  }
  return issueNumber
}

function issueUrlFromConfig(config: EffectiveConfig, issueNumber: number): string | null {
  return config.tracker.repository ? `https://github.com/${config.tracker.repository}/issues/${issueNumber}` : null
}

function dedupeIssues(issues: Array<Issue>): Array<Issue> {
  const byId = new Map<string, Issue>()
  for (const issue of issues) {
    byId.set(issue.id, issue)
  }
  return Array.from(byId.values())
}

function truncateCliText(value: unknown): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 1000 ? `${text.slice(0, 1000)}...<truncated>` : text
}

function isFailedGithubCliResult(
  error: unknown,
): error is Error & { code?: number | string; stdout?: string; stderr?: string } {
  return error !== null && typeof error === 'object' && ('stdout' in error || 'stderr' in error)
}

import { normalizeStateName, stateInList } from './config'
import type { EffectiveConfig, Issue, IssueTracker } from './types'

export class MockLinearTracker implements IssueTracker {
  private readonly issues = new Map<string, Issue>()

  constructor() {
    for (const issue of createSeedIssues()) {
      this.issues.set(issue.id, issue)
    }
  }

  async fetchCandidateIssues(config: EffectiveConfig): Promise<Array<Issue>> {
    return this.allIssues()
      .filter((issue) => stateInList(issue.state, config.tracker.active_states))
      .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
      .map(cloneIssue)
  }

  async fetchIssuesByStates(states: Array<string>): Promise<Array<Issue>> {
    if (states.length === 0) {
      return []
    }

    return this.allIssues()
      .filter((issue) => stateInList(issue.state, states))
      .map(cloneIssue)
  }

  async fetchIssueStatesByIds(ids: Array<string>): Promise<Array<Issue>> {
    return ids
      .map((id) => this.issues.get(id))
      .filter((issue): issue is Issue => Boolean(issue))
      .map(cloneIssue)
  }

  async createComment(_issueId: string, _body: string): Promise<void> {
    return
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    this.transitionIssue(issueId, stateName)
  }

  transitionIssue(issueId: string, state: string): void {
    const issue = this.issues.get(issueId)
    if (!issue) {
      return
    }

    this.issues.set(issueId, {
      ...issue,
      state,
      updated_at: new Date().toISOString(),
      blocked_by: issue.blocked_by.map((blocker) => ({
        ...blocker,
        state: blocker.state ? normalizeStateName(blocker.state) : blocker.state,
      })),
    })
  }

  private allIssues(): Array<Issue> {
    return Array.from(this.issues.values())
  }
}

export function isMutableMockTracker(tracker: IssueTracker): tracker is MockLinearTracker {
  return tracker instanceof MockLinearTracker
}

function createSeedIssues(): Array<Issue> {
  const now = Date.now()

  return [
    {
      id: 'issue-sym-101',
      identifier: 'SYM-101',
      title: 'Add review-proof handoff to repository workflow',
      description: 'Generate a proof bundle after the agent completes work.',
      priority: 1,
      state: 'In Progress',
      branch_name: 'codex/sym-101-proof-handoff',
      url: 'https://linear.example/SYM-101',
      assignee_id: 'mock-worker',
      assigned_to_worker: true,
      labels: ['codex', 'automation'],
      blocked_by: [],
      created_at: new Date(now - 1000 * 60 * 60 * 7).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 25).toISOString(),
    },
    {
      id: 'issue-sym-102',
      identifier: 'SYM-102',
      title: 'Tighten workspace cleanup around terminal states',
      description: 'Remove stale issue workspaces when Linear reaches a terminal state.',
      priority: 2,
      state: 'Todo',
      branch_name: 'codex/sym-102-cleanup',
      url: 'https://linear.example/SYM-102',
      assignee_id: 'mock-worker',
      assigned_to_worker: true,
      labels: ['codex', 'cleanup'],
      blocked_by: [],
      created_at: new Date(now - 1000 * 60 * 60 * 6).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 12).toISOString(),
    },
    {
      id: 'issue-sym-105',
      identifier: 'SYM-105',
      title: 'Pause before modifying protected release workflow',
      description: 'This ticket demonstrates Codex approval handoff handling.',
      priority: 2,
      state: 'Todo',
      branch_name: 'codex/sym-105-approval-handoff',
      url: 'https://linear.example/SYM-105',
      assignee_id: 'mock-worker',
      assigned_to_worker: true,
      labels: ['codex', 'needs-approval'],
      blocked_by: [],
      created_at: new Date(now - 1000 * 60 * 60 * 5.5).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 10).toISOString(),
    },
    {
      id: 'issue-sym-103',
      identifier: 'SYM-103',
      title: 'Wait for tracker auth hardening',
      description: 'This ticket demonstrates blocker filtering for Todo issues.',
      priority: 3,
      state: 'Todo',
      branch_name: null,
      url: 'https://linear.example/SYM-103',
      assignee_id: 'mock-worker',
      assigned_to_worker: true,
      labels: ['codex'],
      blocked_by: [
        {
          id: 'issue-sym-099',
          identifier: 'SYM-099',
          state: 'In Progress',
          created_at: new Date(now - 1000 * 60 * 60 * 24).toISOString(),
          updated_at: new Date(now - 1000 * 60 * 8).toISOString(),
        },
      ],
      created_at: new Date(now - 1000 * 60 * 60 * 5).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 3).toISOString(),
    },
    {
      id: 'issue-sym-104',
      identifier: 'SYM-104',
      title: 'Expose runtime snapshot through dashboard API',
      description: 'Keep the dashboard as an observability surface only.',
      priority: 4,
      state: 'Done',
      branch_name: 'codex/sym-104-state-api',
      url: 'https://linear.example/SYM-104',
      assignee_id: 'mock-worker',
      assigned_to_worker: true,
      labels: ['codex', 'api'],
      blocked_by: [],
      created_at: new Date(now - 1000 * 60 * 60 * 9).toISOString(),
      updated_at: new Date(now - 1000 * 60 * 40).toISOString(),
    },
  ]
}

function cloneIssue(issue: Issue): Issue {
  return {
    ...issue,
    labels: [...issue.labels],
    blocked_by: issue.blocked_by.map((blocker) => ({ ...blocker })),
  }
}

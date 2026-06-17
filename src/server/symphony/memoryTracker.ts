import { stateInList } from './config'
import type { EffectiveConfig, Issue, IssueTracker } from './types'

export class MemoryTracker implements IssueTracker {
  private readonly issues = new Map<string, Issue>()
  private readonly comments = new Map<string, Array<string>>()

  constructor(seedIssues: Array<Issue> = []) {
    for (const issue of seedIssues) {
      this.issues.set(issue.id, cloneIssue(issue))
    }
  }

  async fetchCandidateIssues(config: EffectiveConfig): Promise<Array<Issue>> {
    return this.allIssues()
      .filter((issue) => stateInList(issue.state, config.tracker.active_states))
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

  async createComment(issueId: string, body: string): Promise<void> {
    const existing = this.comments.get(issueId) ?? []
    this.comments.set(issueId, [...existing, body])
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
    })
  }

  issueComments(issueId: string): Array<string> {
    return [...(this.comments.get(issueId) ?? [])]
  }

  private allIssues(): Array<Issue> {
    return Array.from(this.issues.values())
  }
}

export function isMutableMemoryTracker(tracker: IssueTracker): tracker is MemoryTracker {
  return tracker instanceof MemoryTracker
}

function cloneIssue(issue: Issue): Issue {
  return {
    ...issue,
    labels: [...issue.labels],
    blocked_by: issue.blocked_by.map((blocker) => ({ ...blocker })),
  }
}

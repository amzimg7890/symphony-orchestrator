import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWorkflowConfig } from '../src/server/symphony/config'
import { MemoryTracker } from '../src/server/symphony/memoryTracker'
import type { Issue } from '../src/server/symphony/types'
import { parseWorkflow } from '../src/server/symphony/workflow'

describe('Memory tracker adapter', () => {
  it('serves configured issues and records local writes', async () => {
    const tracker = new MemoryTracker([
      issueFixture({ id: 'issue-1', identifier: 'MEM-1', state: 'Todo' }),
      issueFixture({ id: 'issue-2', identifier: 'MEM-2', state: 'Done' }),
    ])
    const config = configFixture(['Todo'])

    expect((await tracker.fetchCandidateIssues(config)).map((issue) => issue.identifier)).toEqual(['MEM-1'])
    expect((await tracker.fetchIssuesByStates([' todo '])).map((issue) => issue.identifier)).toEqual(['MEM-1'])
    expect((await tracker.fetchIssuesByStates(['Done'])).map((issue) => issue.identifier)).toEqual(['MEM-2'])
    expect((await tracker.fetchIssueStatesByIds(['issue-2', 'missing', 'issue-1'])).map((issue) => issue.identifier)).toEqual([
      'MEM-2',
      'MEM-1',
    ])

    await tracker.createComment('issue-1', 'hello memory')
    expect(tracker.issueComments('issue-1')).toEqual(['hello memory'])

    await tracker.updateIssueState('issue-1', 'Human Review')
    expect((await tracker.fetchIssueStatesByIds(['issue-1']))[0].state).toBe('Human Review')
  })
})

function configFixture(activeStates: Array<string>) {
  const workflow = parseWorkflow(
    [
      '---',
      'tracker:',
      '  kind: memory',
      '  active_states:',
      ...activeStates.map((state) => `    - ${state}`),
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

function issueFixture(overrides: Partial<Issue>): Issue {
  return {
    id: 'issue-memory',
    identifier: 'MEM-0',
    title: 'Memory issue',
    description: null,
    priority: null,
    state: 'Todo',
    branch_name: null,
    url: null,
    assignee_id: null,
    assigned_to_worker: true,
    labels: ['codex'],
    blocked_by: [],
    created_at: null,
    updated_at: null,
    ...overrides,
  }
}

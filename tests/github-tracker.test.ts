import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWorkflowConfig } from '../src/server/symphony/config'
import { SymphonyError } from '../src/server/symphony/errors'
import { GithubTracker, type GithubCliExecutor } from '../src/server/symphony/githubTracker'
import { parseWorkflow } from '../src/server/symphony/workflow'

describe('GitHub tracker adapter', () => {
  it('fetches open GitHub issues through gh with required labels', async () => {
    const config = resolveConfig([])
    const calls: Array<{ command: string; args: Array<string>; cwd?: string }> = []
    const tracker = new GithubTracker(async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd })
      return {
        stdout: JSON.stringify([
          githubIssue({ number: 2, state: 'OPEN', labels: ['codex', 'backend'] }),
          githubIssue({ number: 3, state: 'CLOSED', labels: ['codex'] }),
        ]),
        stderr: '',
      }
    })

    const issues = await tracker.fetchCandidateIssues(config)

    expect(issues.map((issue) => issue.identifier)).toEqual(['GH-2'])
    expect(issues[0]).toMatchObject({
      id: '2',
      state: 'Open',
      labels: ['codex', 'backend'],
      url: 'https://github.com/openai/symphony/issues/2',
      assigned_to_worker: true,
    })
    expect(calls).toEqual([
      {
        command: 'gh',
        cwd: path.dirname(path.resolve('WORKFLOW.md')),
        args: [
          'issue',
          'list',
          '--repo',
          'openai/symphony',
          '--state',
          'open',
          '--limit',
          '1000',
          '--json',
          'number,title,body,state,url,labels,assignees,createdAt,updatedAt',
          '--label',
          'codex',
        ],
      },
    ])
  })

  it('maps Todo/In Progress and Done aliases onto GitHub open and closed states', async () => {
    const config = resolveConfig([
      '  active_states:',
      '    - Todo',
      '    - In Progress',
      '  terminal_states:',
      '    - Done',
    ])
    const calls: Array<Array<string>> = []
    const tracker = new GithubTracker(async (_command, args) => {
      calls.push(args)
      return {
        stdout: JSON.stringify([
          githubIssue({ number: args.includes('closed') ? 5 : 4, state: args.includes('closed') ? 'CLOSED' : 'OPEN' }),
        ]),
        stderr: '',
      }
    })

    expect((await tracker.fetchCandidateIssues(config)).map((issue) => issue.identifier)).toEqual(['GH-4'])
    expect((await tracker.fetchIssuesByStates(['Done'], config)).map((issue) => issue.identifier)).toEqual(['GH-5'])
    await tracker.updateIssueState('4', 'Done', config)
    await tracker.updateIssueState('5', 'In Progress', config)

    expect(calls[0]).toContain('open')
    expect(calls[1]).toContain('closed')
    expect(calls[2]).toEqual(['issue', 'close', '4', '--repo', 'openai/symphony'])
    expect(calls[3]).toEqual(['issue', 'reopen', '5', '--repo', 'openai/symphony'])
  })

  it('filters assignee=me through gh api user and preserves requested state order', async () => {
    const config = resolveConfig(['  assignee: me'])
    const calls: Array<Array<string>> = []
    const tracker = new GithubTracker(async (_command, args) => {
      calls.push(args)
      if (args[0] === 'api') {
        return { stdout: 'amzimg\n', stderr: '' }
      }
      if (args.includes('7')) {
        return { stdout: JSON.stringify(githubIssue({ number: 7, assignees: ['someone-else'] })), stderr: '' }
      }
      return { stdout: JSON.stringify(githubIssue({ number: 6, assignees: ['amzimg'] })), stderr: '' }
    })

    const issues = await tracker.fetchIssueStatesByIds(['7', '6'], config)

    expect(issues.map((issue) => issue.identifier)).toEqual(['GH-7', 'GH-6'])
    expect(issues.map((issue) => issue.assigned_to_worker)).toEqual([false, true])
    expect(calls[0]).toEqual(['api', 'user', '--jq', '.login'])
    expect(calls[1]).toEqual([
      'issue',
      'view',
      '7',
      '--repo',
      'openai/symphony',
      '--json',
      'number,title,body,state,url,labels,assignees,createdAt,updatedAt',
    ])
  })

  it('creates comments and reports gh failures as typed errors', async () => {
    const config = resolveConfig([])
    const calls: Array<Array<string>> = []
    const failingExecutor: GithubCliExecutor = async (_command, args) => {
      calls.push(args)
      if (args[1] === 'comment') {
        return { stdout: '', stderr: '' }
      }
      const error = new Error('exit 1') as Error & { code: number; stdout: string; stderr: string }
      error.code = 1
      error.stdout = ''
      error.stderr = 'issue not found'
      throw error
    }
    const tracker = new GithubTracker(failingExecutor)

    await expect(tracker.createComment('GH-4', 'Ready for review', config)).resolves.toBeUndefined()
    expect(calls[0]).toEqual([
      'issue',
      'comment',
      '4',
      '--repo',
      'openai/symphony',
      '--body',
      'Ready for review',
    ])

    const error = await tracker.fetchIssueStatesByIds(['4'], config).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SymphonyError)
    expect((error as SymphonyError).code).toBe('github_cli_status')
    expect((error as SymphonyError).message).toContain('issue not found')
  })
})

function resolveConfig(extraTrackerLines: Array<string>) {
  const workflow = parseWorkflow(
    [
      '---',
      'tracker:',
      '  kind: github',
      '  repo: openai/symphony',
      '  required_labels:',
      '    - codex',
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

function githubIssue(overrides: Partial<{
  number: number
  state: string
  labels: Array<string | { name?: string | null }>
  assignees: Array<string | { login?: string | null }>
}> = {}) {
  const number = overrides.number ?? 1
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state: overrides.state ?? 'OPEN',
    url: `https://github.com/openai/symphony/issues/${number}`,
    labels: overrides.labels ?? [{ name: 'codex' }],
    assignees: overrides.assignees ?? [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  }
}

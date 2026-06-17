import { describe, expect, it } from 'vitest'
import {
  closeOpenPullRequestsBeforeRemove,
  runWorkspaceBeforeRemove,
  type CommandResult,
  type WorkspaceBeforeRemoveDeps,
} from '../src/server/symphony/workspaceBeforeRemove'

describe('workspace before-remove helper', () => {
  it('prints help and rejects invalid arguments without running commands', async () => {
    const { deps, calls } = fakeDeps()

    await expect(runWorkspaceBeforeRemove(['--help'], deps)).resolves.toBe(0)
    expect(calls.stdout.join('\n')).toContain('workspace:before-remove')
    expect(calls.commands).toEqual([])

    await expect(runWorkspaceBeforeRemove(['--wat'], deps)).resolves.toBe(1)
    expect(calls.stderr[0]).toBe('Invalid option: --wat')
  })

  it('no-ops when current branch is unavailable', async () => {
    const { deps, calls } = fakeDeps({ executables: [] })

    const result = await closeOpenPullRequestsBeforeRemove({}, deps)

    expect(result).toMatchObject({
      branch: null,
      repo: 'openai/symphony',
      closed_pull_requests: [],
      failed_pull_requests: [],
    })
    expect(calls.commands).toEqual([])
    expect(calls.stdout).toEqual([])
    expect(calls.stderr).toEqual([])
  })

  it('no-ops when gh is unavailable or unauthenticated', async () => {
    const noGh = fakeDeps({ executables: ['git'] })

    await expect(closeOpenPullRequestsBeforeRemove({ branch: 'feature/no-gh' }, noGh.deps)).resolves.toMatchObject({
      branch: 'feature/no-gh',
      closed_pull_requests: [],
    })
    expect(noGh.calls.commands).toEqual([])

    const noAuth = fakeDeps({
      commands: {
        'gh auth status': { ok: false, status: 1, output: 'not logged in' },
      },
    })

    await expect(
      closeOpenPullRequestsBeforeRemove({ branch: 'feature/no-auth' }, noAuth.deps),
    ).resolves.toMatchObject({
      branch: 'feature/no-auth',
      closed_pull_requests: [],
    })
    expect(noAuth.calls.commands).toEqual(['gh auth status'])
  })

  it('uses current branch, closes open PRs, and tolerates close failures', async () => {
    const { deps, calls } = fakeDeps({
      commands: {
        'git branch --show-current': { ok: true, output: 'feature/workpad\n' },
        'gh auth status': { ok: true, output: '' },
        'gh pr list --repo owner/repo --head feature/workpad --state open --json number --jq .[].number': {
          ok: true,
          output: '101\n102\n',
        },
        'gh pr close 101 --repo owner/repo --comment Closing because the Linear issue for branch feature/workpad entered a terminal state without merge.':
          { ok: true, output: '' },
        'gh pr close 102 --repo owner/repo --comment Closing because the Linear issue for branch feature/workpad entered a terminal state without merge.':
          { ok: false, status: 17, output: 'boom\n' },
      },
    })

    const result = await closeOpenPullRequestsBeforeRemove({ repo: 'owner/repo' }, deps)

    expect(result).toEqual({
      branch: 'feature/workpad',
      repo: 'owner/repo',
      closed_pull_requests: ['101'],
      failed_pull_requests: ['102'],
    })
    expect(calls.commands).toEqual([
      'git branch --show-current',
      'gh auth status',
      'gh pr list --repo owner/repo --head feature/workpad --state open --json number --jq .[].number',
      'gh pr close 101 --repo owner/repo --comment Closing because the Linear issue for branch feature/workpad entered a terminal state without merge.',
      'gh pr close 102 --repo owner/repo --comment Closing because the Linear issue for branch feature/workpad entered a terminal state without merge.',
    ])
    expect(calls.stdout).toEqual(['Closed PR #101 for branch feature/workpad'])
    expect(calls.stderr).toEqual([
      'Failed to close PR #102 for branch feature/workpad: exit 17 output="boom"',
    ])
  })

  it('no-ops when PR listing fails for the branch', async () => {
    const { deps, calls } = fakeDeps({
      commands: {
        'gh auth status': { ok: true, output: '' },
        'gh pr list --repo openai/symphony --head feature/list-fails --state open --json number --jq .[].number':
          { ok: false, status: 1, output: 'bad query' },
      },
    })

    const result = await closeOpenPullRequestsBeforeRemove({ branch: 'feature/list-fails' }, deps)

    expect(result).toEqual({
      branch: 'feature/list-fails',
      repo: 'openai/symphony',
      closed_pull_requests: [],
      failed_pull_requests: [],
    })
    expect(calls.commands).toEqual([
      'gh auth status',
      'gh pr list --repo openai/symphony --head feature/list-fails --state open --json number --jq .[].number',
    ])
    expect(calls.stdout).toEqual([])
    expect(calls.stderr).toEqual([])
  })
})

function fakeDeps(options: {
  executables?: Array<string>
  commands?: Record<string, CommandResult>
} = {}): {
  deps: WorkspaceBeforeRemoveDeps
  calls: {
    commands: Array<string>
    stdout: Array<string>
    stderr: Array<string>
  }
} {
  const executables = new Set(options.executables ?? ['git', 'gh'])
  const commands = options.commands ?? {}
  const calls = {
    commands: [] as Array<string>,
    stdout: [] as Array<string>,
    stderr: [] as Array<string>,
  }

  return {
    calls,
    deps: {
      findExecutable: async (command) => (executables.has(command) ? command : null),
      runCommand: async (command, args) => {
        const key = [command, ...args].join(' ')
        calls.commands.push(key)
        return commands[key] ?? { ok: true, output: '' }
      },
      stdout: (message) => calls.stdout.push(message),
      stderr: (message) => calls.stderr.push(message),
    },
  }
}

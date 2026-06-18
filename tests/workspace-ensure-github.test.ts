import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureGithubWorkspace,
  parseWorkspaceEnsureGithubArgs,
  runWorkspaceEnsureGithub,
  type CommandResult,
  type WorkspaceEnsureGithubDeps,
} from '../src/server/symphony/workspaceEnsureGithub'

let cleanupDirs: Array<string> = []

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('workspace ensure-github helper', () => {
  it('parses defaults from GitHub and Symphony environment variables', () => {
    expect(
      parseWorkspaceEnsureGithubArgs([], {
        GITHUB_REPOSITORY: 'owner/repo',
        SYMPHONY_WORKSPACE_PATH: '/tmp/workspace',
        SYMPHONY_GH_COMMAND: 'gh-wrapper gh',
        SYMPHONY_WORKSPACE_ENV_FILE: '/tmp/secrets/repo.env',
        SYMPHONY_WORKSPACE_ENV_TARGET: '.env',
      }),
    ).toEqual({
      ok: true,
      help: false,
      repo: 'owner/repo',
      workspace: '/tmp/workspace',
      ghCommand: 'gh-wrapper gh',
      envFile: '/tmp/secrets/repo.env',
      envTarget: '.env',
    })
  })

  it('prints help and rejects invalid arguments without running commands', async () => {
    const { deps, calls } = fakeDeps()

    await expect(runWorkspaceEnsureGithub(['--help'], deps)).resolves.toBe(0)
    expect(calls.stdout.join('\n')).toContain('workspace:ensure-github')
    expect(calls.commands).toEqual([])

    await expect(runWorkspaceEnsureGithub(['--repo', 'not-a-repo'], deps)).resolves.toBe(1)
    expect(calls.stderr[0]).toBe('Repo must use OWNER/REPO or HOST/OWNER/REPO format')
  })

  it('clones a GitHub repository into an empty workspace', async () => {
    const workspace = await tempWorkspace('symphony-ensure-github-clone-')
    const { deps, calls } = fakeDeps({
      commands: {
        'gh repo clone owner/repo .': async ({ cwd }) => {
          await mkdir(path.join(cwd, '.git'))
          return { ok: true, output: '' }
        },
      },
    })

    const result = await ensureGithubWorkspace({ repo: 'owner/repo', workspace }, deps)

    expect(result).toEqual({
      workspace: path.resolve(workspace),
      repo: 'owner/repo',
      action: 'cloned',
    })
    expect((await stat(path.join(workspace, '.git'))).isDirectory()).toBe(true)
    expect(calls.commands).toEqual(['gh repo clone owner/repo .'])
    expect(calls.stdout).toEqual([`Cloned owner/repo into ${path.resolve(workspace)}`])
  })

  it('injects a configured env file into the workspace after cloning', async () => {
    const workspace = await tempWorkspace('symphony-ensure-github-env-clone-')
    const envFile = path.join(await tempWorkspace('symphony-ensure-github-env-source-'), 'repo.env')
    await writeFile(envFile, 'APP_SECRET=local-only\n', 'utf8')
    const { deps, calls } = fakeDeps({
      commands: {
        'gh repo clone owner/repo .': async ({ cwd }) => {
          await mkdir(path.join(cwd, '.git'))
          return { ok: true, output: '' }
        },
      },
    })

    await expect(
      ensureGithubWorkspace({ repo: 'owner/repo', workspace, envFile, envTarget: '.env.local' }, deps),
    ).resolves.toMatchObject({
      action: 'cloned',
    })

    await expect(readFile(path.join(workspace, '.env.local'), 'utf8')).resolves.toBe('APP_SECRET=local-only\n')
    expect(calls.stdout).toEqual([
      'Injected workspace env file: .env.local',
      `Cloned owner/repo into ${path.resolve(workspace)}`,
    ])
  })

  it('skips a workspace that already has a git checkout', async () => {
    const workspace = await tempWorkspace('symphony-ensure-github-skip-')
    await mkdir(path.join(workspace, '.git'))
    const { deps, calls } = fakeDeps()

    await expect(ensureGithubWorkspace({ repo: 'owner/repo', workspace }, deps)).resolves.toMatchObject({
      action: 'skipped',
    })
    expect(calls.commands).toEqual([])
    expect(calls.stdout).toEqual([`Workspace already contains a git checkout: ${path.resolve(workspace)}`])
  })

  it('refreshes a configured env file when reusing an existing checkout', async () => {
    const workspace = await tempWorkspace('symphony-ensure-github-env-skip-')
    const envFile = path.join(await tempWorkspace('symphony-ensure-github-env-source-'), 'repo.env')
    await mkdir(path.join(workspace, '.git'))
    await writeFile(path.join(workspace, '.env.local'), 'APP_SECRET=stale\n', 'utf8')
    await writeFile(envFile, 'APP_SECRET=fresh\n', 'utf8')
    const { deps, calls } = fakeDeps()

    await expect(
      ensureGithubWorkspace({ repo: 'owner/repo', workspace, envFile }, deps),
    ).resolves.toMatchObject({
      action: 'skipped',
    })

    await expect(readFile(path.join(workspace, '.env.local'), 'utf8')).resolves.toBe('APP_SECRET=fresh\n')
    expect(calls.commands).toEqual([])
    expect(calls.stdout).toEqual([
      'Injected workspace env file: .env.local',
      `Workspace already contains a git checkout: ${path.resolve(workspace)}`,
    ])
  })

  it('rejects env injection targets outside the workspace before cloning', async () => {
    const workspace = await tempWorkspace('symphony-ensure-github-env-target-')
    const envFile = path.join(await tempWorkspace('symphony-ensure-github-env-source-'), 'repo.env')
    await writeFile(envFile, 'APP_SECRET=local-only\n', 'utf8')
    const { deps, calls } = fakeDeps()

    await expect(
      ensureGithubWorkspace({ repo: 'owner/repo', workspace, envFile, envTarget: '../.env' }, deps),
    ).rejects.toThrow('Env target must stay inside the workspace')
    expect(calls.commands).toEqual([])
  })

  it('refuses to clone into a non-empty non-git workspace', async () => {
    const workspace = await tempWorkspace('symphony-ensure-github-dirty-')
    await writeFile(path.join(workspace, 'notes.txt'), 'leftover\n', 'utf8')
    const { deps, calls } = fakeDeps()

    await expect(ensureGithubWorkspace({ repo: 'owner/repo', workspace }, deps)).rejects.toThrow(
      'Refusing to clone owner/repo into non-empty non-git workspace',
    )
    expect(calls.commands).toEqual([])
  })

  it('surfaces clone command failures with command output', async () => {
    const workspace = await tempWorkspace('symphony-ensure-github-fail-')
    const { deps } = fakeDeps({
      commands: {
        'gh repo clone owner/repo .': { ok: false, status: 128, output: 'authentication failed\n' },
      },
    })

    await expect(ensureGithubWorkspace({ repo: 'owner/repo', workspace }, deps)).rejects.toThrow(
      'Failed to clone owner/repo',
    )
  })
})

async function tempWorkspace(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  cleanupDirs.push(dir)
  return dir
}

function fakeDeps(options: {
  commands?: Record<
    string,
    CommandResult | ((options: { cwd: string }) => Promise<CommandResult> | CommandResult)
  >
} = {}): {
  deps: WorkspaceEnsureGithubDeps
  calls: {
    commands: Array<string>
    stdout: Array<string>
    stderr: Array<string>
  }
} {
  const commands = options.commands ?? {}
  const calls = {
    commands: [] as Array<string>,
    stdout: [] as Array<string>,
    stderr: [] as Array<string>,
  }

  return {
    calls,
    deps: {
      runCommand: async (command, args, commandOptions) => {
        const key = [command, ...args].join(' ')
        calls.commands.push(key)
        const result = commands[key] ?? { ok: true, output: '' }
        return typeof result === 'function' ? await result(commandOptions) : result
      },
      stdout: (message) => calls.stdout.push(message),
      stderr: (message) => calls.stderr.push(message),
    },
  }
}

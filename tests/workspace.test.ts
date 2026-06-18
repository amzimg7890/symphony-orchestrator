import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SymphonyError } from '../src/server/symphony/errors'
import {
  assertInsideRoot,
  createWorkspaceForIssue,
  removeWorkspaceForIssue,
  runHook,
  sanitizeWorkspaceKey,
} from '../src/server/symphony/workspace'
import type { EffectiveConfig } from '../src/server/symphony/types'

describe('workspace safety', () => {
  it('sanitizes issue identifiers for directory names', () => {
    expect(sanitizeWorkspaceKey('ABC-123')).toBe('ABC-123')
    expect(sanitizeWorkspaceKey('ABC/123:review')).toBe('ABC_123_review')
  })

  it('rejects workspace paths outside the configured root', () => {
    const root = path.resolve('/tmp/symphony')
    const outside = path.resolve('/tmp/other/ABC-123')

    expect(() => assertInsideRoot(outside, root)).toThrow(SymphonyError)
    expect(() => assertInsideRoot(root, root)).toThrow(SymphonyError)
  })

  it('replaces stale non-directory workspace paths', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-workspace-stale-file-'))
    const config = configFixture(dir, {})
    const workspacePath = path.join(dir, 'ABC-123')
    await writeFile(workspacePath, 'old state\n', 'utf8')

    try {
      const workspace = await createWorkspaceForIssue('ABC-123', config)

      expect(workspace.path).toBe(await realpath(workspacePath))
      expect(workspace.created_now).toBe(true)
      expect((await stat(workspacePath)).isDirectory()).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects symlink escapes under the configured workspace root', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-workspace-symlink-escape-'))
    const workspaceRoot = path.join(dir, 'workspaces')
    const outsideRoot = path.join(dir, 'outside')
    const symlinkPath = path.join(workspaceRoot, 'ABC-123')
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(outsideRoot, { recursive: true })
    await symlinkDirectory(outsideRoot, symlinkPath)

    try {
      await expect(createWorkspaceForIssue('ABC-123', configFixture(workspaceRoot, {}))).rejects.toMatchObject({
        code: 'workspace_error',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('canonicalizes symlinked workspace roots before creating issue directories', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-workspace-root-symlink-'))
    const actualRoot = path.join(dir, 'actual-workspaces')
    const linkedRoot = path.join(dir, 'linked-workspaces')
    await mkdir(actualRoot, { recursive: true })
    await symlinkDirectory(actualRoot, linkedRoot)

    try {
      const workspace = await createWorkspaceForIssue('ABC-123', configFixture(linkedRoot, {}))
      const expectedWorkspacePath = path.join(actualRoot, 'ABC-123')

      expect(await realpath(workspace.path)).toBe(await realpath(expectedWorkspacePath))
      expect(workspace.path).toBe(await realpath(expectedWorkspacePath))
      expect((await stat(expectedWorkspacePath)).isDirectory()).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('skips before_remove hooks when the workspace directory is already missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-workspace-missing-'))
    const config = configFixture(dir, {
      beforeRemove: failingHook(),
    })

    try {
      await expect(removeWorkspaceForIssue('ABC-123', config)).resolves.toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns before_remove hook failures while still deleting an existing workspace', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-workspace-remove-'))
    const config = configFixture(dir, {
      beforeRemove: failingHook(),
    })
    const workspacePath = path.join(dir, 'ABC-123')
    await mkdir(workspacePath)

    try {
      const error = await removeWorkspaceForIssue('ABC-123', config)

      expect(error).toBeInstanceOf(SymphonyError)
      expect(error?.code).toBe('hook_error')
      await expect(stat(workspacePath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('removes a newly-created workspace when after_create fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-workspace-after-create-'))
    const config = configFixture(dir, {
      afterCreate: failingHook(),
    })
    const workspacePath = path.join(dir, 'ABC-123')

    try {
      await expect(createWorkspaceForIssue('ABC-123', config)).rejects.toMatchObject({
        code: 'hook_error',
      })
      await expect(stat(workspacePath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('creates, hooks, and removes remote workspaces over ssh', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-remote-workspace-'))
    const remoteWorkspace = '/remote/home/.symphony-workspaces/ABC-123'
    const traceFile = path.join(dir, 'ssh.trace')
    const restoreSsh = await installFakeSsh(dir, traceFile, remoteWorkspace)
    const config = configFixture('~/.symphony-workspaces', {
      afterCreate: 'echo after-create',
      beforeRemove: 'echo before-remove',
    })

    try {
      const workspace = await createWorkspaceForIssue('ABC-123', config, 'worker-01:2200')
      await runHook('echo before-run', workspace.path, config.hooks.timeout_ms, 'before_run', 'worker-01:2200')
      await expect(removeWorkspaceForIssue('ABC-123', config, 'worker-01:2200')).resolves.toBeNull()

      expect(workspace).toEqual({
        path: remoteWorkspace,
        workspace_key: 'ABC-123',
        created_now: true,
      })

      const trace = await readFile(traceFile, 'utf8')
      expect(trace).toContain('-p')
      expect(trace).toContain('2200')
      expect(trace).toContain('worker-01')
      expect(trace).toContain('__SYMPHONY_WORKSPACE__')
      expect(trace).toContain('~/.symphony-workspaces/ABC-123')
      expect(trace).toContain('after-create')
      expect(trace).toContain('before-run')
      expect(trace).toContain('before-remove')
      expect(trace).toContain('rm -rf')
    } finally {
      restoreSsh()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('surfaces hook failure output as truncated structured details', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-workspace-hook-output-'))
    const stdout = 'a'.repeat(2100) + 'TAIL'
    const stderr = 'b'.repeat(30)

    try {
      const error = await runHook(nodeHook(`
        process.stdout.write(${JSON.stringify(stdout)});
        process.stderr.write(${JSON.stringify(stderr)});
        process.exit(17);
      `), dir, 5000, 'before_remove').catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(SymphonyError)
      expect((error as SymphonyError).message).toContain('exit_code=17')
      expect((error as SymphonyError).message).toContain('... (truncated)')

      const payload = (error as SymphonyError).toPayload()
      expect(payload.details).toMatchObject({
        hook_name: 'before_remove',
        cwd: dir,
        timeout_ms: 5000,
        exit_code: 17,
        stdout_truncated: true,
        stderr_truncated: false,
        stdout_bytes: Buffer.byteLength(stdout),
        stderr_bytes: Buffer.byteLength(stderr),
        stderr,
      })
      expect(payload.details?.stdout).toContain('... (truncated)')
      expect(payload.details?.stdout).not.toContain('TAIL')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function failingHook(): string {
  return `"${process.execPath.replaceAll('\\', '/')}" -e "process.exit(1)"`
}

function nodeHook(source: string): string {
  return `"${process.execPath.replaceAll('\\', '/')}" -e ${JSON.stringify(source.replace(/\s+/g, ' ').trim())}`
}

async function symlinkDirectory(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

async function installFakeSsh(
  dir: string,
  traceFile: string,
  remoteWorkspace: string,
): Promise<() => void> {
  const previousPath = process.env.PATH
  const previousSshBin = process.env.SYMPHONY_SSH_BIN
  const previousSshBinArgs = process.env.SYMPHONY_SSH_BIN_ARGS
  const previousTrace = process.env.SYMPHONY_FAKE_SSH_TRACE
  const previousWorkspace = process.env.SYMPHONY_FAKE_REMOTE_WORKSPACE
  const fakeSshScript = path.join(dir, 'fake-ssh.mjs')

  await writeFile(
    fakeSshScript,
    [
      "import fs from 'node:fs'",
      "const traceFile = process.env.SYMPHONY_FAKE_SSH_TRACE",
      "const remoteWorkspace = process.env.SYMPHONY_FAKE_REMOTE_WORKSPACE",
      'const argv = process.argv.slice(2)',
      'const command = argv.at(-1) ?? ""',
      'fs.appendFileSync(traceFile, `ARGV:${argv.join(" ")}\\nCOMMAND:${command}\\n`, "utf8")',
      'if (command.includes("__SYMPHONY_WORKSPACE__")) {',
      '  console.log(`__SYMPHONY_WORKSPACE__\\t1\\t${remoteWorkspace}`)',
      '}',
    ].join('\n'),
    'utf8',
  )

  process.env.PATH = previousPath ? `${dir}${path.delimiter}${previousPath}` : dir
  process.env.SYMPHONY_SSH_BIN = process.execPath
  process.env.SYMPHONY_SSH_BIN_ARGS = JSON.stringify([fakeSshScript])
  process.env.SYMPHONY_FAKE_SSH_TRACE = traceFile
  process.env.SYMPHONY_FAKE_REMOTE_WORKSPACE = remoteWorkspace

  return () => {
    restoreEnv('PATH', previousPath)
    restoreEnv('SYMPHONY_SSH_BIN', previousSshBin)
    restoreEnv('SYMPHONY_SSH_BIN_ARGS', previousSshBinArgs)
    restoreEnv('SYMPHONY_FAKE_SSH_TRACE', previousTrace)
    restoreEnv('SYMPHONY_FAKE_REMOTE_WORKSPACE', previousWorkspace)
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }

  process.env[key] = value
}

function configFixture(
  workspaceRoot: string,
  hooks: {
    afterCreate?: string
    beforeRemove?: string
  },
): EffectiveConfig {
  return {
    workflow_path: path.join(workspaceRoot, 'WORKFLOW.md'),
    workflow_directory: workspaceRoot,
    tracker: {
      kind: 'linear',
      endpoint: 'https://api.linear.app/graphql',
      api_key: 'token',
      project_slug: 'demo',
      repository: null,
      gh_command: 'gh',
      assignee: null,
      required_labels: [],
      active_states: ['Todo'],
      terminal_states: ['Done'],
      memory_issues: [],
    },
    polling: {
      interval_ms: 30_000,
    },
    workspace: {
      root: workspaceRoot,
    },
    worker: {
      ssh_hosts: [],
      max_concurrent_agents_per_host: null,
    },
    hooks: {
      after_create: hooks.afterCreate ?? null,
      before_run: null,
      after_run: null,
      before_remove: hooks.beforeRemove ?? null,
      timeout_ms: 1000,
    },
    agent: {
      runner: 'simulated',
      max_concurrent_agents: 1,
      max_turns: 1,
      max_retry_backoff_ms: 10_000,
      max_concurrent_agents_by_state: {},
    },
    codex: {
      command: 'codex app-server',
      model: null,
      approval_policy: null,
      approvals_reviewer: null,
      thread_sandbox: null,
      turn_sandbox_policy: null,
      turn_timeout_ms: 1000,
      read_timeout_ms: 1000,
      stall_timeout_ms: 0,
    },
    server: {
      port: null,
      host: '127.0.0.1',
    },
    logging: {
      enabled: false,
      root: path.join(workspaceRoot, 'logs'),
      file: 'symphony.jsonl',
    },
    observability: {
      dashboard_enabled: true,
      refresh_ms: 1000,
      render_interval_ms: 16,
    },
    demo: {
      mock_tracker: true,
    },
  }
}

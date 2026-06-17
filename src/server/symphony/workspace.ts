import { exec } from 'node:child_process'
import { lstat, mkdir, realpath, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { SymphonyError } from './errors'
import { runSshCommand, shellEscape, type SshCommandResult } from './ssh'
import type { EffectiveConfig, Workspace } from './types'

const execAsync = promisify(exec)
const remoteWorkspaceMarker = '__SYMPHONY_WORKSPACE__'
const hookOutputDetailMaxBytes = 2048
const hookOutputMessageMaxBytes = 512
const removeMaxRetries = 10
const removeRetryDelayMs = 100

type ExecHookError = Error & {
  code?: unknown
  killed?: unknown
  signal?: unknown
  stdout?: unknown
  stderr?: unknown
}

type HookOutputPreview = {
  text: string
  bytes: number
  truncated: boolean
}

export function sanitizeWorkspaceKey(issueIdentifier: string): string {
  return issueIdentifier.replace(/[^A-Za-z0-9._-]/g, '_')
}

export function workspacePathForIssue(issueIdentifier: string, config: EffectiveConfig): string {
  const workspaceRoot = path.resolve(config.workspace.root)
  const workspaceKey = sanitizeWorkspaceKey(issueIdentifier)
  const workspacePath = path.resolve(workspaceRoot, workspaceKey)
  assertInsideRoot(workspacePath, workspaceRoot)
  return workspacePath
}

export async function createWorkspaceForIssue(
  issueIdentifier: string,
  config: EffectiveConfig,
  workerHost: string | null = null,
): Promise<Workspace> {
  if (workerHost) {
    return createRemoteWorkspaceForIssue(issueIdentifier, config, workerHost)
  }

  const workspaceRoot = path.resolve(config.workspace.root)
  const workspaceKey = sanitizeWorkspaceKey(issueIdentifier)
  const requestedWorkspacePath = path.resolve(workspaceRoot, workspaceKey)

  assertInsideRoot(requestedWorkspacePath, workspaceRoot)
  await mkdir(workspaceRoot, { recursive: true })
  const canonicalRoot = await canonicalizePath(workspaceRoot)
  const workspacePath = await canonicalizePath(requestedWorkspacePath)
  assertInsideRoot(workspacePath, canonicalRoot)

  let createdNow = false
  try {
    const existing = await lstat(workspacePath)
    if (!existing.isDirectory()) {
      await removePath(workspacePath)
      await mkdir(workspacePath, { recursive: true })
      createdNow = true
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error
    }

    await mkdir(workspacePath, { recursive: true })
    createdNow = true
  }

  if (createdNow && config.hooks.after_create) {
    try {
      await runHook(config.hooks.after_create, workspacePath, config.hooks.timeout_ms, 'after_create')
    } catch (error) {
      await removePath(workspacePath)
      throw error
    }
  }

  return {
    path: workspacePath,
    workspace_key: workspaceKey,
    created_now: createdNow,
  }
}

export async function removeWorkspaceForIssue(
  issueIdentifier: string,
  config: EffectiveConfig,
  workerHost: string | null = null,
): Promise<SymphonyError | null> {
  if (workerHost) {
    return removeRemoteWorkspaceForIssue(issueIdentifier, config, workerHost)
  }

  if (config.worker.ssh_hosts.length > 0) {
    let firstHookError: SymphonyError | null = null
    for (const host of config.worker.ssh_hosts) {
      const hookError = await removeRemoteWorkspaceForIssue(issueIdentifier, config, host)
      firstHookError ??= hookError
    }
    return firstHookError
  }

  const requestedWorkspacePath = workspacePathForIssue(issueIdentifier, config)
  const canonicalRoot = await canonicalizePath(config.workspace.root)
  const workspacePath = await canonicalizePath(requestedWorkspacePath)
  assertInsideRoot(workspacePath, canonicalRoot)
  let hookError: SymphonyError | null = null
  const existingWorkspace = await stat(workspacePath).catch(() => null)

  if (!existingWorkspace?.isDirectory()) {
    await removePath(workspacePath)
    return null
  }

  if (config.hooks.before_remove) {
    hookError = await runHookBestEffort(
      config.hooks.before_remove,
      workspacePath,
      config.hooks.timeout_ms,
      'before_remove',
    )
  }

  await removePath(workspacePath)

  return hookError
}

async function createRemoteWorkspaceForIssue(
  issueIdentifier: string,
  config: EffectiveConfig,
  workerHost: string,
): Promise<Workspace> {
  const workspaceKey = sanitizeWorkspaceKey(issueIdentifier)
  const requestedWorkspacePath = remoteWorkspacePath(workspaceKey, config)
  assertValidRemotePath(requestedWorkspacePath, remoteWorkspaceRoot(config), workerHost)

  const prepare = await runRemoteWorkspaceScript(workerHost, [
    'set -eu',
    remoteShellAssign('workspace', requestedWorkspacePath),
    'if [ -d "$workspace" ]; then',
    '  created=0',
    'elif [ -e "$workspace" ]; then',
    '  rm -rf "$workspace"',
    '  mkdir -p "$workspace"',
    '  created=1',
    'else',
    '  mkdir -p "$workspace"',
    '  created=1',
    'fi',
    'cd "$workspace"',
    `printf '%s\\t%s\\t%s\\n' '${remoteWorkspaceMarker}' "$created" "$(pwd -P)"`,
  ], config.hooks.timeout_ms, 'workspace_prepare')

  if (prepare.exit_code !== 0 || prepare.timed_out) {
    throw workspaceSshError('workspace_error', 'Remote workspace preparation failed', prepare, {
      worker_host: workerHost,
      workspace_path: requestedWorkspacePath,
    })
  }

  const parsed = parseRemoteWorkspaceOutput(prepare.stdout)
  if (!parsed) {
    throw new SymphonyError('workspace_error', 'Remote workspace preparation returned an invalid response', {
      details: {
        worker_host: workerHost,
        workspace_path: requestedWorkspacePath,
        stdout: prepare.stdout,
        stderr: prepare.stderr,
      },
    })
  }

  if (parsed.created_now && config.hooks.after_create) {
    try {
      await runHook(config.hooks.after_create, parsed.path, config.hooks.timeout_ms, 'after_create', workerHost)
    } catch (error) {
      await removeRemotePath(parsed.path, config, workerHost)
      throw error
    }
  }

  return {
    path: parsed.path,
    workspace_key: workspaceKey,
    created_now: parsed.created_now,
  }
}

async function removeRemoteWorkspaceForIssue(
  issueIdentifier: string,
  config: EffectiveConfig,
  workerHost: string,
): Promise<SymphonyError | null> {
  const workspaceKey = sanitizeWorkspaceKey(issueIdentifier)
  const workspacePath = remoteWorkspacePath(workspaceKey, config)
  assertValidRemotePath(workspacePath, remoteWorkspaceRoot(config), workerHost)

  const hookError = await runRemoteBeforeRemoveHook(workspacePath, config, workerHost)
  await removeRemotePath(workspacePath, config, workerHost)
  return hookError
}

async function runRemoteBeforeRemoveHook(
  workspacePath: string,
  config: EffectiveConfig,
  workerHost: string,
): Promise<SymphonyError | null> {
  if (!config.hooks.before_remove) {
    return null
  }

  const result = await runSshCommand(
    workerHost,
    [
      remoteShellAssign('workspace', workspacePath),
      'if [ -d "$workspace" ]; then',
      '  cd "$workspace"',
      `  ${config.hooks.before_remove}`,
      'fi',
    ].join('\n'),
    config.hooks.timeout_ms,
  )

  if (result.exit_code === 0 && !result.timed_out) {
    return null
  }

  const details = remoteHookErrorDetails(
    result,
    workspacePath,
    config.hooks.timeout_ms,
    'before_remove',
    workerHost,
    hookOutputDetailMaxBytes,
  )
  const messageDetails = remoteHookErrorDetails(
    result,
    workspacePath,
    config.hooks.timeout_ms,
    'before_remove',
    workerHost,
    hookOutputMessageMaxBytes,
  )
  return new SymphonyError('hook_error', hookErrorMessage(messageDetails), {
    details,
  })
}

async function removeRemotePath(
  workspacePath: string,
  config: EffectiveConfig,
  workerHost: string,
): Promise<void> {
  const result = await runRemoteWorkspaceScript(workerHost, [
    remoteShellAssign('workspace', workspacePath),
    'rm -rf "$workspace"',
  ], config.hooks.timeout_ms, 'workspace_remove')

  if (result.exit_code !== 0 || result.timed_out) {
    throw workspaceSshError('workspace_error', 'Remote workspace removal failed', result, {
      worker_host: workerHost,
      workspace_path: workspacePath,
    })
  }
}

async function removePath(pathToRemove: string): Promise<void> {
  await rm(pathToRemove, {
    recursive: true,
    force: true,
    maxRetries: removeMaxRetries,
    retryDelay: removeRetryDelayMs,
  })
}

export async function runHook(
  script: string,
  cwd: string,
  timeoutMs: number,
  hookName: string,
  workerHost: string | null = null,
): Promise<void> {
  if (workerHost) {
    const result = await runSshCommand(workerHost, `cd ${shellEscape(cwd)} && ${script}`, timeoutMs)
    if (result.exit_code === 0 && !result.timed_out) {
      return
    }

    const details = remoteHookErrorDetails(result, cwd, timeoutMs, hookName, workerHost, hookOutputDetailMaxBytes)
    const messageDetails = remoteHookErrorDetails(result, cwd, timeoutMs, hookName, workerHost, hookOutputMessageMaxBytes)
    throw new SymphonyError('hook_error', hookErrorMessage(messageDetails), {
      details,
    })
  }

  try {
    await execAsync(script, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    })
  } catch (error) {
    const details = hookErrorDetails(error, cwd, timeoutMs, hookName, hookOutputDetailMaxBytes)
    const messageDetails = hookErrorDetails(error, cwd, timeoutMs, hookName, hookOutputMessageMaxBytes)
    throw new SymphonyError('hook_error', hookErrorMessage(messageDetails), {
      cause: error,
      details,
    })
  }
}

export async function runHookBestEffort(
  script: string | null,
  cwd: string,
  timeoutMs: number,
  hookName = 'best_effort',
  workerHost: string | null = null,
): Promise<SymphonyError | null> {
  if (!script) {
    return null
  }

  try {
    await runHook(script, cwd, timeoutMs, hookName, workerHost)
    return null
  } catch (error) {
    return error instanceof SymphonyError
      ? error
      : new SymphonyError('hook_error', `${hookName} hook failed in ${cwd}`, { cause: error })
  }
}

export function assertInsideRoot(candidatePath: string, rootPath: string): void {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath))
  if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return
  }

  throw new SymphonyError(
    'workspace_error',
    `Workspace path ${candidatePath} must stay inside workspace root ${rootPath}`,
  )
}

function remoteWorkspacePath(workspaceKey: string, config: EffectiveConfig): string {
  const root = remoteWorkspaceRoot(config).replace(/[\\/]+$/, '')
  return root ? `${root}/${workspaceKey}` : workspaceKey
}

function remoteWorkspaceRoot(config: EffectiveConfig): string {
  return config.workspace.remote_root ?? config.workspace.root
}

function assertValidRemotePath(workspacePath: string, rootPath: string, workerHost: string): void {
  if (!workspacePath.trim() || !rootPath.trim()) {
    throw new SymphonyError('workspace_error', `Remote workspace path for ${workerHost} must not be empty`)
  }

  if (/[\n\r\0]/.test(workspacePath) || /[\n\r\0]/.test(rootPath)) {
    throw new SymphonyError('workspace_error', `Remote workspace path for ${workerHost} contains invalid characters`)
  }
}

function remoteShellAssign(variableName: string, rawPath: string): string {
  return [
    `${variableName}=${shellEscape(rawPath)}`,
    `case "$${variableName}" in`,
    `  '~') ${variableName}="$HOME" ;;`,
    `  '~/'*) ${variableName}="$HOME/\${${variableName}#~/}" ;;`,
    'esac',
  ].join('\n')
}

function parseRemoteWorkspaceOutput(output: string): { path: string; created_now: boolean } | null {
  for (const line of output.split('\n')) {
    const [marker, created, workspacePath] = line.split('\t')
    if (marker === remoteWorkspaceMarker && (created === '0' || created === '1') && workspacePath) {
      return {
        path: workspacePath,
        created_now: created === '1',
      }
    }
  }

  return null
}

async function runRemoteWorkspaceScript(
  workerHost: string,
  lines: Array<string>,
  timeoutMs: number,
  _operation: string,
): Promise<SshCommandResult> {
  return await runSshCommand(workerHost, lines.join('\n'), timeoutMs)
}

function workspaceSshError(
  code: 'workspace_error',
  message: string,
  result: SshCommandResult,
  extraDetails: Record<string, unknown>,
): SymphonyError {
  return new SymphonyError(code, message, {
    details: {
      ...extraDetails,
      timed_out: result.timed_out,
      exit_code: result.exit_code,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    },
  })
}

async function canonicalizePath(inputPath: string): Promise<string> {
  const resolvedPath = path.resolve(inputPath)
  const parsed = path.parse(resolvedPath)
  const relativePath = path.relative(parsed.root, resolvedPath)
  const segments = relativePath ? relativePath.split(path.sep).filter(Boolean) : []

  let currentPath = parsed.root
  for (let index = 0; index < segments.length; index += 1) {
    const candidatePath = path.join(currentPath, segments[index])

    try {
      const stats = await lstat(candidatePath)
      if (stats.isSymbolicLink()) {
        currentPath = await realpath(candidatePath)
      } else {
        currentPath = candidatePath
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        return path.join(candidatePath, ...segments.slice(index + 1))
      }

      throw new SymphonyError(
        'workspace_error',
        `Unable to inspect workspace path ${candidatePath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  return currentPath
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function hookErrorDetails(
  error: unknown,
  cwd: string,
  timeoutMs: number,
  hookName: string,
  maxOutputBytes: number,
): Record<string, unknown> {
  const execError = error as ExecHookError
  const stdout = previewHookOutput(execError.stdout, maxOutputBytes)
  const stderr = previewHookOutput(execError.stderr, maxOutputBytes)

  return omitUndefined({
    hook_name: hookName,
    cwd,
    timeout_ms: timeoutMs,
    exit_code: normalizeExitCode(execError.code),
    signal: normalizeSignal(execError.signal),
    timed_out: execError.killed === true && execError.signal !== undefined,
    stdout: stdout.text,
    stderr: stderr.text,
    stdout_bytes: stdout.bytes,
    stderr_bytes: stderr.bytes,
    stdout_truncated: stdout.truncated,
    stderr_truncated: stderr.truncated,
  })
}

function remoteHookErrorDetails(
  result: SshCommandResult,
  cwd: string,
  timeoutMs: number,
  hookName: string,
  workerHost: string,
  maxOutputBytes: number,
): Record<string, unknown> {
  const stdout = previewHookOutput(result.stdout, maxOutputBytes)
  const stderr = previewHookOutput(result.stderr, maxOutputBytes)

  return omitUndefined({
    hook_name: hookName,
    cwd,
    worker_host: workerHost,
    timeout_ms: timeoutMs,
    exit_code: result.exit_code,
    signal: result.signal,
    timed_out: result.timed_out,
    stdout: stdout.text,
    stderr: stderr.text,
    stdout_bytes: stdout.bytes,
    stderr_bytes: stderr.bytes,
    stdout_truncated: stdout.truncated,
    stderr_truncated: stderr.truncated,
  })
}

function hookErrorMessage(details: Record<string, unknown>): string {
  const base = `${details.hook_name} hook failed in ${details.cwd}`
  const metadata = [
    details.timed_out === true ? `timeout_ms=${details.timeout_ms}` : null,
    details.exit_code !== undefined && details.exit_code !== null
      ? `exit_code=${details.exit_code}`
      : null,
    details.signal ? `signal=${details.signal}` : null,
  ].filter(Boolean)
  const output = [
    typeof details.stdout === 'string' && details.stdout.length > 0
      ? `stdout=${JSON.stringify(details.stdout)}`
      : null,
    typeof details.stderr === 'string' && details.stderr.length > 0
      ? `stderr=${JSON.stringify(details.stderr)}`
      : null,
  ].filter(Boolean)

  return [base, metadata.length > 0 ? `(${metadata.join('; ')})` : null, ...output]
    .filter(Boolean)
    .join(' ')
}

function previewHookOutput(output: unknown, maxBytes: number): HookOutputPreview {
  const text = output === undefined || output === null ? '' : String(output)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes) {
    return { text, bytes, truncated: false }
  }

  return {
    text: `${Buffer.from(text).subarray(0, maxBytes).toString('utf8')}... (truncated)`,
    bytes,
    truncated: true,
  }
}

function normalizeExitCode(value: unknown): number | string | null | undefined {
  if (value === undefined || value === null) {
    return value
  }

  if (typeof value === 'number' || typeof value === 'string') {
    return value
  }

  return String(value)
}

function normalizeSignal(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return value
  }

  return String(value)
}

function omitUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

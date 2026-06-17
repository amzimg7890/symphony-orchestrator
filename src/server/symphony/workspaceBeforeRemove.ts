import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const defaultRepo = 'openai/symphony'

export type CommandResult =
  | {
      ok: true
      output: string
    }
  | {
      ok: false
      status: number | null
      output: string
    }

export type WorkspaceBeforeRemoveDeps = {
  findExecutable: (command: string) => Promise<string | null>
  runCommand: (command: string, args: Array<string>) => Promise<CommandResult>
  stdout: (message: string) => void
  stderr: (message: string) => void
}

export type WorkspaceBeforeRemoveResult = {
  branch: string | null
  repo: string
  closed_pull_requests: Array<string>
  failed_pull_requests: Array<string>
}

export type ParsedWorkspaceBeforeRemoveArgs =
  | {
      ok: true
      help: boolean
      branch: string | null
      repo: string
    }
  | {
      ok: false
      error: string
    }

export function workspaceBeforeRemoveUsage(): string {
  return [
    'Usage: npm run workspace:before-remove -- [--branch BRANCH] [--repo OWNER/REPO]',
    '',
    'Closes open GitHub pull requests for the current Git branch before workspace removal.',
  ].join('\n')
}

export function parseWorkspaceBeforeRemoveArgs(args: Array<string>): ParsedWorkspaceBeforeRemoveArgs {
  let branch: string | null = null
  let repo = defaultRepo

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      return { ok: true, help: true, branch: null, repo }
    }

    if (arg === '--branch' || arg === '--repo') {
      const value = args[index + 1]
      if (!value) {
        return { ok: false, error: `Missing value for ${arg}` }
      }

      if (arg === '--branch') {
        branch = value
      } else {
        repo = value
      }
      index += 1
      continue
    }

    if (arg.startsWith('--branch=')) {
      branch = arg.slice('--branch='.length)
      continue
    }

    if (arg.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length)
      continue
    }

    return { ok: false, error: `Invalid option: ${arg}` }
  }

  if (branch !== null && branch.trim() === '') {
    return { ok: false, error: 'Branch must not be blank' }
  }

  if (repo.trim() === '') {
    return { ok: false, error: 'Repo must not be blank' }
  }

  return {
    ok: true,
    help: false,
    branch,
    repo,
  }
}

export async function runWorkspaceBeforeRemove(
  args: Array<string>,
  deps: WorkspaceBeforeRemoveDeps = createRuntimeWorkspaceBeforeRemoveDeps(),
): Promise<number> {
  const parsed = parseWorkspaceBeforeRemoveArgs(args)
  if (!parsed.ok) {
    deps.stderr(parsed.error)
    deps.stderr(workspaceBeforeRemoveUsage())
    return 1
  }

  if (parsed.help) {
    deps.stdout(workspaceBeforeRemoveUsage())
    return 0
  }

  await closeOpenPullRequestsBeforeRemove(
    {
      repo: parsed.repo,
      branch: parsed.branch,
    },
    deps,
  )
  return 0
}

export async function closeOpenPullRequestsBeforeRemove(
  options: { repo?: string; branch?: string | null },
  deps: WorkspaceBeforeRemoveDeps = createRuntimeWorkspaceBeforeRemoveDeps(),
): Promise<WorkspaceBeforeRemoveResult> {
  const repo = options.repo?.trim() || defaultRepo
  const branch = options.branch?.trim() || (await currentBranch(deps))
  const result: WorkspaceBeforeRemoveResult = {
    branch,
    repo,
    closed_pull_requests: [],
    failed_pull_requests: [],
  }

  if (!branch) {
    return result
  }

  if (!(await deps.findExecutable('gh'))) {
    return result
  }

  const auth = await deps.runCommand('gh', ['auth', 'status'])
  if (!auth.ok) {
    return result
  }

  const pullRequests = await listOpenPullRequestNumbers(repo, branch, deps)
  for (const pullRequest of pullRequests) {
    const close = await deps.runCommand('gh', [
      'pr',
      'close',
      pullRequest,
      '--repo',
      repo,
      '--comment',
      closingComment(branch),
    ])

    if (close.ok) {
      result.closed_pull_requests.push(pullRequest)
      deps.stdout(`Closed PR #${pullRequest} for branch ${branch}`)
    } else {
      result.failed_pull_requests.push(pullRequest)
      deps.stderr(
        `Failed to close PR #${pullRequest} for branch ${branch}: exit ${close.status ?? 'unknown'}${formatCommandOutput(
          close.output,
        )}`,
      )
    }
  }

  return result
}

export function createRuntimeWorkspaceBeforeRemoveDeps(): WorkspaceBeforeRemoveDeps {
  return {
    findExecutable,
    runCommand,
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  }
}

async function currentBranch(deps: WorkspaceBeforeRemoveDeps): Promise<string | null> {
  if (!(await deps.findExecutable('git'))) {
    return null
  }

  const branch = await deps.runCommand('git', ['branch', '--show-current'])
  if (!branch.ok) {
    return null
  }

  const trimmed = branch.output.trim()
  return trimmed === '' ? null : trimmed
}

async function listOpenPullRequestNumbers(
  repo: string,
  branch: string,
  deps: WorkspaceBeforeRemoveDeps,
): Promise<Array<string>> {
  const result = await deps.runCommand('gh', [
    'pr',
    'list',
    '--repo',
    repo,
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number',
    '--jq',
    '.[].number',
  ])

  if (!result.ok) {
    return []
  }

  return result.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function closingComment(branch: string): string {
  return `Closing because the Linear issue for branch ${branch} entered a terminal state without merge.`
}

function formatCommandOutput(output: string): string {
  const trimmed = output.trim()
  return trimmed ? ` output=${JSON.stringify(trimmed)}` : ''
}

async function runCommand(command: string, args: Array<string>): Promise<CommandResult> {
  const executable = await findExecutable(command)
  if (!executable) {
    return { ok: false, status: null, output: '' }
  }

  try {
    const result = await execFileAsync(executable, args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    })
    return { ok: true, output: `${result.stdout}${result.stderr}` }
  } catch (error) {
    const execError = error as Error & { code?: unknown; stdout?: unknown; stderr?: unknown }
    return {
      ok: false,
      status: typeof execError.code === 'number' ? execError.code : null,
      output: `${execError.stdout ?? ''}${execError.stderr ?? ''}`,
    }
  }
}

async function findExecutable(command: string): Promise<string | null> {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const candidates = executableCandidates(command)

  for (const directory of pathEntries) {
    for (const candidate of candidates) {
      const executablePath = path.join(directory, candidate)
      try {
        await access(executablePath, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        return executablePath
      } catch {
        // Try the next candidate.
      }
    }
  }

  return null
}

function executableCandidates(command: string): Array<string> {
  if (path.extname(command)) {
    return [command]
  }

  if (process.platform !== 'win32') {
    return [command]
  }

  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean)

  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)]
}

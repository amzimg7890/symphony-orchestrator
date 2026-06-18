import { execFile } from 'node:child_process'
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { githubCommandParts } from './githubTracker'

const execFileAsync = promisify(execFile)

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

export type WorkspaceEnsureGithubDeps = {
  runCommand: (
    command: string,
    args: Array<string>,
    options: { cwd: string },
  ) => Promise<CommandResult>
  stdout: (message: string) => void
  stderr: (message: string) => void
}

export type WorkspaceEnsureGithubResult = {
  workspace: string
  repo: string
  action: 'cloned' | 'skipped'
}

export type ParsedWorkspaceEnsureGithubArgs =
  | {
      ok: true
      help: boolean
      repo: string
      workspace: string
      ghCommand: string
      envFile: string | null
      envTarget: string
    }
  | {
      ok: false
      error: string
    }

export function workspaceEnsureGithubUsage(): string {
  return [
    'Usage: npm run workspace:ensure-github -- [--repo OWNER/REPO] [--workspace PATH] [--gh-command COMMAND] [--env-file PATH] [--env-target PATH]',
    '',
    'Ensures the current Symphony issue workspace contains a GitHub repository checkout.',
    'Defaults: --repo $GITHUB_REPOSITORY, --workspace $SYMPHONY_WORKSPACE_PATH or $INIT_CWD or cwd, --gh-command gh.',
    'Optional env injection: --env-file $SYMPHONY_WORKSPACE_ENV_FILE, --env-target $SYMPHONY_WORKSPACE_ENV_TARGET or .env.local.',
  ].join('\n')
}

export function parseWorkspaceEnsureGithubArgs(
  args: Array<string>,
  env: NodeJS.ProcessEnv = process.env,
): ParsedWorkspaceEnsureGithubArgs {
  let repo = env.GITHUB_REPOSITORY ?? ''
  let workspace = env.SYMPHONY_WORKSPACE_PATH ?? env.INIT_CWD ?? process.cwd()
  let ghCommand = env.SYMPHONY_GH_COMMAND ?? 'gh'
  let envFile = env.SYMPHONY_WORKSPACE_ENV_FILE ?? env.SYMPHONY_GITHUB_WORKSPACE_ENV_FILE ?? ''
  let envTarget = env.SYMPHONY_WORKSPACE_ENV_TARGET ?? env.SYMPHONY_GITHUB_WORKSPACE_ENV_TARGET ?? '.env.local'

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      return {
        ok: true,
        help: true,
        repo,
        workspace,
        ghCommand,
        envFile: envFile.trim() || null,
        envTarget: envTarget.trim() || '.env.local',
      }
    }

    if (
      arg === '--repo' ||
      arg === '--workspace' ||
      arg === '--gh-command' ||
      arg === '--env-file' ||
      arg === '--env-target'
    ) {
      const value = args[index + 1]
      if (!value) {
        return { ok: false, error: `Missing value for ${arg}` }
      }

      if (arg === '--repo') {
        repo = value
      } else if (arg === '--workspace') {
        workspace = value
      } else if (arg === '--gh-command') {
        ghCommand = value
      } else if (arg === '--env-file') {
        envFile = value
      } else {
        envTarget = value
      }
      index += 1
      continue
    }

    if (arg.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length)
      continue
    }

    if (arg.startsWith('--workspace=')) {
      workspace = arg.slice('--workspace='.length)
      continue
    }

    if (arg.startsWith('--gh-command=')) {
      ghCommand = arg.slice('--gh-command='.length)
      continue
    }

    if (arg.startsWith('--env-file=')) {
      envFile = arg.slice('--env-file='.length)
      continue
    }

    if (arg.startsWith('--env-target=')) {
      envTarget = arg.slice('--env-target='.length)
      continue
    }

    return { ok: false, error: `Invalid option: ${arg}` }
  }

  if (repo.trim() === '') {
    return { ok: false, error: 'Repo must not be blank; set GITHUB_REPOSITORY or pass --repo OWNER/REPO' }
  }

  if (!validGithubRepository(repo.trim())) {
    return { ok: false, error: 'Repo must use OWNER/REPO or HOST/OWNER/REPO format' }
  }

  if (workspace.trim() === '') {
    return { ok: false, error: 'Workspace must not be blank' }
  }

  if (ghCommand.trim() === '') {
    return { ok: false, error: 'GitHub command must not be blank' }
  }

  if (envTarget.trim() === '') {
    return { ok: false, error: 'Env target must not be blank' }
  }

  return {
    ok: true,
    help: false,
    repo: repo.trim(),
    workspace,
    ghCommand: ghCommand.trim(),
    envFile: envFile.trim() || null,
    envTarget: envTarget.trim(),
  }
}

export async function runWorkspaceEnsureGithub(
  args: Array<string>,
  deps: WorkspaceEnsureGithubDeps = createRuntimeWorkspaceEnsureGithubDeps(),
): Promise<number> {
  const parsed = parseWorkspaceEnsureGithubArgs(args)
  if (!parsed.ok) {
    deps.stderr(parsed.error)
    deps.stderr(workspaceEnsureGithubUsage())
    return 1
  }

  if (parsed.help) {
    deps.stdout(workspaceEnsureGithubUsage())
    return 0
  }

  try {
    await ensureGithubWorkspace(
      {
        repo: parsed.repo,
        workspace: parsed.workspace,
        ghCommand: parsed.ghCommand,
        envFile: parsed.envFile,
        envTarget: parsed.envTarget,
      },
      deps,
    )
    return 0
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}

export async function ensureGithubWorkspace(
  options: { repo: string; workspace: string; ghCommand?: string; envFile?: string | null; envTarget?: string },
  deps: WorkspaceEnsureGithubDeps = createRuntimeWorkspaceEnsureGithubDeps(),
): Promise<WorkspaceEnsureGithubResult> {
  const repo = options.repo.trim()
  const workspace = path.resolve(options.workspace)
  const ghCommand = options.ghCommand?.trim() || 'gh'
  const envFile = options.envFile?.trim() || null
  const envTarget = options.envTarget?.trim() || '.env.local'
  await mkdir(workspace, { recursive: true })
  const envInjection = await prepareWorkspaceEnvInjection({ workspace, envFile, envTarget })

  if (await directoryExists(path.join(workspace, '.git'))) {
    await injectWorkspaceEnvFile(envInjection, workspace, deps)
    deps.stdout(`Workspace already contains a git checkout: ${workspace}`)
    return {
      workspace,
      repo,
      action: 'skipped',
    }
  }

  const entries = await readdir(workspace)
  const blockingEntries = entries.filter((entry) => !ignorableEmptyWorkspaceEntry(entry))
  if (blockingEntries.length > 0) {
    throw new Error(
      [
        `Refusing to clone ${repo} into non-empty non-git workspace ${workspace}.`,
        `Move or remove existing entries first: ${blockingEntries.slice(0, 10).join(', ')}`,
      ].join(' '),
    )
  }

  const command = githubCommandParts(ghCommand)
  const clone = await deps.runCommand(
    command.executable,
    [...command.args, 'repo', 'clone', repo, '.'],
    { cwd: workspace },
  )
  if (!clone.ok) {
    throw new Error(
      `Failed to clone ${repo} into ${workspace}: exit ${clone.status ?? 'unknown'}${formatCommandOutput(
        clone.output,
      )}`,
    )
  }

  if (!(await directoryExists(path.join(workspace, '.git')))) {
    throw new Error(`GitHub clone completed but ${workspace} does not contain a .git directory`)
  }

  await injectWorkspaceEnvFile(envInjection, workspace, deps)
  deps.stdout(`Cloned ${repo} into ${workspace}`)
  return {
    workspace,
    repo,
    action: 'cloned',
  }
}

export function createRuntimeWorkspaceEnsureGithubDeps(): WorkspaceEnsureGithubDeps {
  return {
    runCommand,
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  }
}

async function runCommand(
  command: string,
  args: Array<string>,
  options: { cwd: string },
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024,
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

type WorkspaceEnvInjection = {
  source: string
  target: string
} | null

async function prepareWorkspaceEnvInjection(options: {
  workspace: string
  envFile: string | null
  envTarget: string
}): Promise<WorkspaceEnvInjection> {
  if (!options.envFile) {
    return null
  }

  const source = path.resolve(options.envFile)
  const target = resolveWorkspaceTarget(options.workspace, options.envTarget)
  const sourceStat = await stat(source)
  if (!sourceStat.isFile()) {
    throw new Error(`Workspace env source must be a file: ${source}`)
  }

  return { source, target }
}

async function injectWorkspaceEnvFile(
  envInjection: WorkspaceEnvInjection,
  workspace: string,
  deps: WorkspaceEnsureGithubDeps,
): Promise<void> {
  if (!envInjection) {
    return
  }

  await mkdir(path.dirname(envInjection.target), { recursive: true })
  await copyFile(envInjection.source, envInjection.target)
  deps.stdout(`Injected workspace env file: ${path.relative(workspace, envInjection.target)}`)
}

function resolveWorkspaceTarget(workspace: string, envTarget: string): string {
  if (path.isAbsolute(envTarget)) {
    throw new Error('Env target must be relative to the workspace')
  }

  const target = path.resolve(workspace, envTarget)
  const relative = path.relative(workspace, target)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Env target must stay inside the workspace')
  }

  return target
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory()
  } catch {
    return false
  }
}

function ignorableEmptyWorkspaceEntry(entry: string): boolean {
  return entry === '.DS_Store'
}

function validGithubRepository(repository: string): boolean {
  return /^(?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
}

function formatCommandOutput(output: string): string {
  const trimmed = output.trim()
  return trimmed ? ` output=${JSON.stringify(truncateText(trimmed))}` : ''
}

function truncateText(text: string): string {
  return text.length > 1000 ? `${text.slice(0, 1000)}...<truncated>` : text
}

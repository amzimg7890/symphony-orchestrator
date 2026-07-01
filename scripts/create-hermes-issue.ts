import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { resolveWorkflowConfig } from '../src/server/symphony/config'
import { githubCommandParts } from '../src/server/symphony/githubTracker'
import type { EffectiveConfig } from '../src/server/symphony/types'
import { loadWorkflow } from '../src/server/symphony/workflow'

type DiscordRef = {
  guild_id: string
  channel_id: string
  thread_id: string
  message_id: string
}

type Args = {
  workflow: string
  envFile: string
  title: string
  body: string
  discordUrl: string
  profile: string
  create: boolean
}

const execFileAsync = promisify(execFile)
const root = process.cwd()

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2))
}

export async function main(rawArgs: Array<string>): Promise<void> {
  const args = parseArgs(rawArgs)
  await loadDotEnv(args.envFile)

  const workflowPath = path.resolve(root, args.workflow)
  const workflow = await loadWorkflow(workflowPath)
  const resolved = resolveWorkflowConfig(workflow, process.env)
  if (!resolved.ok) {
    throw new Error(resolved.errors.map((error) => error.message).join('; '))
  }

  const config = resolved.config
  if (config.tracker.kind !== 'github') {
    throw new Error('workflow tracker.kind must be github')
  }

  const repository = config.tracker.repository ?? await inferRepository(config)
  const discord = parseDiscordMessageUrl(args.discordUrl)
  const issueBody = withHermesMarker(args.body, discord, args.profile)
  const issueCreateArgs = [
    'issue',
    'create',
    '--repo',
    repository,
    '--title',
    args.title,
    '--body',
    issueBody,
    ...config.tracker.required_labels.flatMap((label) => ['--label', label]),
    ...(config.tracker.assignee ? ['--assignee', config.tracker.assignee] : []),
  ]

  if (!args.create) {
    console.log(JSON.stringify({
      ok: true,
      dry_run: true,
      repository,
      discord,
      labels: config.tracker.required_labels,
      issue_body: issueBody,
      next: 'Re-run with --create to create the GitHub issue.',
    }, null, 2))
    return
  }

  const result = await runGh(config, issueCreateArgs)

  console.log(JSON.stringify({
    ok: true,
    dry_run: false,
    repository,
    issue_url: result.stdout.trim(),
    discord,
    labels: config.tracker.required_labels,
    next: `npm run workflow:check-github -- --workflow ${path.relative(root, workflowPath) || workflowPath}`,
  }, null, 2))
}

export function parseDiscordMessageUrl(value: string): DiscordRef {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('--discord-url must be a Discord message URL')
  }

  if (url.hostname !== 'discord.com' && url.hostname !== 'www.discord.com' && url.hostname !== 'canary.discord.com') {
    throw new Error('--discord-url must use discord.com')
  }

  const parts = url.pathname.split('/').filter(Boolean)
  const channelsIndex = parts.indexOf('channels')
  if (channelsIndex < 0 || parts.length < channelsIndex + 4) {
    throw new Error('--discord-url must look like https://discord.com/channels/<guild>/<channel>/<message>')
  }

  const [guildId, channelId, messageId] = parts.slice(channelsIndex + 1, channelsIndex + 4)
  if (!guildId || !channelId || !messageId || !numericId(channelId) || !numericId(messageId)) {
    throw new Error('--discord-url contains invalid channel or message id')
  }

  return {
    guild_id: guildId,
    channel_id: channelId,
    thread_id: channelId,
    message_id: messageId,
  }
}

export function withHermesMarker(body: string, discord: DiscordRef, profile: string): string {
  const marker = {
    source: 'discord',
    channel_id: discord.channel_id,
    thread_id: discord.thread_id,
    message_id: discord.message_id,
    profile,
  }
  return `<!-- hermes:${JSON.stringify(marker)} -->\n\n${body.trim()}\n`
}

function parseArgs(values: Array<string>): Args {
  let workflow = 'WORKFLOW.hermes-spec.md'
  let envFile = path.join(root, '.env')
  let title = ''
  let body = ''
  let discordUrl = ''
  let profile = 'intake'
  let create = false

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--workflow') {
      workflow = requireValue(values, index, value)
      index += 1
      continue
    }
    if (value === '--dotenv') {
      envFile = path.resolve(root, requireValue(values, index, value))
      index += 1
      continue
    }
    if (value === '--title') {
      title = requireValue(values, index, value)
      index += 1
      continue
    }
    if (value === '--body') {
      body = requireValue(values, index, value)
      index += 1
      continue
    }
    if (value === '--discord-url') {
      discordUrl = requireValue(values, index, value)
      index += 1
      continue
    }
    if (value === '--profile') {
      profile = requireValue(values, index, value)
      index += 1
      continue
    }
    if (value === '--create') {
      create = true
      continue
    }
    throw new Error(`Unknown option: ${value}`)
  }

  if (!title.trim()) {
    throw new Error('--title is required')
  }
  if (!body.trim()) {
    throw new Error('--body is required')
  }
  if (!discordUrl.trim()) {
    throw new Error('--discord-url is required')
  }

  return { workflow, envFile, title, body, discordUrl, profile, create }
}

async function inferRepository(config: EffectiveConfig): Promise<string> {
  const result = await runGh(config, ['repo', 'view', '--json', 'nameWithOwner'])
  const parsed = JSON.parse(result.stdout) as { nameWithOwner?: string }
  if (typeof parsed.nameWithOwner === 'string' && parsed.nameWithOwner.trim()) {
    return parsed.nameWithOwner.trim()
  }
  throw new Error('Unable to infer GitHub repository from gh repo view')
}

async function runGh(
  config: EffectiveConfig,
  commandArgs: Array<string>,
): Promise<{ stdout: string; stderr: string }> {
  const command = githubCommandParts(config.tracker.gh_command)
  const result = await execFileAsync(command.executable, [...command.args, ...commandArgs], {
    cwd: config.workflow_directory,
    windowsHide: true,
    maxBuffer: 5 * 1024 * 1024,
  })
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  }
}

function requireValue(values: Array<string>, index: number, flag: string): string {
  const value = values[index + 1]
  if (!value) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

async function loadDotEnv(dotEnvPath: string): Promise<void> {
  if (!existsSync(dotEnvPath)) {
    return
  }
  const content = await readFile(dotEnvPath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match) {
      continue
    }
    const [, key, rawValue] = match
    process.env[key] ??= unquoteDotEnvValue(rawValue)
  }
}

function unquoteDotEnvValue(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function numericId(value: string): boolean {
  return /^[0-9]{5,}$/.test(value)
}

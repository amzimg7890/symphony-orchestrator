import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { resolveWorkflowConfig } from '../src/server/symphony/config'
import { githubCommandParts } from '../src/server/symphony/githubTracker'
import type { EffectiveConfig } from '../src/server/symphony/types'
import { loadWorkflow } from '../src/server/symphony/workflow'
import { withHermesMarker } from './create-hermes-issue'

type Args = {
  workflow: string
  dotenv: string
  hermesDotenv: string
  channels: Array<string>
  statePath: string
  intervalMs: number
  once: boolean
  processExisting: boolean
  dryRun: boolean
}

type DiscordMessage = {
  id: string
  channel_id: string
  guild_id?: string
  content: string
  author?: { bot?: boolean; username?: string }
}

type RouterState = {
  channels: Record<string, { last_seen_id: string | null; handled_ids: Array<string> }>
}

const execFileAsync = promisify(execFile)
const root = process.cwd()

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2))
}

async function main(rawArgs: Array<string>): Promise<void> {
  const args = parseArgs(rawArgs)
  await loadDotEnv(args.dotenv)
  await loadDotEnv(args.hermesDotenv)

  const token = process.env.DISCORD_BOT_TOKEN?.trim()
  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN is required')
  }

  const channels = args.channels.length > 0 ? args.channels : channelsFromEnv()
  if (channels.length === 0) {
    throw new Error('No Discord intake channel configured. Pass --channel or set DISCORD_ROUTER_CHANNELS.')
  }

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

  const state = await readState(args.statePath)
  const tick = async () => {
    for (const channelId of channels) {
      await processChannel({
        token,
        channelId,
        state,
        statePath: args.statePath,
        config,
        repository,
        processExisting: args.processExisting,
        dryRun: args.dryRun,
      })
    }
  }

  await tick()
  if (args.once) {
    return
  }

  console.log(`Hermes router polling ${channels.join(', ')} every ${args.intervalMs}ms`)
  for (;;) {
    await delay(args.intervalMs)
    await tick()
  }
}

async function processChannel(input: {
  token: string
  channelId: string
  state: RouterState
  statePath: string
  config: EffectiveConfig
  repository: string
  processExisting: boolean
  dryRun: boolean
}): Promise<void> {
  const channelState = input.state.channels[input.channelId] ?? {
    last_seen_id: null,
    handled_ids: [],
  }
  input.state.channels[input.channelId] = channelState

  const messages = await fetchMessages(input.token, input.channelId, channelState.last_seen_id)
  if (!channelState.last_seen_id && !input.processExisting) {
    const latest = latestMessageId(messages)
    if (latest) {
      channelState.last_seen_id = latest
      await writeState(input.statePath, input.state)
    }
    return
  }

  for (const message of messages.sort((a, b) => compareSnowflake(a.id, b.id))) {
    channelState.last_seen_id = maxSnowflake(channelState.last_seen_id, message.id)
    if (message.author?.bot || channelState.handled_ids.includes(message.id)) {
      continue
    }

    const intake = parseIntakeCommand(message.content)
    if (!intake) {
      continue
    }

    channelState.handled_ids = [...channelState.handled_ids, message.id].slice(-100)
    const issueBody = buildIssueBody(intake.request, message)
    if (input.dryRun) {
      console.log(JSON.stringify({ dry_run: true, channel_id: message.channel_id, message_id: message.id, issue_body: issueBody }, null, 2))
      continue
    }

    const issueUrl = await createIssue(input.config, input.repository, titleFromRequest(intake.request), issueBody)
    await sendDiscordMessage(
      input.token,
      message.channel_id,
      `已创建 GitHub issue：${issueUrl}\n进入 @hermes.spec`,
      message,
    )
    console.log(`created ${issueUrl} from discord message ${message.id}`)
  }

  await writeState(input.statePath, input.state)
}

export function parseIntakeCommand(content: string): { request: string } | null {
  const match = content.match(/^\s*(?:!hermes|\/hermes|hermes|<@!?\d+>)\s+intake\b[:：]?\s*([\s\S]*)$/i)
  const request = match?.[1]?.trim()
  return request ? { request } : null
}

export function titleFromRequest(request: string): string {
  const line = request.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? 'Hermes intake request'
  return line.replace(/^#+\s*/, '').replaceAll('`', '').slice(0, 80)
}

export function buildIssueBody(request: string, message: DiscordMessage): string {
  const url = message.guild_id
    ? `https://discord.com/channels/${message.guild_id}/${message.channel_id}/${message.id}`
    : `discord:${message.channel_id}/${message.id}`
  return withHermesMarker([
    '## Raw Request',
    '',
    request.trim(),
    '',
    '## Source',
    '',
    `- Discord message: ${url}`,
    '',
    '## Hermes Handoff Requirement',
    '',
    'Each stage must finish with a `## Hermes Handoff` comment containing `stage`, `status`, `next`, `artifacts`, and `notes`.',
  ].join('\n'), {
    guild_id: message.guild_id ?? '@me',
    channel_id: message.channel_id,
    thread_id: message.channel_id,
    message_id: message.id,
  }, 'intake')
}

async function createIssue(
  config: EffectiveConfig,
  repository: string,
  title: string,
  body: string,
): Promise<string> {
  const result = await runGh(config, [
    'issue',
    'create',
    '--repo',
    repository,
    '--title',
    title,
    '--body',
    body,
    ...config.tracker.required_labels.flatMap((label) => ['--label', label]),
    ...(config.tracker.assignee ? ['--assignee', config.tracker.assignee] : []),
  ])
  return result.stdout.trim()
}

async function fetchMessages(
  token: string,
  channelId: string,
  after: string | null,
): Promise<Array<DiscordMessage>> {
  const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`)
  url.searchParams.set('limit', '25')
  if (after) {
    url.searchParams.set('after', after)
  }
  return await discordJson<Array<DiscordMessage>>(token, url, undefined)
}

async function sendDiscordMessage(
  token: string,
  channelId: string,
  content: string,
  replyTo: DiscordMessage,
): Promise<void> {
  await discordJson(token, new URL(`https://discord.com/api/v10/channels/${channelId}/messages`), {
    content,
    message_reference: {
      message_id: replyTo.id,
      channel_id: replyTo.channel_id,
      ...(replyTo.guild_id ? { guild_id: replyTo.guild_id } : {}),
    },
    allowed_mentions: { parse: [] },
  })
}

async function discordJson<T>(token: string, url: URL, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Discord API ${response.status}: ${text.slice(0, 500)}`)
  }
  return text ? JSON.parse(text) as T : undefined as T
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

function parseArgs(values: Array<string>): Args {
  let workflow = 'WORKFLOW.hermes-spec.md'
  let dotenv = path.join(root, '.env')
  let hermesDotenv = path.join(os.homedir(), '.hermes', '.env')
  const channels: Array<string> = []
  let statePath = path.join(root, '.tmp', 'hermes-router-state.json')
  let intervalMs = 5000
  let once = false
  let processExisting = false
  let dryRun = false

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--workflow') {
      workflow = requireValue(values, index, value)
      index += 1
      continue
    }
    if (value === '--dotenv') {
      dotenv = path.resolve(root, requireValue(values, index, value))
      index += 1
      continue
    }
    if (value === '--hermes-dotenv') {
      hermesDotenv = expandHome(requireValue(values, index, value))
      index += 1
      continue
    }
    if (value === '--channel') {
      channels.push(requireValue(values, index, value))
      index += 1
      continue
    }
    if (value === '--channels') {
      channels.push(...splitList(requireValue(values, index, value)))
      index += 1
      continue
    }
    if (value === '--state') {
      statePath = path.resolve(root, requireValue(values, index, value))
      index += 1
      continue
    }
    if (value === '--interval-ms') {
      intervalMs = positiveInt(requireValue(values, index, value), value)
      index += 1
      continue
    }
    if (value === '--once') {
      once = true
      continue
    }
    if (value === '--process-existing') {
      processExisting = true
      continue
    }
    if (value === '--dry-run') {
      dryRun = true
      continue
    }
    throw new Error(`Unknown option: ${value}`)
  }

  return { workflow, dotenv, hermesDotenv, channels, statePath, intervalMs, once, processExisting, dryRun }
}

function channelsFromEnv(): Array<string> {
  return splitList(
    process.env.DISCORD_ROUTER_CHANNELS
      ?? process.env.DISCORD_INTAKE_CHANNEL_ID
      ?? process.env.DISCORD_ALLOWED_CHANNELS
      ?? '',
  )
}

async function readState(statePath: string): Promise<RouterState> {
  if (!existsSync(statePath)) {
    return { channels: {} }
  }
  return JSON.parse(await readFile(statePath, 'utf8')) as RouterState
}

async function writeState(statePath: string, state: RouterState): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true })
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
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

function splitList(value: string): Array<string> {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function requireValue(values: Array<string>, index: number, flag: string): string {
  const value = values[index + 1]
  if (!value) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function positiveInt(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`)
  }
  return parsed
}

function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir()
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return path.resolve(root, value)
}

function latestMessageId(messages: Array<DiscordMessage>): string | null {
  return messages.reduce<string | null>((latest, message) => maxSnowflake(latest, message.id), null)
}

function maxSnowflake(left: string | null, right: string): string {
  if (!left) {
    return right
  }
  return BigInt(right) > BigInt(left) ? right : left
}

function compareSnowflake(left: string, right: string): number {
  const delta = BigInt(left) - BigInt(right)
  return delta < 0n ? -1 : delta > 0n ? 1 : 0
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

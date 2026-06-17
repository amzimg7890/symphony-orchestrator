import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const VIEWER_QUERY = `
  query SymphonyRealPreflightViewer {
    viewer {
      id
      name
    }
  }
`

const ISSUES_QUERY = `
  query SymphonyRealPreflightIssues($projectSlug: String!, $stateNames: [String!]) {
    issues(
      first: 20
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $stateNames } }
      }
    ) {
      nodes {
        id
        identifier
        title
        state { name }
        assignee { id }
        labels { nodes { name } }
        inverseRelations {
          nodes {
            type
            issue {
              id
              identifier
              state { name }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

type LinearResponse<T> = {
  data?: T
  errors?: Array<{ message?: string }>
}

type ViewerPayload = {
  viewer?: {
    id?: string | null
    name?: string | null
  } | null
}

type IssuesPayload = {
  issues?: {
    nodes?: Array<{
      id?: string
      identifier?: string
      title?: string
      state?: { name?: string | null } | null
      assignee?: { id?: string | null } | null
      labels?: { nodes?: Array<{ name?: string | null }> } | null
      inverseRelations?: {
        nodes?: Array<{
          type?: string | null
          issue?: {
            id?: string | null
            identifier?: string | null
            state?: { name?: string | null } | null
          } | null
        }>
      } | null
    }>
    pageInfo?: {
      hasNextPage?: boolean
      endCursor?: string | null
    }
  }
}

const root = process.cwd()
await loadDotEnv(path.join(root, '.env'))

const endpoint = env('LINEAR_ENDPOINT') ?? 'https://api.linear.app/graphql'
const apiKey = env('LINEAR_API_KEY')
const projectSlug =
  env('LINEAR_PROJECT_SLUG') ??
  env('SYMPHONY_LINEAR_PROJECT_SLUG') ??
  env('TRACKER_PROJECT_SLUG')
const assignee = env('LINEAR_ASSIGNEE')
const activeStates = csvEnv('SYMPHONY_ACTIVE_STATES', ['Todo', 'In Progress'])
const terminalStates = csvEnv('SYMPHONY_TERMINAL_STATES', ['Done', 'Closed', 'Cancelled', 'Canceled', 'Duplicate'])
const requiredLabels = csvEnv('SYMPHONY_REQUIRED_LABELS', ['codex'])
const requiredPreflight = booleanEnv('SYMPHONY_REAL_PREFLIGHT_REQUIRED')

const missing = [
  apiKey ? null : 'LINEAR_API_KEY',
  projectSlug ? null : 'LINEAR_PROJECT_SLUG',
].filter((item): item is string => Boolean(item))

if (missing.length > 0) {
  const payload = JSON.stringify(
    {
      ok: false,
      skipped: true,
      required: requiredPreflight,
      missing,
      message:
        'Real preflight is read-only, but it needs Linear credentials. Add these to .env or the process environment.',
    },
    null,
    2,
  )

  if (requiredPreflight) {
    console.error(payload)
    process.exit(1)
  }

  console.log(payload)
  process.exit(0)
}

const codexVersion = await runCommand('codex', ['--version'], 10_000)
const viewer = await linear<ViewerPayload>(VIEWER_QUERY, {})
const viewerId = viewer.viewer?.id ?? null
const assigneeId = assignee?.toLowerCase() === 'me' ? viewerId : assignee ?? null

const activeIssues = await linear<IssuesPayload>(ISSUES_QUERY, {
  projectSlug,
  stateNames: activeStates,
})
const terminalIssues = await linear<IssuesPayload>(ISSUES_QUERY, {
  projectSlug,
  stateNames: terminalStates,
})

const activeNodes = activeIssues.issues?.nodes ?? []
const candidateNodes = activeNodes.filter((issue) => {
  const labels =
    issue.labels?.nodes
      ?.map((label) => label.name?.trim().toLowerCase())
      .filter((label): label is string => Boolean(label)) ?? []
  const hasLabels = requiredLabels.every((label) => labels.includes(label.toLowerCase()))
  const hasAssignee = !assigneeId || issue.assignee?.id === assigneeId
  return hasLabels && hasAssignee
})
const blockerRelationCount = activeNodes.reduce(
  (count, issue) =>
    count + (issue.inverseRelations?.nodes?.filter((relation) => relation.type === 'blocks').length ?? 0),
  0,
)

console.log(
  JSON.stringify(
    {
      ok: true,
      codex: codexVersion.stdout.trim(),
      linear: {
        endpoint,
        api_key_present: true,
        viewer_present: Boolean(viewerId),
        project_slug: projectSlug,
        active_states: activeStates,
        terminal_states: terminalStates,
        required_labels: requiredLabels,
        assignee: assignee ?? null,
        assignee_resolved_to_viewer: assignee?.toLowerCase() === 'me',
        active_issue_sample_count: activeNodes.length,
        candidate_sample_count: candidateNodes.length,
        terminal_issue_sample_count: terminalIssues.issues?.nodes?.length ?? 0,
        has_more_active_issues: activeIssues.issues?.pageInfo?.hasNextPage ?? false,
        blocker_relation_sample_count: blockerRelationCount,
      },
      read_only: true,
      next:
        'If this passes and candidate_sample_count is acceptable, configure WORKFLOW.md with demo.mock_tracker=false and agent.runner=codex for a controlled real smoke.',
    },
    null,
    2,
  ),
)

async function linear<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: apiKey!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    throw new Error(`Linear returned HTTP ${response.status}`)
  }

  const payload = (await response.json()) as LinearResponse<T>
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message ?? 'GraphQL error').join('; '))
  }
  if (!payload.data) {
    throw new Error('Linear response did not include data')
  }

  return payload.data
}

async function runCommand(
  executable: string,
  args: Array<string>,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const command = process.platform === 'win32'
    ? {
        executable: process.env.ComSpec ?? 'cmd.exe',
        args: ['/d', '/s', '/c', [executable, ...args].map(quoteWindowsArg).join(' ')],
      }
    : { executable, args }
  const child = spawn(command.executable, command.args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${executable} ${args.join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(`${executable} ${args.join(' ')} exited with ${code ?? signal}: ${stderr || stdout}`))
    })
  })
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

function env(key: string): string | null {
  const value = process.env[key]?.trim()
  return value ? value : null
}

function csvEnv(key: string, fallback: Array<string>): Array<string> {
  const value = env(key)
  if (!value) {
    return fallback
  }

  const parsed = value.split(',').map((item) => item.trim()).filter(Boolean)
  return parsed.length > 0 ? parsed : fallback
}

function booleanEnv(key: string): boolean {
  const value = env(key)?.toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
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

function quoteWindowsArg(arg: string): string {
  if (!/[ "]/.test(arg)) {
    return arg
  }

  return `"${arg.replaceAll('"', '\\"')}"`
}

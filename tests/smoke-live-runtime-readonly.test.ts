import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const projectRoot = path.resolve('.')
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const smokeScript = path.join(projectRoot, 'scripts', 'smoke-live-runtime-readonly.ts')

let cleanupDirs: Array<string> = []
let cleanupServers: Array<http.Server> = []

afterEach(async () => {
  for (const server of cleanupServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('read-only live runtime smoke script', () => {
  it('rejects non-live workflows before starting the orchestrator', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-runtime-readonly-demo-'))
    cleanupDirs.push(dir)
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    await writeFile(workflowPath, workflowContent({ mockTracker: true }), 'utf8')

    const result = await runSmoke({
      args: ['--workflow', workflowPath, '--dotenv', path.join(dir, 'missing.env'), '--timeout-ms', '5000'],
      env: baseEnv(),
    })

    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
    })
    expect(JSON.parse(result.stderr).error).toContain('mock_tracker must be false')
  })

  it('starts the orchestrator, polls Linear, and prevents runner dispatch', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-runtime-readonly-'))
    cleanupDirs.push(dir)
    const fakeLinear = await startFakeLinearServer()
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    await writeFile(workflowPath, workflowContent({ endpoint: fakeLinear.url }), 'utf8')

    const result = await runSmoke({
      args: ['--workflow', workflowPath, '--dotenv', path.join(dir, 'missing.env'), '--timeout-ms', '10000'],
      env: baseEnv(),
    })

    if (result.exitCode !== 0) {
      throw new Error(`runtime readonly smoke exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }

    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      read_only: true,
      runner_invoked: false,
      candidate_poll_count: 1,
      runner: 'codex',
      mock_tracker: false,
      linear: {
        active_issue_count: 2,
        eligible_candidate_count: 1,
        candidate_issue_identifiers: ['LIVE-1'],
      },
    })
  })
})

function workflowContent(args: { endpoint?: string; mockTracker?: boolean }): string {
  return [
    '---',
    'tracker:',
    '  kind: linear',
    `  endpoint: '${args.endpoint ?? 'https://linear.local/graphql'}'`,
    '  api_key: $LINEAR_API_KEY',
    '  project_slug: $LINEAR_PROJECT_SLUG',
    '  required_labels:',
    "    - 'codex'",
    '  active_states:',
    "    - 'Todo'",
    "    - 'In Progress'",
    '  terminal_states:',
    "    - 'Done'",
    'polling:',
    '  interval_ms: 10000',
    'agent:',
    "  runner: 'codex'",
    'demo:',
    `  mock_tracker: ${args.mockTracker ?? false}`,
    '---',
    'Read-only runtime smoke.',
    '',
  ].join('\n')
}

function baseEnv(): Record<string, string> {
  return {
    LINEAR_API_KEY: 'test-linear-secret',
    LINEAR_PROJECT_SLUG: 'live-project',
    LINEAR_ASSIGNEE: '',
  }
}

async function startFakeLinearServer(): Promise<{ url: string }> {
  const server = http.createServer(async (request, response) => {
    const raw = await readRequestBody(request)
    const payload = JSON.parse(raw) as { query?: string; variables?: Record<string, unknown> }
    const query = payload.query ?? ''
    const variables = payload.variables ?? {}

    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: respond(query, variables) }))
  })

  cleanupServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Fake Linear server did not bind to a TCP port')
  }
  return { url: `http://127.0.0.1:${address.port}/graphql` }
}

function respond(query: string, variables: Record<string, unknown>): Record<string, unknown> {
  if (query.includes('CandidateIssues')) {
    return {
      issues: {
        nodes: issues().filter((issue) => issue.state.name !== 'Done'),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }
  }
  return {}
}

function issues(): Array<Record<string, unknown> & { state: { name: string } }> {
  return [
    issueNode({ id: 'issue-1', identifier: 'LIVE-1', state: 'Todo', labels: ['codex'] }),
    issueNode({ id: 'issue-2', identifier: 'LIVE-2', state: 'In Progress', labels: ['other'] }),
    issueNode({ id: 'issue-3', identifier: 'LIVE-3', state: 'Done', labels: ['codex'] }),
  ]
}

function issueNode(args: {
  id: string
  identifier: string
  state: string
  labels: Array<string>
}): Record<string, unknown> & { state: { name: string } } {
  return {
    id: args.id,
    identifier: args.identifier,
    title: `Issue ${args.identifier}`,
    description: null,
    priority: null,
    url: `https://linear.local/${args.identifier}`,
    branchName: null,
    assignee: null,
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
    state: { name: args.state },
    labels: { nodes: args.labels.map((name) => ({ name })) },
    inverseRelations: { nodes: [] },
  }
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
  }
  return body
}

async function runSmoke(input: {
  args: Array<string>
  env: Record<string, string>
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [tsxCli, smokeScript, ...input.args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...input.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`runtime readonly smoke timed out: ${stderr || stdout}`))
    }, 15_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (exitCode) => {
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr })
    })
  })
}

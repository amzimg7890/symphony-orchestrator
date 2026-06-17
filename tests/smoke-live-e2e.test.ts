import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const projectRoot = path.resolve('.')
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const smokeScript = path.join(projectRoot, 'scripts', 'smoke-live-e2e.ts')

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

describe('live e2e smoke script', () => {
  it('skips unless explicitly enabled', async () => {
    const result = await runSmoke({
      SYMPHONY_RUN_LIVE_E2E: '',
      SYMPHONY_LIVE_E2E_REQUIRED: '',
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      skipped: true,
      required: false,
    })
  }, 15_000)

  it('drives a fake Linear issue through the production orchestrator path', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-live-e2e-test-'))
    cleanupDirs.push(dir)
    const fakeCodexScript = path.join(dir, 'fake-codex-app-server.mjs')
    await writeFakeCodexAppServer(fakeCodexScript)
    const fakeLinear = await startFakeLinearServer()

    const result = await runSmoke({
      SYMPHONY_RUN_LIVE_E2E: '1',
      SYMPHONY_LIVE_E2E_BACKEND: 'local',
      SYMPHONY_LIVE_E2E_CODEX_COMMAND: commandForNodeScript(fakeCodexScript),
      SYMPHONY_LIVE_E2E_WORKSPACE_ROOT: path.join(dir, 'workspaces'),
      SYMPHONY_LIVE_E2E_TIMEOUT_MS: '30000',
      SYMPHONY_LIVE_E2E_POLL_MS: '100',
      SYMPHONY_LIVE_E2E_CODEX_READ_TIMEOUT_MS: '5000',
      SYMPHONY_LIVE_E2E_CODEX_TURN_TIMEOUT_MS: '10000',
      LINEAR_ENDPOINT: fakeLinear.url,
      LINEAR_API_KEY: 'fake-linear-token',
      SYMPHONY_LIVE_LINEAR_TEAM_KEY: 'SYME2E',
      SYMPHONY_FAKE_COMPLETED_STATE_ID: fakeLinear.completedStateId,
    }, 35_000)

    if (result.exitCode !== 0) {
      throw new Error(`live e2e smoke exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }

    expect(result.stderr).toBe('')
    const payload = JSON.parse(result.stdout)
    expect(payload).toMatchObject({
      ok: true,
      skipped: false,
      backend: 'local',
      project: {
        slug_id: fakeLinear.projectSlug,
        completed: true,
      },
      issue: {
        identifier: 'SYME2E-1',
        completed_state: 'Done',
      },
      verification: {
        comment_found: true,
        result_file_found: true,
        result_file_content: `identifier=SYME2E-1\nproject_slug=${fakeLinear.projectSlug}\n`,
      },
    })
    expect(fakeLinear.comments).toContain(
      `Symphony live e2e comment\nidentifier=SYME2E-1\nproject_slug=${fakeLinear.projectSlug}`,
    )
    expect(fakeLinear.issueStateId()).toBe(fakeLinear.completedStateId)
    expect(fakeLinear.projectCompleted()).toBe(true)
  }, 40_000)

  it('can reuse an existing Linear project slug instead of creating a project', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-live-e2e-existing-project-test-'))
    cleanupDirs.push(dir)
    const fakeCodexScript = path.join(dir, 'fake-codex-app-server.mjs')
    await writeFakeCodexAppServer(fakeCodexScript)
    const fakeLinear = await startFakeLinearServer()

    const result = await runSmoke({
      SYMPHONY_RUN_LIVE_E2E: '1',
      SYMPHONY_LIVE_E2E_BACKEND: 'local',
      SYMPHONY_LIVE_E2E_CODEX_COMMAND: commandForNodeScript(fakeCodexScript),
      SYMPHONY_LIVE_E2E_WORKSPACE_ROOT: path.join(dir, 'workspaces'),
      SYMPHONY_LIVE_E2E_TIMEOUT_MS: '30000',
      SYMPHONY_LIVE_E2E_POLL_MS: '100',
      SYMPHONY_LIVE_E2E_CODEX_READ_TIMEOUT_MS: '5000',
      SYMPHONY_LIVE_E2E_CODEX_TURN_TIMEOUT_MS: '10000',
      LINEAR_ENDPOINT: fakeLinear.url,
      LINEAR_API_KEY: 'fake-linear-token',
      LINEAR_PROJECT_SLUG: fakeLinear.projectSlug,
      SYMPHONY_FAKE_COMPLETED_STATE_ID: fakeLinear.completedStateId,
    }, 35_000)

    if (result.exitCode !== 0) {
      throw new Error(`live e2e smoke exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }

    expect(result.stderr).toBe('')
    const payload = JSON.parse(result.stdout)
    expect(payload).toMatchObject({
      ok: true,
      skipped: false,
      backend: 'local',
      project: {
        slug_id: fakeLinear.projectSlug,
        completed: false,
        reused: true,
      },
      verification: {
        comment_found: true,
        result_file_found: true,
      },
    })
    expect(fakeLinear.projectCreated()).toBe(false)
    expect(fakeLinear.projectCompleted()).toBe(false)
    expect(fakeLinear.issueStateId()).toBe(fakeLinear.completedStateId)
  }, 40_000)

  it('uses Docker worker fallback for ssh backend without configured hosts', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-live-e2e-docker-fallback-test-'))
    cleanupDirs.push(dir)
    const result = await runSmoke({
      SYMPHONY_RUN_LIVE_E2E: '1',
      SYMPHONY_LIVE_E2E_BACKEND: 'ssh',
      SYMPHONY_LIVE_DOCKER_AUTH_JSON: path.join(dir, 'missing-auth.json'),
      LINEAR_API_KEY: 'fake-linear-token',
    }, 15_000)

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      skipped: false,
      backend: 'docker',
      requested_backend: 'ssh',
    })
    expect(JSON.parse(result.stderr).error).toContain('Docker worker mode requires Codex auth')
  }, 20_000)
})

async function runSmoke(
  env: Record<string, string>,
  timeoutMs = 15_000,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [tsxCli, smokeScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...env,
      LINEAR_PROJECT_SLUG: env.LINEAR_PROJECT_SLUG ?? '',
      SYMPHONY_LIVE_E2E_PROJECT_SLUG: env.SYMPHONY_LIVE_E2E_PROJECT_SLUG ?? '',
      SYMPHONY_LIVE_SSH_WORKER_HOSTS: env.SYMPHONY_LIVE_SSH_WORKER_HOSTS ?? '',
      SYMPHONY_SSH_WORKER_HOSTS: env.SYMPHONY_SSH_WORKER_HOSTS ?? '',
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
      reject(new Error(`smoke-live-e2e timed out: ${stderr || stdout}`))
    }, timeoutMs)

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

async function writeFakeCodexAppServer(scriptPath: string): Promise<void> {
  await writeFile(
    scriptPath,
    [
      "import fs from 'node:fs'",
      "import readline from 'node:readline'",
      'let threadId = "thread-live-e2e"',
      'const rl = readline.createInterface({ input: process.stdin })',
      'const keepAlive = setInterval(() => {}, 1000)',
      'function write(message) { process.stdout.write(`${JSON.stringify(message)}\\n`) }',
      'async function graphql(query, variables) {',
      '  const response = await fetch(process.env.LINEAR_ENDPOINT, {',
      '    method: "POST",',
      '    headers: { Authorization: process.env.LINEAR_API_KEY, "Content-Type": "application/json" },',
      '    body: JSON.stringify({ query, variables }),',
      '  })',
      '  if (!response.ok) throw new Error(`fake Linear HTTP ${response.status}`)',
      '}',
      'rl.on("line", async (line) => {',
      '  const message = JSON.parse(line)',
      '  if (message.method === "initialize") {',
      '    write({ id: message.id, result: { serverInfo: { name: "fake-codex" } } })',
      '  } else if (message.method === "thread/start") {',
      '    threadId = "thread-live-e2e"',
      '    write({ id: message.id, result: { thread: { id: threadId } } })',
      '  } else if (message.method === "thread/name/set") {',
      '    write({ id: message.id, result: {} })',
      '  } else if (message.method === "turn/start") {',
      '    const turnId = "turn-live-e2e"',
      '    write({ id: message.id, result: { turn: { id: turnId } } })',
      '    write({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "running" } } })',
      '    const prompt = message.params.input.map((item) => item.text ?? "").join("\\n")',
      '    const identifier = /identifier=([A-Z0-9-]+)/.exec(prompt)?.[1] ?? "SYME2E-1"',
      '    const projectSlug = /project_slug=([A-Za-z0-9_.-]+)/.exec(prompt)?.[1] ?? "fake-project"',
      '    fs.writeFileSync("LIVE_E2E_RESULT.txt", `identifier=${identifier}\\nproject_slug=${projectSlug}\\n`, "utf8")',
      '    const issueId = message.params.responsesapiClientMetadata.issue_id',
      '    const body = `Symphony live e2e comment\\nidentifier=${identifier}\\nproject_slug=${projectSlug}`',
      '    await graphql("mutation FakeComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }", { issueId, body })',
      '    await graphql("mutation FakeUpdate($issueId: String!, $stateId: String!) { issueUpdate(id: $issueId, input: { stateId: $stateId }) { success } }", { issueId, stateId: process.env.SYMPHONY_FAKE_COMPLETED_STATE_ID })',
      '    write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" }, usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 } } })',
      '  }',
      '})',
      'rl.on("close", () => { clearInterval(keepAlive); process.exit(0) })',
    ].join('\n'),
    'utf8',
  )
}

async function startFakeLinearServer(): Promise<{
  url: string
  completedStateId: string
  projectSlug: string
  comments: Array<string>
  issueStateId: () => string
  projectCreated: () => boolean
  projectCompleted: () => boolean
}> {
  const states = [
    { id: 'state-todo', name: 'Todo', type: 'unstarted' },
    { id: 'state-done', name: 'Done', type: 'completed' },
  ]
  const comments: Array<string> = []
  const projectSlug = 'SYM-LIVE-FAKE'
  let projectWasCreated = false
  let projectWasCompleted = false
  let currentIssueStateId = 'state-todo'

  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405)
      response.end()
      return
    }

    const raw = await readRequestBody(request)
    const payload = JSON.parse(raw) as { query?: string; variables?: Record<string, unknown> }
    const query = payload.query ?? ''
    const variables = payload.variables ?? {}
    const data = respondToFakeLinear(query, variables)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data }))
  })

  cleanupServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Fake Linear server did not bind to a TCP port')
  }

  return {
    url: `http://127.0.0.1:${address.port}/graphql`,
    completedStateId: 'state-done',
    projectSlug,
    comments,
    issueStateId: () => currentIssueStateId,
    projectCreated: () => projectWasCreated,
    projectCompleted: () => projectWasCompleted,
  }

  function respondToFakeLinear(query: string, variables: Record<string, unknown>): Record<string, unknown> {
    if (query.includes('SymphonyLiveE2ETeam')) {
      return {
        teams: {
          nodes: [
            {
              id: 'team-1',
              key: variables.key,
              name: 'Symphony E2E',
              states: { nodes: states },
            },
          ],
        },
      }
    }

    if (query.includes('query SymphonyLiveE2EProject(')) {
      return {
        projects: {
          nodes: [
            {
              id: 'project-1',
              name: 'Existing fake project',
              slugId: variables.slug,
              url: 'https://linear.local/project-1',
              teams: {
                nodes: [
                  {
                    id: 'team-1',
                    key: 'SYME2E',
                    name: 'Symphony E2E',
                    states: { nodes: states },
                  },
                ],
              },
            },
          ],
        },
      }
    }

    if (query.includes('SymphonyLiveE2ECreateProject')) {
      projectWasCreated = true
      return {
        projectCreate: {
          success: true,
          project: {
            id: 'project-1',
            name: variables.name,
            slugId: projectSlug,
            url: 'https://linear.local/project-1',
          },
        },
      }
    }

    if (query.includes('SymphonyLiveE2ECreateIssue')) {
      currentIssueStateId = String(variables.stateId)
      return {
        issueCreate: {
          success: true,
          issue: {
            id: 'issue-1',
            identifier: 'SYME2E-1',
            title: variables.title,
            description: variables.description,
            url: 'https://linear.local/issue-1',
            state: statePayload(),
          },
        },
      }
    }

    if (query.includes('CandidateIssues') || query.includes('IssuesByStates')) {
      const requestedStates = Array.isArray(variables.stateNames)
        ? variables.stateNames.map((value) => String(value))
        : []
      const includeIssue = requestedStates.includes(statePayload().name)
      return {
        issues: {
          nodes: includeIssue ? [issueNode()] : [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }
    }

    if (query.includes('IssueStatesByIds')) {
      const ids = Array.isArray(variables.ids) ? variables.ids : []
      return {
        issues: {
          nodes: ids.includes('issue-1') ? [issueNode()] : [],
        },
      }
    }

    if (query.includes('SymphonyLiveE2EIssueDetails')) {
      return {
        issue: {
          id: 'issue-1',
          identifier: 'SYME2E-1',
          state: statePayload(),
          comments: { nodes: comments.map((body) => ({ body })) },
        },
      }
    }

    if (query.includes('commentCreate')) {
      comments.push(String(variables.body))
      return { commentCreate: { success: true } }
    }

    if (query.includes('issueUpdate')) {
      currentIssueStateId = String(variables.stateId)
      return { issueUpdate: { success: true } }
    }

    if (query.includes('SymphonyLiveE2EProjectStatuses')) {
      return {
        projectStatuses: {
          nodes: [{ id: 'project-status-done', name: 'Completed', type: 'completed' }],
        },
      }
    }

    if (query.includes('SymphonyLiveE2ECompleteProject')) {
      projectWasCompleted = true
      return { projectUpdate: { success: true } }
    }

    return {}
  }

  function statePayload(): { name: string; type: string } {
    return states.find((state) => state.id === currentIssueStateId) ?? states[0]
  }

  function issueNode(): Record<string, unknown> {
    return {
      id: 'issue-1',
      identifier: 'SYME2E-1',
      title: 'Run fake live e2e',
      description: 'Created by fake Linear',
      priority: null,
      url: 'https://linear.local/issue-1',
      branchName: null,
      assignee: null,
      createdAt: '2026-06-16T00:00:00.000Z',
      updatedAt: '2026-06-16T00:00:00.000Z',
      state: { name: statePayload().name },
      labels: { nodes: [] },
      inverseRelations: { nodes: [] },
    }
  }
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
  }
  return body
}

function commandForNodeScript(scriptPath: string): string {
  return `${quoteShellArg(process.execPath)} ${quoteShellArg(scriptPath)}`
}

function quoteShellArg(value: string): string {
  if (process.platform === 'win32') {
    return /[\s"]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value
  }
  return `'${value.replaceAll("'", "'\\''")}'`
}

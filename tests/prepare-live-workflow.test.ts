import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const projectRoot = path.resolve('.')
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const prepareScript = path.join(projectRoot, 'scripts', 'prepare-live-workflow.ts')

let cleanupDirs: Array<string> = []

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('live workflow preparation script', () => {
  it('fails without Linear credentials', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-live-workflow-missing-'))
    cleanupDirs.push(dir)

    const result = await runPrepare({
      args: ['--out', path.join(dir, 'WORKFLOW.md'), '--dotenv', path.join(dir, 'missing.env')],
      env: {
        LINEAR_API_KEY: '',
        LINEAR_PROJECT_SLUG: '',
        SYMPHONY_LIVE_E2E_PROJECT_SLUG: '',
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      missing: ['LINEAR_API_KEY', 'LINEAR_PROJECT_SLUG'],
    })
  })

  it('writes a validated codex workflow without embedding the Linear API key', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-live-workflow-'))
    cleanupDirs.push(dir)
    const workflowPath = path.join(dir, 'WORKFLOW.md')

    const result = await runPrepare({
      args: ['--out', workflowPath, '--dotenv', path.join(dir, 'missing.env')],
      env: {
        LINEAR_API_KEY: 'test-linear-secret',
        LINEAR_PROJECT_SLUG: 'codex-automation-test-76ba15195432',
        SYMPHONY_RUNNER: 'simulated',
        SYMPHONY_LIVE_WORKFLOW_RUNNER: '',
        SYMPHONY_REQUIRED_LABELS: 'codex,automation',
        SYMPHONY_ACTIVE_STATES: 'Todo,In Progress',
      },
    })

    if (result.exitCode !== 0) {
      throw new Error(`prepare-live-workflow exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }

    const payload = JSON.parse(result.stdout)
    expect(payload).toMatchObject({
      ok: true,
      workflow_path: workflowPath,
      runner: 'codex',
      mock_tracker: false,
      secret_written: false,
      tracker: {
        project_slug: 'codex-automation-test-76ba15195432',
        required_labels: ['codex', 'automation'],
      },
    })

    const workflow = await readFile(workflowPath, 'utf8')
    expect(workflow).toContain('api_key: $LINEAR_API_KEY')
    expect(workflow).toContain('project_slug: $LINEAR_PROJECT_SLUG')
    expect(workflow).toContain("runner: 'codex'")
    expect(workflow).toContain('mock_tracker: false')
    expect(workflow).not.toContain('test-linear-secret')
  })
})

async function runPrepare(input: {
  args: Array<string>
  env: Record<string, string>
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [tsxCli, prepareScript, ...input.args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...input.env,
      LINEAR_ASSIGNEE: input.env.LINEAR_ASSIGNEE ?? '',
      SYMPHONY_LINEAR_PROJECT_SLUG: input.env.SYMPHONY_LINEAR_PROJECT_SLUG ?? '',
      TRACKER_PROJECT_SLUG: input.env.TRACKER_PROJECT_SLUG ?? '',
      SYMPHONY_LIVE_E2E_PROJECT_SLUG: input.env.SYMPHONY_LIVE_E2E_PROJECT_SLUG ?? '',
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
      reject(new Error(`prepare-live-workflow timed out: ${stderr || stdout}`))
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

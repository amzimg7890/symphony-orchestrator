import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const projectRoot = path.resolve('.')
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const statusScript = path.join(projectRoot, 'scripts', 'acceptance-status.ts')

let cleanupDirs: Array<string> = []

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('acceptance status script', () => {
  it('reports missing Linear and workflow prerequisites without failing the status command', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-acceptance-missing-'))
    cleanupDirs.push(dir)

    const result = await runStatus({
      args: [
        '--workflow',
        path.join(dir, 'missing-WORKFLOW.md'),
        '--dotenv',
        path.join(dir, 'missing.env'),
      ],
      env: baseEnv({
        LINEAR_API_KEY: '',
        LINEAR_PROJECT_SLUG: '',
      }),
    })

    if (result.exitCode !== 0) {
      throw new Error(`acceptance status exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }

    const payload = JSON.parse(result.stdout)
    expect(payload).toMatchObject({
      ok: true,
      read_only: true,
      overall_status: 'needs_linear_configuration',
      env: {
        linear_api_key_present: false,
        project_slug: null,
      },
      workflow: {
        status: 'missing',
        exists: false,
      },
    })
    expect(gateStatus(payload, 'real_preflight')).toBe('blocked')
    expect(gateStatus(payload, 'live_e2e')).toBe('skipped')
  })

  it('marks a generated live workflow ready without printing the Linear API key', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-acceptance-ready-'))
    cleanupDirs.push(dir)
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    await writeFile(workflowPath, workflowContent(), 'utf8')

    const result = await runStatus({
      args: ['--workflow', workflowPath, '--dotenv', path.join(dir, 'missing.env')],
      env: baseEnv({
        LINEAR_API_KEY: 'test-linear-secret',
        LINEAR_PROJECT_SLUG: 'codex-automation-test-76ba15195432',
      }),
    })

    if (result.exitCode !== 0) {
      throw new Error(`acceptance status exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }

    expect(result.stdout).not.toContain('test-linear-secret')
    const payload = JSON.parse(result.stdout)
    expect(payload).toMatchObject({
      ok: true,
      read_only: true,
      overall_status: 'ready_for_read_only_live_validation',
      env: {
        linear_api_key_present: true,
        project_slug: 'codex-automation-test-76ba15195432',
        project_slug_source: 'LINEAR_PROJECT_SLUG',
      },
      workflow: {
        status: 'ready',
        runner: 'codex',
        mock_tracker: false,
        secret_written: false,
        tracker: {
          kind: 'linear',
          project_slug: 'codex-automation-test-76ba15195432',
          required_labels: ['codex'],
        },
      },
    })
    expect(gateStatus(payload, 'check_live_workflow')).toBe('ready_to_run')
    expect(gateStatus(payload, 'smoke_live_runtime_readonly')).toBe('ready_to_run')
    expect(gateStatus(payload, 'live_e2e')).toBe('skipped')
  })
})

function workflowContent(): string {
  return [
    '---',
    'tracker:',
    '  kind: linear',
    "  endpoint: 'https://linear.local/graphql'",
    '  api_key: $LINEAR_API_KEY',
    '  project_slug: $LINEAR_PROJECT_SLUG',
    '  required_labels:',
    "    - 'codex'",
    '  active_states:',
    "    - 'Todo'",
    "    - 'In Progress'",
    '  terminal_states:',
    "    - 'Done'",
    'agent:',
    "  runner: 'codex'",
    'demo:',
    '  mock_tracker: false',
    '---',
    'Live acceptance workflow.',
    '',
  ].join('\n')
}

function baseEnv(overrides: Record<string, string>): Record<string, string> {
  return {
    LINEAR_API_KEY: '',
    LINEAR_PROJECT_SLUG: '',
    LINEAR_ASSIGNEE: '',
    SYMPHONY_LINEAR_PROJECT_SLUG: '',
    TRACKER_PROJECT_SLUG: '',
    SYMPHONY_LIVE_E2E_PROJECT_SLUG: '',
    SYMPHONY_RUNNER: '',
    SYMPHONY_LIVE_CODEX_SMOKE: '',
    SYMPHONY_RUN_LIVE_E2E: '',
    SYMPHONY_LIVE_SSH_WORKER_HOSTS: '',
    SYMPHONY_SSH_WORKER_HOSTS: '',
    SYMPHONY_REAL_PREFLIGHT_REQUIRED: '',
    SYMPHONY_SSH_WORKER_PREFLIGHT_REQUIRED: '',
    ...overrides,
  }
}

function gateStatus(payload: unknown, name: string): string | null {
  const gates = (payload as { gates?: Array<{ name: string; status: string }> }).gates ?? []
  return gates.find((gate) => gate.name === name)?.status ?? null
}

async function runStatus(input: {
  args: Array<string>
  env: Record<string, string>
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [tsxCli, statusScript, ...input.args], {
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
      reject(new Error(`acceptance status timed out: ${stderr || stdout}`))
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

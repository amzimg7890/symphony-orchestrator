import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const projectRoot = process.cwd()
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'symphony-cli-bounded-'))

try {
  const workflowPath = path.join(tempDir, 'WORKFLOW.md')
  await writeFile(
    workflowPath,
    [
      '---',
      'tracker:',
      '  kind: memory',
      '  active_states:',
      '    - Todo',
      '  terminal_states:',
      '    - Done',
      '  issues: []',
      'polling:',
      '  interval_ms: 10000',
      'agent:',
      '  runner: simulated',
      'demo:',
      '  mock_tracker: false',
      '---',
      'Bounded CLI smoke.',
    ].join('\n'),
    'utf8',
  )

  const result = await runCli([workflowPath, '--run-for-ms', '250'])
  assert(result.exitCode === 0, `bounded CLI exited ${result.exitCode}\n${result.stderr}`)
  assert(
    result.stdout.includes('Stopping automatically after 250ms.'),
    `bounded CLI output did not include auto-stop message:\n${result.stdout}`,
  )
  assert(result.stdout.includes(`Symphony started with workflow ${workflowPath}`), 'bounded CLI did not start workflow')

  console.log(JSON.stringify({ ok: true, workflow_path: workflowPath, run_duration_ms: 250 }, null, 2))
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

async function runCli(args: Array<string>): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const cliPath = path.join(projectRoot, 'src', 'cli.ts')
  const child = spawn(process.execPath, [tsxCli, cliPath, ...args], {
    cwd: projectRoot,
    env: process.env,
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
      reject(new Error(`bounded CLI timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 10_000)
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

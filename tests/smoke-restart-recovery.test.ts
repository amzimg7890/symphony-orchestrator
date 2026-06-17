import { spawn } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve('.')
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const smokeScript = path.join(projectRoot, 'scripts', 'smoke-restart-recovery.ts')

describe('restart recovery smoke script', () => {
  it('removes terminal workspaces at startup without dispatching a runner', async () => {
    const result = await runSmoke()

    if (result.exitCode !== 0) {
      throw new Error(`restart recovery smoke exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }

    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      read_only: true,
      network: false,
      runner_invoked: false,
      terminal_workspace_removed: true,
      active_workspace_preserved: true,
      startup_cleanup_event_seen: true,
      terminal_issue_identifier: 'DONE-1',
      active_issue_identifier: 'TODO-1',
    })
  })
})

async function runSmoke(): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [tsxCli, smokeScript], {
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
      reject(new Error(`restart recovery smoke timed out: ${stderr || stdout}`))
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

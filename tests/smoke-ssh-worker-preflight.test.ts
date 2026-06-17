import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve('.')
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const smokeScript = path.join(projectRoot, 'scripts', 'smoke-ssh-worker-preflight.ts')

describe('SSH worker preflight smoke script', () => {
  it('skips when no SSH hosts are configured', async () => {
    const result = await runSmoke({
      SYMPHONY_LIVE_SSH_WORKER_HOSTS: '',
      SYMPHONY_SSH_WORKER_HOSTS: '',
      SYMPHONY_SSH_WORKER_PREFLIGHT_REQUIRED: '',
    })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      skipped: true,
      required: false,
    })
  }, 15_000)

  it('runs workspace and app-server checks through fake SSH', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-ssh-preflight-test-'))
    const traceFile = path.join(dir, 'ssh.trace')
    const fakeSshScript = path.join(dir, 'fake-ssh.mjs')
    const remoteWorkspace = '/remote/home/.symphony-test/workspaces/SSH-SMOKE-1'

    await writeFile(
      fakeSshScript,
      [
        "import fs from 'node:fs'",
        "import readline from 'node:readline'",
        "const traceFile = process.env.SYMPHONY_FAKE_SSH_TRACE",
        "const remoteWorkspace = process.env.SYMPHONY_FAKE_REMOTE_WORKSPACE",
        'const argv = process.argv.slice(2)',
        'const command = argv.at(-1) ?? ""',
        'fs.appendFileSync(traceFile, `ARGV:${argv.join(" ")}\\nCOMMAND:${command}\\n`, "utf8")',
        'if (command.includes("codex app-server")) {',
        '  const rl = readline.createInterface({ input: process.stdin })',
        '  const keepAlive = setInterval(() => {}, 1000)',
        '  function write(message) { process.stdout.write(`${JSON.stringify(message)}\\n`) }',
        '  rl.on("line", (line) => {',
        '    const message = JSON.parse(line)',
        '    if (message.method === "initialize") {',
        '      write({ id: message.id, result: { server: "fake-ssh-preflight" } })',
        '    } else if (message.method === "thread/start") {',
        '      write({ id: message.id, result: { thread: { id: "thread-ssh-preflight" } } })',
        '    } else if (message.method === "thread/name/set") {',
        '      write({ id: message.id, result: {} })',
        '    }',
        '  })',
        '  rl.on("close", () => { clearInterval(keepAlive); process.exit(0) })',
        '} else if (command.includes("__SYMPHONY_WORKSPACE__")) {',
        '  process.stdout.write(`__SYMPHONY_WORKSPACE__\\t1\\t${remoteWorkspace}\\n`)',
        '} else if (command.includes("printf ready")) {',
        '  process.stdout.write("ready")',
        '} else if (command.includes("$HOME")) {',
        '  process.stdout.write("/remote/home\\n")',
        '}',
      ].join('\n'),
      'utf8',
    )

    try {
      const result = await runSmoke({
        SYMPHONY_LIVE_SSH_WORKER_HOSTS: 'worker-a:2200',
        SYMPHONY_SSH_WORKER_HOSTS: '',
        SYMPHONY_SSH_WORKER_PREFLIGHT_REQUIRED: '',
        SYMPHONY_SSH_WORKER_WORKSPACE_ROOT: '~/.symphony-test/workspaces',
        SYMPHONY_SSH_WORKER_COMMAND_TIMEOUT_MS: '5000',
        SYMPHONY_SSH_WORKER_CODEX_READ_TIMEOUT_MS: '5000',
        SYMPHONY_SSH_BIN: process.execPath,
        SYMPHONY_SSH_BIN_ARGS: JSON.stringify([fakeSshScript]),
        SYMPHONY_FAKE_SSH_TRACE: traceFile,
        SYMPHONY_FAKE_REMOTE_WORKSPACE: remoteWorkspace,
      })

      if (result.exitCode !== 0) {
        throw new Error(`preflight exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
      }
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        skipped: false,
        worker_count: 1,
        no_turn_started: true,
        workers: [
          {
            worker_host: 'worker-a:2200',
            home: '/remote/home',
            workspace_path: remoteWorkspace,
            app_server_session_started: true,
            thread_id: 'thread-ssh-preflight',
          },
        ],
      })

      const trace = await readFile(traceFile, 'utf8')
      expect(trace).toContain('printf ready')
      expect(trace).toContain('__SYMPHONY_WORKSPACE__')
      expect(trace).toContain('codex app-server')
      expect(trace).toContain('rm -rf')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

async function runSmoke(env: Record<string, string>): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [tsxCli, smokeScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...env,
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
      reject(new Error(`smoke-ssh-worker-preflight timed out: ${stderr || stdout}`))
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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'

type JsonRpcId = number | string

type JsonRpcMessage = {
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: {
    code?: number
    message?: string
  }
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const root = process.cwd()
const smokeRoot = path.join(root, '.tmp', 'codex-app-server-smoke')
const workspace = path.join(smokeRoot, 'workspace')
const requestTimeoutMs = positiveIntegerEnv('SYMPHONY_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS', 60_000)
const approvalPolicy = {
  reject: {
    sandbox_approval: true,
    rules: true,
    mcp_elicitations: true,
  },
}

let proc: ChildProcessWithoutNullStreams | null = null
let client: JsonlClient | null = null

async function main(): Promise<void> {
  try {
    await removeSmokeRoot()
    await mkdir(workspace, { recursive: true })

    const version = await runCommand('codex', ['--version'], 10_000)
    console.log(`[codex-app-server] starting app-server in ${workspace}`)
    proc = spawnCodexAppServer(workspace)

    client = new JsonlClient(proc, requestTimeoutMs)
    const initialized = await client.request('initialize', {
      clientInfo: {
        name: 'symphony_tanstack_smoke',
        title: 'Symphony TanStack Smoke',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    })
    assert(Object.keys(asRecord(initialized)).length > 0, 'initialize should return app-server metadata')

    client.notify('initialized', {})

    const { thread, usedFallback } = await requestThreadStartWithApprovalFallback(client, {
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      sandbox: 'workspace-write',
      serviceName: 'symphony',
      threadSource: 'user',
      dynamicTools: [],
    })
    const threadId = stringValue(asRecord(asRecord(thread).thread).id)
    assert(threadId, 'thread/start should return a thread id')
    const threadName = 'SYM-SMOKE: Codex app-server smoke'
    await client.request('thread/name/set', {
      threadId,
      name: threadName,
    })

    console.log(
      JSON.stringify(
      {
        ok: true,
        codex: version.stdout.trim(),
        initialized: true,
        thread_started: true,
        thread_named: true,
        thread_name: threadName,
        safe_defaults_checked: true,
        approval_policy_fallback: usedFallback,
        request_timeout_ms: requestTimeoutMs,
        workspace,
        note: 'No turn/start was sent; this smoke does not invoke the model.',
      },
        null,
        2,
      ),
    )
  } finally {
    client?.close()
    if (proc) {
      await terminateProcess(proc)
    }
    await removeSmokeRoot()
  }
}

async function requestThreadStartWithApprovalFallback(
  client: JsonlClient,
  params: Record<string, unknown>,
): Promise<{ thread: unknown; usedFallback: boolean }> {
  try {
    return {
      thread: await client.request('thread/start', {
        ...params,
        approvalPolicy,
      }),
      usedFallback: false,
    }
  } catch (error) {
    if (!isUnsupportedRejectApprovalPolicyError(error)) {
      throw error
    }

    return {
      thread: await client.request('thread/start', {
        ...params,
        approvalPolicy: legacyApprovalPolicyFallback(approvalPolicy),
      }),
      usedFallback: true,
    }
  }
}

class JsonlClient {
  private readonly pending = new Map<JsonRpcId, Pending>()
  private readonly rl: readline.Interface
  private stderr = ''
  private nextId = 1
  private closed = false

  constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly requestTimeoutMs: number,
  ) {
    this.rl = readline.createInterface({ input: proc.stdout })
    this.rl.on('line', (line) => this.handleLine(line))
    proc.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-4000)
    })
    proc.once('exit', (code, signal) => {
      if (this.closed) {
        return
      }
      const error = new Error(`codex app-server exited before smoke completed (${code ?? signal}): ${this.stderr.trim()}`)
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      this.pending.clear()
    })
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId
    this.nextId += 1

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for ${method}: ${this.stderr.trim()}`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params })
  }

  close(): void {
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
    }
    this.pending.clear()
    this.rl.close()
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      return
    }

    if (message.id === undefined || !this.pending.has(message.id)) {
      return
    }

    const pending = this.pending.get(message.id)!
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(new Error(`${message.error.code ?? 'error'}: ${message.error.message ?? 'unknown error'}`))
      return
    }
    pending.resolve(message.result)
  }

  private write(message: JsonRpcMessage): void {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`)
  }
}

function spawnCodexAppServer(cwd: string): ChildProcessWithoutNullStreams {
  if (process.platform === 'win32') {
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'codex app-server'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }

  return spawn('codex', ['app-server'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
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

async function terminateProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  const exited = waitForExit(child, 5000)
  if (process.platform === 'win32' && child.pid) {
    await runCommand('taskkill', ['/pid', String(child.pid), '/t', '/f'], 5000).catch(() => {
      child.kill()
    })
  } else {
    child.kill()
  }

  await exited
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function removeSmokeRoot(): Promise<void> {
  await rm(smokeRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function quoteWindowsArg(arg: string): string {
  if (!/[ "]/.test(arg)) {
    return arg
  }

  return `"${arg.replaceAll('"', '\\"')}"`
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer when set`)
  }

  return value
}

function legacyApprovalPolicyFallback(value: unknown): unknown {
  const policy = asRecord(value)
  return { granular: asRecord(policy.reject) }
}

function isUnsupportedRejectApprovalPolicyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /unknown variant [`'"]?reject[`'"]?/i.test(message)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

await main()

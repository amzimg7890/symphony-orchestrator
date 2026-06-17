import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const outDir = path.join(root, '.tmp', 'codex-schema-smoke')

const requiredFiles = [
  'v1/InitializeParams.json',
  'v1/InitializeResponse.json',
  'v2/ThreadStartParams.json',
  'v2/ThreadStartResponse.json',
  'v2/ThreadSetNameParams.json',
  'v2/ThreadSetNameResponse.json',
  'v2/TurnStartParams.json',
  'v2/TurnStartResponse.json',
  'v2/TurnStartedNotification.json',
  'v2/TurnCompletedNotification.json',
  'v2/ThreadTokenUsageUpdatedNotification.json',
  'v2/AccountRateLimitsUpdatedNotification.json',
  'v2/AgentMessageDeltaNotification.json',
  'CommandExecutionRequestApprovalParams.json',
  'FileChangeRequestApprovalParams.json',
  'PermissionsRequestApprovalParams.json',
  'ToolRequestUserInputParams.json',
  'DynamicToolCallParams.json',
  'McpServerElicitationRequestParams.json',
  'ServerRequest.json',
  'ServerNotification.json',
]

const requiredProtocolSnippets = [
  'initialize',
  'initialized',
  'thread/start',
  'thread/name/set',
  'turn/start',
  'turn/interrupt',
  'turn/started',
  'turn/completed',
  'thread/tokenUsage/updated',
  'account/rateLimits/updated',
  'item/agentMessage/delta',
  'item/tool/call',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
]

try {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  console.log(`[codex-schema] generating schema in ${outDir}`)
  const version = await runCommand('codex', ['--version'], 10_000)
  const generated = await runCommand(
    'codex',
    ['app-server', 'generate-json-schema', '--experimental', '--out', outDir],
    30_000,
  )

  for (const file of requiredFiles) {
    const absolute = path.join(outDir, file)
    await readFile(absolute, 'utf8').catch((error) => {
      throw new Error(`Missing required Codex app-server schema file ${file}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const protocolBody = await readProtocolText(outDir)
  for (const snippet of requiredProtocolSnippets) {
    assert(protocolBody.includes(snippet), `Codex app-server schema should include ${snippet}`)
  }

  const files = await listJsonFiles(outDir)
  console.log(
    JSON.stringify(
      {
        ok: true,
        codex: version.stdout.trim(),
        generated_files: files.length,
        out_dir: outDir,
        stderr: generated.stderr.trim() || null,
      },
      null,
      2,
    ),
  )
} finally {
  await rm(outDir, { recursive: true, force: true })
}

async function readProtocolText(directory: string): Promise<string> {
  const files = await listJsonFiles(directory)
  const parts: Array<string> = []
  for (const file of files) {
    parts.push(await readFile(file, 'utf8'))
  }
  return parts.join('\n')
}

async function listJsonFiles(directory: string): Promise<Array<string>> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: Array<string> = []

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listJsonFiles(absolute))
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(absolute)
    }
  }

  return files
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

function quoteWindowsArg(arg: string): string {
  if (!/[ "]/.test(arg)) {
    return arg
  }

  return `"${arg.replaceAll('"', '\\"')}"`
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

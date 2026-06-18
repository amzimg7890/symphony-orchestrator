import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseSymphonyCliArgs, symphonyCliUsage } from './cliArgs'
import { startSymphonyHttpServer, type SymphonyHttpServer } from './httpServer'
import { defaultWorkflowPath, getSymphonyService } from './service'
import type { SymphonyStartOptions } from './orchestrator'
import type { RuntimeSnapshot } from './types'

export type SymphonyCliDeps = {
  defaultWorkflowPath: () => string
  fileRegular: (filePath: string) => Promise<boolean>
  loadDotEnv: (filePath: string) => Promise<void>
  start: (workflowPath: string, options: SymphonyStartOptions) => Promise<RuntimeSnapshot>
  stop: () => Promise<RuntimeSnapshot>
  startHttpServer: (port: number, host: string) => Promise<SymphonyHttpServer>
  stdout: (message: string) => void
  stderr: (message: string) => void
}

export type SymphonyCliResult = {
  exit_code: number
  started: boolean
  workflow_path: string | null
  http_server: SymphonyHttpServer | null
  run_duration_ms?: number
}

export async function runSymphonyCli(
  args: Array<string>,
  deps: SymphonyCliDeps = createRuntimeSymphonyCliDeps(),
): Promise<SymphonyCliResult> {
  let parsed: ReturnType<typeof parseSymphonyCliArgs>
  try {
    parsed = parseSymphonyCliArgs(args, deps.defaultWorkflowPath())
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error))
    deps.stderr(symphonyCliUsage())
    return { exit_code: 1, started: false, workflow_path: null, http_server: null }
  }

  if (parsed.help) {
    deps.stdout(symphonyCliUsage())
    return { exit_code: 0, started: false, workflow_path: null, http_server: null }
  }

  const workflowPath = path.resolve(parsed.workflow_path)
  if (!(await deps.fileRegular(workflowPath))) {
    deps.stderr(`Workflow file not found: ${workflowPath}`)
    return { exit_code: 1, started: false, workflow_path: workflowPath, http_server: null }
  }

  await deps.loadDotEnv(path.resolve(parsed.dotenv_path))

  let serviceStarted = false
  let httpServer: SymphonyHttpServer | null = null
  try {
    const snapshot = await deps.start(workflowPath, parsed.start_options)
    serviceStarted = true
    if (snapshot.config.server_port !== null) {
      httpServer = await deps.startHttpServer(
        snapshot.config.server_port,
        snapshot.config.server_host ?? '127.0.0.1',
      )
    }

    deps.stdout(`Symphony started with workflow ${workflowPath}`)
    deps.stdout(`Logs: ${snapshot.config.logging_path ?? 'disabled'}`)
    if (httpServer) {
      deps.stdout(`HTTP: ${httpServer.url}`)
    }
    if (parsed.run_duration_ms) {
      deps.stdout(`Stopping automatically after ${parsed.run_duration_ms}ms.`)
    } else {
      deps.stdout('Press Ctrl+C to stop.')
    }
    return {
      exit_code: 0,
      started: true,
      workflow_path: workflowPath,
      http_server: httpServer,
      ...(parsed.run_duration_ms === undefined ? {} : { run_duration_ms: parsed.run_duration_ms }),
    }
  } catch (error) {
    if (httpServer) {
      await httpServer.close().catch(() => {})
    }
    if (serviceStarted) {
      await deps.stop().catch(() => {})
    }

    const message = error instanceof Error ? error.message : String(error)
    deps.stderr(`Failed to start Symphony with workflow ${workflowPath}: ${message}`)
    return { exit_code: 1, started: false, workflow_path: workflowPath, http_server: null }
  }
}

export function createRuntimeSymphonyCliDeps(): SymphonyCliDeps {
  const service = getSymphonyService()
  return {
    defaultWorkflowPath,
    fileRegular,
    loadDotEnv,
    start: (workflowPath, options) => service.start(workflowPath, options),
    stop: () => service.stop(),
    startHttpServer: (port, host) => startSymphonyHttpServer({ port, host, service }),
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  }
}

async function fileRegular(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile()
  } catch {
    return false
  }
}

async function loadDotEnv(filePath: string): Promise<void> {
  if (!existsSync(filePath)) {
    return
  }

  const content = await readFile(filePath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match) {
      continue
    }

    const [, key, rawValue] = match
    process.env[key] ??= unquoteDotEnvValue(rawValue)
  }
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

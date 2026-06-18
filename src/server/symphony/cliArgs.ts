import type { SymphonyStartOptions } from './orchestrator'

export type ParsedSymphonyCliArgs = {
  help: boolean
  workflow_path: string
  dotenv_path: string
  start_options: SymphonyStartOptions
  run_duration_ms?: number
}

export function parseSymphonyCliArgs(
  args: Array<string>,
  defaultWorkflowPath: string,
): ParsedSymphonyCliArgs {
  let workflowPath: string | null = null
  let dotenvPath = '.env'
  let logsRoot: string | undefined
  let serverPort: number | null | undefined
  let runDurationMs: number | undefined
  let help = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }

    if (arg === '--logs-root' || arg.startsWith('--logs-root=')) {
      const value = valueForOption(args, index, '--logs-root').trim()
      if (!value) {
        throw new Error('--logs-root requires a value')
      }
      if (arg === '--logs-root') {
        index += 1
      }
      logsRoot = value
      continue
    }

    if (arg === '--dotenv' || arg.startsWith('--dotenv=')) {
      const value = valueForOption(args, index, '--dotenv').trim()
      if (!value) {
        throw new Error('--dotenv requires a value')
      }
      if (arg === '--dotenv') {
        index += 1
      }
      dotenvPath = value
      continue
    }

    if (arg === '--port' || arg.startsWith('--port=')) {
      const value = valueForOption(args, index, '--port')
      if (arg === '--port') {
        index += 1
      }
      serverPort = parsePort(value)
      continue
    }

    if (arg === '--run-for-ms' || arg.startsWith('--run-for-ms=')) {
      const value = valueForOption(args, index, '--run-for-ms')
      if (arg === '--run-for-ms') {
        index += 1
      }
      runDurationMs = parsePositiveInteger(value, '--run-for-ms')
      continue
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    }

    if (workflowPath) {
      throw new Error(`Unexpected extra workflow path: ${arg}`)
    }
    workflowPath = arg
  }

  return {
    help,
    workflow_path: workflowPath ?? defaultWorkflowPath,
    dotenv_path: dotenvPath,
    start_options: {
      config_overrides: {
        ...(logsRoot === undefined ? {} : { logging_root: logsRoot }),
        ...(serverPort === undefined ? {} : { server_port: serverPort }),
      },
    },
    ...(runDurationMs === undefined ? {} : { run_duration_ms: runDurationMs }),
  }
}

export function symphonyCliUsage(): string {
  return [
    'Usage: symphony [WORKFLOW.md] [--logs-root PATH] [--port PORT]',
    '',
    'Options:',
    '  --dotenv PATH    Load environment variables from PATH before startup (default: .env).',
    '  --logs-root PATH  Override logging.root for this process.',
    '  --port PORT       Override server.port in runtime snapshots.',
    '  --run-for-ms MS   Stop the daemon automatically after this many milliseconds.',
    '  -h, --help        Show this help.',
  ].join('\n')
}

function valueForOption(args: Array<string>, index: number, option: string): string {
  const arg = args[index]
  const inlinePrefix = `${option}=`
  if (arg.startsWith(inlinePrefix)) {
    const value = arg.slice(inlinePrefix.length)
    if (value) {
      return value
    }
    throw new Error(`${option} requires a value`)
  }

  const value = args[index + 1]
  if (!value || value.startsWith('-')) {
    throw new Error(`${option} requires a value`)
  }

  return value
}

function parsePort(value: string): number {
  const port = Number(value)
  if (Number.isInteger(port) && port >= 0 && port <= 65_535) {
    return port
  }

  throw new Error('--port must be an integer between 0 and 65535')
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value)
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed
  }

  throw new Error(`${option} must be a positive integer`)
}

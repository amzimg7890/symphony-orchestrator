import type { SymphonyStartOptions } from './orchestrator'

export type ParsedSymphonyCliArgs = {
  help: boolean
  workflow_path: string
  start_options: SymphonyStartOptions
}

export function parseSymphonyCliArgs(
  args: Array<string>,
  defaultWorkflowPath: string,
): ParsedSymphonyCliArgs {
  let workflowPath: string | null = null
  let logsRoot: string | undefined
  let serverPort: number | null | undefined
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

    if (arg === '--port' || arg.startsWith('--port=')) {
      const value = valueForOption(args, index, '--port')
      if (arg === '--port') {
        index += 1
      }
      serverPort = parsePort(value)
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
    start_options: {
      config_overrides: {
        ...(logsRoot === undefined ? {} : { logging_root: logsRoot }),
        ...(serverPort === undefined ? {} : { server_port: serverPort }),
      },
    },
  }
}

export function symphonyCliUsage(): string {
  return [
    'Usage: symphony [WORKFLOW.md] [--logs-root PATH] [--port PORT]',
    '',
    'Options:',
    '  --logs-root PATH  Override logging.root for this process.',
    '  --port PORT       Override server.port in runtime snapshots.',
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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { SymphonyError } from './errors'

export type SshCommandResult = {
  stdout: string
  stderr: string
  exit_code: number | null
  signal: NodeJS.Signals | null
  timed_out: boolean
}

export function buildSshArgs(workerHost: string, command: string): Array<string> {
  const target = parseSshTarget(workerHost)
  return [
    ...sshConfigArgs(process.env.SYMPHONY_SSH_CONFIG),
    '-T',
    ...(target.port ? ['-p', target.port] : []),
    target.destination,
    remoteShellCommand(command),
  ]
}

export function remoteShellCommand(command: string): string {
  return `bash -lc ${shellEscape(command)}`
}

export function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function spawnSsh(workerHost: string, command: string): ChildProcessWithoutNullStreams {
  const executable = process.env.SYMPHONY_SSH_BIN?.trim() || 'ssh'
  return spawn(executable, [...sshBinPrefixArgs(process.env.SYMPHONY_SSH_BIN_ARGS), ...buildSshArgs(workerHost, command)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

export async function runSshCommand(
  workerHost: string,
  command: string,
  timeoutMs: number,
): Promise<SshCommandResult> {
  const child = spawnSsh(workerHost, command)
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
      resolve({
        stdout,
        stderr,
        exit_code: null,
        signal: null,
        timed_out: true,
      })
    }, timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new SymphonyError('workspace_error', `Unable to start ssh for ${workerHost}: ${error.message}`, {
        cause: error,
      }))
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({
        stdout,
        stderr,
        exit_code: code,
        signal,
        timed_out: false,
      })
    })
  })
}

function parseSshTarget(workerHost: string): { destination: string; port: string | null } {
  const trimmed = workerHost.trim()
  const match = /^(.*):(\d+)$/.exec(trimmed)
  if (!match) {
    return { destination: trimmed, port: null }
  }

  const [, destination, port] = match
  if (!validPortDestination(destination)) {
    return { destination: trimmed, port: null }
  }

  return { destination, port }
}

function validPortDestination(destination: string): boolean {
  return destination !== '' && (!destination.includes(':') || bracketedHost(destination))
}

function bracketedHost(destination: string): boolean {
  return destination.includes('[') && destination.includes(']')
}

function sshConfigArgs(configPath: string | undefined): Array<string> {
  const trimmed = configPath?.trim()
  return trimmed ? ['-F', trimmed] : []
}

function sshBinPrefixArgs(value: string | undefined): Array<string> {
  const trimmed = value?.trim()
  if (!trimmed) {
    return []
  }

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed
      }
    } catch {
      return [trimmed]
    }
  }

  return [trimmed]
}

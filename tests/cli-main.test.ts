import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSymphonyCli, type SymphonyCliDeps } from '../src/server/symphony/cliMain'
import type { SymphonyHttpServer } from '../src/server/symphony/httpServer'
import type { SymphonyStartOptions } from '../src/server/symphony/orchestrator'
import type { RuntimeSnapshot } from '../src/server/symphony/types'

describe('Symphony CLI lifecycle', () => {
  it('prints usage without touching runtime deps for --help', async () => {
    const { deps, calls } = cliDeps()

    const result = await runSymphonyCli(['--help'], deps)

    expect(result).toEqual({ exit_code: 0, started: false, workflow_path: null, http_server: null })
    expect(calls.file_regular).toEqual([])
    expect(calls.dotenv).toEqual([])
    expect(calls.starts).toEqual([])
    expect(calls.stdout.join('\n')).toContain('Usage: symphony')
  })

  it('uses the default workflow path and passes runtime overrides to service start', async () => {
    const { deps, calls } = cliDeps()

    const result = await runSymphonyCli(['--logs-root', './logs', '--port', '0'], deps)

    expect(result).toEqual({
      exit_code: 0,
      started: true,
      workflow_path: path.resolve('WORKFLOW.md'),
      http_server: null,
    })
    expect(calls.file_regular).toEqual([path.resolve('WORKFLOW.md')])
    expect(calls.dotenv).toEqual([path.resolve('.env')])
    expect(calls.starts).toEqual([
      {
        workflow_path: path.resolve('WORKFLOW.md'),
        options: {
          config_overrides: {
            logging_root: './logs',
            server_port: 0,
          },
        },
      },
    ])
    expect(calls.stdout).toContain(`Symphony started with workflow ${path.resolve('WORKFLOW.md')}`)
    expect(calls.stdout).toContain('Logs: disabled')
  })

  it('expands explicit workflow paths before checking and starting', async () => {
    const { deps, calls } = cliDeps()
    const workflowPath = path.join('tmp', 'custom', 'WORKFLOW.md')
    const resolvedWorkflowPath = path.resolve(workflowPath)

    await runSymphonyCli([workflowPath], deps)

    expect(calls.file_regular).toEqual([resolvedWorkflowPath])
    expect(calls.starts[0]?.workflow_path).toBe(resolvedWorkflowPath)
  })

  it('loads a custom dotenv file before starting the service', async () => {
    const { deps, calls } = cliDeps()

    await runSymphonyCli(['--dotenv', 'config/local.env', 'WORKFLOW.md'], deps)

    expect(calls.dotenv).toEqual([path.resolve('config/local.env')])
    expect(calls.starts).toHaveLength(1)
  })

  it('starts an HTTP listener with the configured runtime host when server.port is set', async () => {
    const { deps, calls } = cliDeps({
      start: async (workflowPath, options) => {
        calls.starts.push({ workflow_path: workflowPath, options })
        return cliSnapshot({ serverPort: 0, serverHost: '0.0.0.0' })
      },
    })

    const result = await runSymphonyCli(['--port', '0'], deps)

    expect(result).toMatchObject({
      exit_code: 0,
      started: true,
      workflow_path: path.resolve('WORKFLOW.md'),
      http_server: {
        url: 'http://127.0.0.1:49152',
      },
    })
    expect(calls.http_starts).toEqual([{ port: 0, host: '0.0.0.0' }])
    expect(calls.stdout).toContain('HTTP: http://127.0.0.1:49152')
  })

  it('returns bounded daemon runtime metadata when --run-for-ms is set', async () => {
    const { deps, calls } = cliDeps()

    const result = await runSymphonyCli(['WORKFLOW.github.md', '--run-for-ms', '120000'], deps)

    expect(result).toMatchObject({
      exit_code: 0,
      started: true,
      workflow_path: path.resolve('WORKFLOW.github.md'),
      run_duration_ms: 120000,
    })
    expect(calls.stdout).toContain('Stopping automatically after 120000ms.')
    expect(calls.stdout).not.toContain('Press Ctrl+C to stop.')
  })

  it('stops the service when the HTTP listener fails to bind', async () => {
    const { deps, calls } = cliDeps({
      start: async (workflowPath, options) => {
        calls.starts.push({ workflow_path: workflowPath, options })
        return cliSnapshot({ serverPort: 3000 })
      },
      startHttpServer: async () => {
        throw new Error('listen EADDRINUSE')
      },
    })

    const result = await runSymphonyCli(['--port', '3000'], deps)

    expect(result).toEqual({
      exit_code: 1,
      started: false,
      workflow_path: path.resolve('WORKFLOW.md'),
      http_server: null,
    })
    expect(calls.stops).toBe(1)
    expect(calls.stderr).toEqual([
      `Failed to start Symphony with workflow ${path.resolve('WORKFLOW.md')}: listen EADDRINUSE`,
    ])
  })

  it('returns a clean error when the workflow file does not exist', async () => {
    const { deps, calls } = cliDeps({
      fileRegular: async () => false,
    })

    const result = await runSymphonyCli(['missing/WORKFLOW.md'], deps)

    expect(result).toEqual({
      exit_code: 1,
      started: false,
      workflow_path: path.resolve('missing/WORKFLOW.md'),
      http_server: null,
    })
    expect(calls.starts).toEqual([])
    expect(calls.dotenv).toEqual([])
    expect(calls.stderr).toEqual([`Workflow file not found: ${path.resolve('missing/WORKFLOW.md')}`])
  })

  it('returns a startup error when service start fails', async () => {
    const { deps, calls } = cliDeps({
      start: async () => {
        throw new Error('boom')
      },
    })

    const result = await runSymphonyCli(['WORKFLOW.md'], deps)

    expect(result).toEqual({
      exit_code: 1,
      started: false,
      workflow_path: path.resolve('WORKFLOW.md'),
      http_server: null,
    })
    expect(calls.stderr).toEqual([
      `Failed to start Symphony with workflow ${path.resolve('WORKFLOW.md')}: boom`,
    ])
  })

  it('returns usage for invalid CLI arguments before checking files', async () => {
    const { deps, calls } = cliDeps()

    const result = await runSymphonyCli(['--wat'], deps)

    expect(result).toEqual({ exit_code: 1, started: false, workflow_path: null, http_server: null })
    expect(calls.file_regular).toEqual([])
    expect(calls.dotenv).toEqual([])
    expect(calls.starts).toEqual([])
    expect(calls.stderr[0]).toBe('Unknown option: --wat')
    expect(calls.stderr[1]).toContain('Usage: symphony')
  })
})

function cliDeps(overrides: Partial<SymphonyCliDeps> = {}): {
  deps: SymphonyCliDeps
  calls: {
    file_regular: Array<string>
    dotenv: Array<string>
    starts: Array<{ workflow_path: string; options: SymphonyStartOptions }>
    stdout: Array<string>
    stderr: Array<string>
    http_starts: Array<{ port: number; host: string }>
    stops: number
  }
} {
  const calls = {
    file_regular: [] as Array<string>,
    dotenv: [] as Array<string>,
    starts: [] as Array<{ workflow_path: string; options: SymphonyStartOptions }>,
    stdout: [] as Array<string>,
    stderr: [] as Array<string>,
    http_starts: [] as Array<{ port: number; host: string }>,
    stops: 0,
  }
  const deps: SymphonyCliDeps = {
    defaultWorkflowPath: () => path.resolve('WORKFLOW.md'),
    fileRegular: async (filePath) => {
      calls.file_regular.push(filePath)
      return true
    },
    loadDotEnv: async (filePath) => {
      calls.dotenv.push(filePath)
    },
    start: async (workflowPath, options) => {
      calls.starts.push({ workflow_path: workflowPath, options })
      return cliSnapshot()
    },
    stop: async () => {
      calls.stops += 1
      return cliSnapshot()
    },
    startHttpServer: async (port, host) => {
      calls.http_starts.push({ port, host })
      return fakeHttpServer()
    },
    stdout: (message) => {
      calls.stdout.push(message)
    },
    stderr: (message) => {
      calls.stderr.push(message)
    },
    ...overrides,
  }

  return { deps, calls }
}

function cliSnapshot(options: { serverPort?: number | null; serverHost?: string } = {}): RuntimeSnapshot {
  return {
    generated_at: new Date(0).toISOString(),
    service_status: 'running',
    workflow_path: path.resolve('WORKFLOW.md'),
    counts: {
      running: 0,
      retrying: 0,
      blocked: 0,
      claimed: 0,
      completed: 0,
    },
    running: [],
    retrying: [],
    blocked: [],
    codex_totals: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      seconds_running: 0,
    },
    rate_limits: null,
    polling: {
      'checking?': false,
      next_poll_in_ms: null,
      poll_interval_ms: null,
    },
    recent_events: [],
    config_errors: [],
    last_error: null,
    config: {
      poll_interval_ms: null,
      max_concurrent_agents: null,
      workspace_root: null,
      worker_ssh_hosts: [],
      worker_max_concurrent_agents_per_host: null,
      active_states: [],
      terminal_states: [],
      runner: 'simulated',
      tracker: 'mock-linear',
      server_port: options.serverPort ?? null,
      server_host: options.serverHost ?? '127.0.0.1',
      observability_dashboard_enabled: true,
      observability_refresh_ms: 1000,
      observability_render_interval_ms: 16,
      logging_path: null,
    },
  }
}

function fakeHttpServer(): SymphonyHttpServer {
  return {
    host: '0.0.0.0',
    port: 49152,
    url: 'http://127.0.0.1:49152',
    async close() {},
  }
}

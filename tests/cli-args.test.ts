import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSymphonyCliArgs } from '../src/server/symphony/cliArgs'

describe('Symphony CLI arguments', () => {
  it('parses workflow path and runtime overrides', () => {
    const parsed = parseSymphonyCliArgs(
      ['WORKFLOW.custom.md', '--logs-root', './runtime-log', '--port=4567'],
      path.resolve('WORKFLOW.md'),
    )

    expect(parsed).toEqual({
      help: false,
      workflow_path: 'WORKFLOW.custom.md',
      dotenv_path: '.env',
      start_options: {
        config_overrides: {
          logging_root: './runtime-log',
          server_port: 4567,
        },
      },
    })
  })

  it('uses the default workflow path when no positional path is provided', () => {
    const defaultWorkflow = path.resolve('WORKFLOW.md')
    const parsed = parseSymphonyCliArgs(['--logs-root= ./logs '], defaultWorkflow)

    expect(parsed.workflow_path).toBe(defaultWorkflow)
    expect(parsed.dotenv_path).toBe('.env')
    expect(parsed.start_options.config_overrides).toEqual({
      logging_root: './logs',
    })
  })

  it('parses a custom dotenv path', () => {
    const parsed = parseSymphonyCliArgs(['--dotenv', './local.env', 'WORKFLOW.md'], 'DEFAULT.md')

    expect(parsed.workflow_path).toBe('WORKFLOW.md')
    expect(parsed.dotenv_path).toBe('./local.env')
  })

  it('accepts port zero as an ephemeral-port override', () => {
    const parsed = parseSymphonyCliArgs(['--port', '0'], 'WORKFLOW.md')

    expect(parsed.start_options.config_overrides).toEqual({
      server_port: 0,
    })
  })

  it('parses a bounded daemon runtime', () => {
    const parsed = parseSymphonyCliArgs(['WORKFLOW.github.md', '--run-for-ms', '30000'], 'WORKFLOW.md')

    expect(parsed.workflow_path).toBe('WORKFLOW.github.md')
    expect(parsed.run_duration_ms).toBe(30000)
  })

  it('rejects invalid ports and unknown flags', () => {
    expect(() => parseSymphonyCliArgs(['--port=65536'], 'WORKFLOW.md')).toThrow(
      '--port must be an integer between 0 and 65535',
    )
    expect(() => parseSymphonyCliArgs(['--wat'], 'WORKFLOW.md')).toThrow('Unknown option: --wat')
  })

  it('rejects blank dotenv overrides', () => {
    expect(() => parseSymphonyCliArgs(['--dotenv', '   '], 'WORKFLOW.md')).toThrow(
      '--dotenv requires a value',
    )
    expect(() => parseSymphonyCliArgs(['--dotenv='], 'WORKFLOW.md')).toThrow(
      '--dotenv requires a value',
    )
  })

  it('rejects invalid bounded daemon runtimes', () => {
    expect(() => parseSymphonyCliArgs(['--run-for-ms', '0'], 'WORKFLOW.md')).toThrow(
      '--run-for-ms must be a positive integer',
    )
    expect(() => parseSymphonyCliArgs(['--run-for-ms=soon'], 'WORKFLOW.md')).toThrow(
      '--run-for-ms must be a positive integer',
    )
  })

  it('rejects blank logs-root overrides', () => {
    expect(() => parseSymphonyCliArgs(['--logs-root', '   '], 'WORKFLOW.md')).toThrow(
      '--logs-root requires a value',
    )
    expect(() => parseSymphonyCliArgs(['--logs-root='], 'WORKFLOW.md')).toThrow(
      '--logs-root requires a value',
    )
  })
})

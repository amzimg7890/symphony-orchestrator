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
    expect(parsed.start_options.config_overrides).toEqual({
      logging_root: './logs',
    })
  })

  it('accepts port zero as an ephemeral-port override', () => {
    const parsed = parseSymphonyCliArgs(['--port', '0'], 'WORKFLOW.md')

    expect(parsed.start_options.config_overrides).toEqual({
      server_port: 0,
    })
  })

  it('rejects invalid ports and unknown flags', () => {
    expect(() => parseSymphonyCliArgs(['--port=65536'], 'WORKFLOW.md')).toThrow(
      '--port must be an integer between 0 and 65535',
    )
    expect(() => parseSymphonyCliArgs(['--wat'], 'WORKFLOW.md')).toThrow('Unknown option: --wat')
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

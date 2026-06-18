import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWorkflowConfig } from '../src/server/symphony/config'
import { parseWorkflow } from '../src/server/symphony/workflow'

describe('workflow parsing and config resolution', () => {
  it('accepts prompt-only files without front matter', () => {
    const workflow = parseWorkflow('Prompt only\n', path.resolve('PROMPT_ONLY_WORKFLOW.md'))

    expect(workflow.config).toEqual({})
    expect(workflow.prompt_template).toBe('Prompt only')
  })

  it('splits YAML front matter from the prompt body', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: $LINEAR_API_KEY',
        '  project_slug: demo',
        '---',
        'Work on {{ issue.identifier }}.',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    expect(workflow.config.tracker).toMatchObject({
      kind: 'linear',
      api_key: '$LINEAR_API_KEY',
      project_slug: 'demo',
    })
    expect(workflow.prompt_template).toBe('Work on {{ issue.identifier }}.')
  })

  it('accepts unterminated YAML front matter with an empty prompt', () => {
    const workflow = parseWorkflow(
      ['---', 'tracker:', '  kind: linear', ''].join('\n'),
      path.resolve('UNTERMINATED_WORKFLOW.md'),
    )

    expect(workflow.config).toEqual({
      tracker: {
        kind: 'linear',
      },
    })
    expect(workflow.prompt_template).toBe('')
  })

  it('applies defaults and resolves env references only where requested', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: $LINEAR_API_KEY',
        '  project_slug: $LINEAR_PROJECT_SLUG',
        '  assignee: $LINEAR_ASSIGNEE',
        'workspace:',
        '  root: ./workspaces',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('fixtures/WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {
      LINEAR_API_KEY: ' secret-token ',
      LINEAR_PROJECT_SLUG: ' demo-project ',
      LINEAR_ASSIGNEE: 'me',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.tracker.api_key).toBe('secret-token')
      expect(result.config.tracker.project_slug).toBe('demo-project')
      expect(result.config.tracker.assignee).toBe('me')
      expect(result.config.polling.interval_ms).toBe(30_000)
      expect(result.config.workspace.root).toBe(path.resolve('fixtures/workspaces'))
      expect(result.config.workspace.remote_root).toBe('./workspaces')
      expect(result.config.worker).toEqual({
        ssh_hosts: [],
        max_concurrent_agents_per_host: null,
      })
      expect(result.config.logging.root).toBe(path.resolve('fixtures/log'))
      expect(result.config.logging.file).toBe('symphony.jsonl')
      expect(result.config.server.host).toBe('127.0.0.1')
      expect(result.config.server.port).toBeNull()
      expect(result.config.observability).toEqual({
        dashboard_enabled: true,
        refresh_ms: 1000,
        render_interval_ms: 16,
      })
      expect(result.config.codex.command).toBe('codex app-server')
      expect(result.config.codex.approval_policy).toEqual({
        reject: {
          sandbox_approval: true,
          rules: true,
          mcp_elicitations: true,
        },
      })
      expect(result.config.codex.thread_sandbox).toBe('workspace-write')
      expect(result.config.codex.turn_sandbox_policy).toBe('workspace-write')
    }
  })

  it('uses the reference default workspace root when omitted', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('fixtures/WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {})

    expect(result.ok).toBe(true)
    if (result.ok) {
      const expectedRoot = path.resolve(os.tmpdir(), 'symphony_workspaces')
      expect(result.config.workspace.root).toBe(expectedRoot)
      expect(result.config.workspace.remote_root).toBe(expectedRoot.replaceAll('\\', '/'))
    }
  })

  it('uses the reference default workspace root when path env resolution is empty', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'workspace:',
        '  root: $MISSING_WORKSPACE_ROOT',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('fixtures/WORKFLOW.md'),
    )
    const blankWorkflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'workspace:',
        '  root: ""',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('fixtures/WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, { MISSING_WORKSPACE_ROOT: undefined })
    const blankResult = resolveWorkflowConfig(blankWorkflow, {})
    const expectedRoot = path.resolve(os.tmpdir(), 'symphony_workspaces')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.workspace.root).toBe(expectedRoot)
      expect(result.config.workspace.remote_root).toBe(expectedRoot.replaceAll('\\', '/'))
    }
    expect(blankResult.ok).toBe(true)
    if (blankResult.ok) {
      expect(blankResult.config.workspace.root).toBe(expectedRoot)
      expect(blankResult.config.workspace.remote_root).toBe(expectedRoot.replaceAll('\\', '/'))
    }
  })

  it('matches reference Codex config validation boundaries', () => {
    const whitespaceCommandWorkflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'codex:',
        '  command: "   "',
        '  approval_policy: definitely-not-valid',
        '  thread_sandbox: unsafe-ish',
        '  turn_sandbox_policy:',
        '    type: workspaceWrite',
        '    writableRoots:',
        '      - relative/path',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )
    const emptyCommandWorkflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'codex:',
        '  command: ""',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )
    const invalidTypeWorkflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'codex:',
        '  command: 123',
        '  approval_policy: 123',
        '  thread_sandbox: 123',
        '  turn_sandbox_policy: bad',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    const whitespaceResult = resolveWorkflowConfig(whitespaceCommandWorkflow, {})
    const emptyCommandResult = resolveWorkflowConfig(emptyCommandWorkflow, {})
    const invalidTypeResult = resolveWorkflowConfig(invalidTypeWorkflow, {})

    expect(whitespaceResult.ok).toBe(true)
    if (whitespaceResult.ok) {
      expect(whitespaceResult.config.codex.command).toBe('   ')
      expect(whitespaceResult.config.codex.approval_policy).toBe('definitely-not-valid')
      expect(whitespaceResult.config.codex.thread_sandbox).toBe('unsafe-ish')
      expect(whitespaceResult.config.codex.turn_sandbox_policy).toEqual({
        type: 'workspaceWrite',
        writableRoots: ['relative/path'],
      })
    }

    expect(emptyCommandResult.ok).toBe(false)
    expect(emptyCommandResult.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_codex_command',
          message: 'codex.command must be a non-empty shell command',
        }),
      ]),
    )

    expect(invalidTypeResult.ok).toBe(false)
    expect(invalidTypeResult.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_config',
          message: 'codex.command must be a string',
        }),
        expect.objectContaining({
          code: 'invalid_config',
          message: 'codex.approval_policy must be a string or object',
        }),
        expect.objectContaining({
          code: 'invalid_config',
          message: 'codex.thread_sandbox must be a string',
        }),
        expect.objectContaining({
          code: 'invalid_config',
          message: 'codex.turn_sandbox_policy must be an object',
        }),
      ]),
    )
  })

  it('rejects structured log files outside the logging root', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'logging:',
        '  root: ./logs',
        '  file: ../escape.jsonl',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('fixtures/WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {})

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_config',
          message: 'logging.file must resolve inside logging.root',
        }),
      ]),
    )
  })

  it('applies runtime overrides for logs root while preserving configured server host', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'server:',
        '  port: 3000',
        '  host: 0.0.0.0',
        'logging:',
        '  root: ./workflow-logs',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('fixtures/WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {}, {
      logging_root: './runtime-logs',
      server_port: 4567,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.logging.root).toBe(path.resolve('fixtures/runtime-logs'))
      expect(result.config.server.port).toBe(4567)
      expect(result.config.server.host).toBe('0.0.0.0')
    }
  })

  it('validates configured server host and port values', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'server:',
        '  port: -1',
        '  host: 123',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('fixtures/WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {})

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_config',
          message: 'server.port must be an integer between 0 and 65535',
        }),
        expect.objectContaining({
          code: 'invalid_config',
          message: 'server.host must be a string',
        }),
      ]),
    )
  })

  it('parses and validates observability settings', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'observability:',
        '  dashboard_enabled: false',
        '  refresh_ms: 2500',
        '  render_interval_ms: 33',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('fixtures/WORKFLOW.md'),
    )

    const invalidWorkflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'observability:',
        '  dashboard_enabled: maybe',
        '  refresh_ms: 0',
        '  render_interval_ms: nope',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('fixtures/WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {})
    const invalidResult = resolveWorkflowConfig(invalidWorkflow, {})

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.observability).toEqual({
        dashboard_enabled: false,
        refresh_ms: 2500,
        render_interval_ms: 33,
      })
    }

    expect(invalidResult.ok).toBe(false)
    expect(invalidResult.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_config',
          message: 'observability.dashboard_enabled must be a boolean',
        }),
        expect.objectContaining({
          code: 'invalid_config',
          message: 'observability.refresh_ms must be a positive integer',
        }),
        expect.objectContaining({
          code: 'invalid_config',
          message: 'observability.render_interval_ms must be a positive integer',
        }),
      ]),
    )
  })

  it('expands home paths with either slash style after env resolution', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'workspace:',
        '  root: $WORKSPACE_ROOT',
        'logging:',
        '  root: "~\\\\symphony-logs"',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('fixtures/WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {
      WORKSPACE_ROOT: '~/symphony-workspaces',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.workspace.root).toBe(path.join(os.homedir(), 'symphony-workspaces'))
      expect(result.config.workspace.remote_root).toBe('~/symphony-workspaces')
      expect(result.config.logging.root).toBe(path.join(os.homedir(), 'symphony-logs'))
    }
  })

  it('normalizes required labels while preserving one blank label so it matches no issue', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        '  required_labels:',
        '    - " CoDeX "',
        '    - codex',
        '    - "   "',
        '    - " "',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {})

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.tracker.required_labels).toEqual(['codex', ''])
    }
  })

  it('rejects non-list tracker state and label config values', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        '  required_labels: codex',
        '  active_states: ","',
        '  terminal_states:',
        '    done: true',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )
    const invalidElementWorkflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        '  active_states:',
        '    - Todo',
        '    - 42',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {})
    const invalidElementResult = resolveWorkflowConfig(invalidElementWorkflow, {})

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_config',
          message: 'tracker.required_labels must be a list of strings',
        }),
        expect.objectContaining({
          code: 'invalid_config',
          message: 'tracker.active_states must be a list of strings',
        }),
        expect.objectContaining({
          code: 'invalid_config',
          message: 'tracker.terminal_states must be a list of strings',
        }),
      ]),
    )
    expect(invalidElementResult.ok).toBe(false)
    expect(invalidElementResult.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_config',
          message: 'tracker.active_states must be a list of strings',
        }),
      ]),
    )
  })

  it('parses and validates optional SSH worker settings', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'workspace:',
        '  root: /remote/symphony-workspaces',
        'worker:',
        '  ssh_hosts:',
        '    - worker-a',
        '    - "  "',
        '    - worker-b:2200',
        '  max_concurrent_agents_per_host: 2',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )
    const invalidWorkflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'worker:',
        '  max_concurrent_agents_per_host: 0',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {})
    const invalidResult = resolveWorkflowConfig(invalidWorkflow, {})

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.worker).toEqual({
        ssh_hosts: ['worker-a', 'worker-b:2200'],
        max_concurrent_agents_per_host: 2,
      })
      expect(result.config.workspace.remote_root).toBe('/remote/symphony-workspaces')
    }
    expect(invalidResult.ok).toBe(false)
    expect(invalidResult.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_config',
          message: 'worker.max_concurrent_agents_per_host must be a positive integer',
        }),
      ]),
    )
  })

  it('parses and validates per-state concurrency overrides', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'agent:',
        '  max_concurrent_agents_by_state:',
        '    Todo: 1',
        '    "In Progress": 4',
        '    "In Review": 2',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )
    const invalidWorkflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'agent:',
        '  max_concurrent_agents_by_state:',
        '    "": 1',
        '    Todo: 0',
        '    Review: "2"',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {})
    const invalidResult = resolveWorkflowConfig(invalidWorkflow, {})

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.agent.max_concurrent_agents_by_state).toEqual({
        todo: 1,
        'in progress': 4,
        'in review': 2,
      })
    }
    expect(invalidResult.ok).toBe(false)
    expect(invalidResult.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_config',
          message: 'agent.max_concurrent_agents_by_state state names must not be blank',
        }),
        expect.objectContaining({
          code: 'invalid_config',
          message: 'agent.max_concurrent_agents_by_state limits must be positive integers',
        }),
      ]),
    )
  })

  it('validates codex stall timeout while allowing zero to disable stall detection', () => {
    const disabledWorkflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'codex:',
        '  stall_timeout_ms: 0',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    const invalidWorkflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'codex:',
        '  stall_timeout_ms: soon',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )
    const negativeWorkflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: demo',
        'codex:',
        '  stall_timeout_ms: -1',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    const disabledResult = resolveWorkflowConfig(disabledWorkflow, {})
    const invalidResult = resolveWorkflowConfig(invalidWorkflow, {})
    const negativeResult = resolveWorkflowConfig(negativeWorkflow, {})

    expect(disabledResult.ok).toBe(true)
    if (disabledResult.ok) {
      expect(disabledResult.config.codex.stall_timeout_ms).toBe(0)
    }
    expect(invalidResult.ok).toBe(false)
    expect(invalidResult.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_config',
          message: 'codex.stall_timeout_ms must be a non-negative integer',
        }),
      ]),
    )
    expect(negativeResult.ok).toBe(false)
    expect(negativeResult.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_config',
          message: 'codex.stall_timeout_ms must be a non-negative integer',
        }),
      ]),
    )
  })

  it('surfaces missing dispatch credentials as typed errors', () => {
    const workflow = parseWorkflow(
      ['---', 'tracker:', '  kind: linear', '---', 'Prompt'].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {})

    expect(result.ok).toBe(false)
    expect(result.errors.map((error) => error.code)).toContain('missing_tracker_api_key')
    expect(result.errors.map((error) => error.code)).toContain('missing_tracker_project_slug')
  })

  it('treats an empty env-backed project slug as missing', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: token',
        '  project_slug: $LINEAR_PROJECT_SLUG',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {
      LINEAR_PROJECT_SLUG: '   ',
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_tracker_project_slug',
          message: 'tracker.project_slug is required for tracker.kind=linear and may point at $LINEAR_PROJECT_SLUG',
        }),
      ]),
    )
  })

  it('falls back to Linear environment defaults for missing secret env references', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: $SYMPHONY_MISSING_LINEAR_API_KEY',
        '  project_slug: demo',
        '  assignee: $SYMPHONY_MISSING_LINEAR_ASSIGNEE',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {
      LINEAR_API_KEY: ' fallback-token ',
      LINEAR_ASSIGNEE: ' fallback-user ',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.tracker.api_key).toBe('fallback-token')
      expect(result.config.tracker.assignee).toBe('fallback-user')
    }
  })

  it('treats an empty env-backed api key as missing', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: $LINEAR_API_KEY',
        '  project_slug: demo',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {
      LINEAR_API_KEY: '   ',
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_tracker_api_key',
          message: 'tracker.api_key is required and may point at $LINEAR_API_KEY',
        }),
      ]),
    )
  })

  it('does not fall back when an explicit secret env reference resolves empty', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: $EMPTY_LINEAR_API_KEY',
        '  project_slug: demo',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {
      EMPTY_LINEAR_API_KEY: '',
      LINEAR_API_KEY: 'fallback-token',
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_tracker_api_key',
          message: 'tracker.api_key is required and may point at $LINEAR_API_KEY',
        }),
      ]),
    )
  })

  it('requires an explicit tracker kind before dispatch', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  api_key: token',
        '  project_slug: demo',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {})

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_tracker_kind',
          message: 'tracker.kind is required and currently supports "linear", "github", or "memory"',
        }),
      ]),
    )
  })

  it('supports GitHub tracker configuration through local gh without Linear credentials', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: github',
        '  repo: $GITHUB_REPOSITORY',
        '  gh_command: gh',
        '  assignee: me',
        '  required_labels:',
        '    - codex',
        'agent:',
        '  runner: simulated',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {
      GITHUB_REPOSITORY: 'openai/symphony',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected github config to resolve')
    }

    expect(result.config.tracker).toMatchObject({
      kind: 'github',
      repository: 'openai/symphony',
      gh_command: 'gh',
      assignee: 'me',
      required_labels: ['codex'],
      active_states: ['Open'],
      terminal_states: ['Closed'],
      api_key: '',
      project_slug: '',
    })
    expect(result.config.demo.mock_tracker).toBe(false)
  })

  it('rejects invalid GitHub repository names before gh is invoked', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: github',
        '  repo: $GITHUB_REPOSITORY',
        'agent:',
        '  runner: codex',
        'demo:',
        '  mock_tracker: false',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {
      GITHUB_REPOSITORY: 'fresh_food_butler',
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_config',
          message: 'tracker.repo must use OWNER/REPO or HOST/OWNER/REPO format for tracker.kind=github',
        }),
      ]),
    )
  })

  it('supports memory tracker issues without Linear credentials', () => {
    const workflow = parseWorkflow(
      [
        '---',
        'tracker:',
        '  kind: memory',
        '  active_states: [Todo]',
        '  issues:',
        '    - id: issue-memory-1',
        '      identifier: MEM-1',
        '      title: Run local memory issue',
        '      state: Todo',
        '      labels: [codex, local]',
        '      blocked_by:',
        '        - id: blocker-1',
        '          identifier: MEM-0',
        '          state: Done',
        '---',
        'Prompt',
      ].join('\n'),
      path.resolve('WORKFLOW.md'),
    )

    const result = resolveWorkflowConfig(workflow, {})

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected memory config to resolve')
    }
    expect(result.config.tracker.kind).toBe('memory')
    expect(result.config.agent.runner).toBe('simulated')
    expect(result.config.demo.mock_tracker).toBe(false)
    expect(result.config.tracker.memory_issues).toEqual([
      expect.objectContaining({
        id: 'issue-memory-1',
        identifier: 'MEM-1',
        title: 'Run local memory issue',
        state: 'Todo',
        labels: ['codex', 'local'],
        assigned_to_worker: true,
        blocked_by: [
          {
            id: 'blocker-1',
            identifier: 'MEM-0',
            state: 'Done',
            created_at: null,
            updated_at: null,
          },
        ],
      }),
    ])
  })
})

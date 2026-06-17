import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildThreadStartParams,
  buildTurnStartParams,
  CodexAppServerRunner,
  issueThreadName,
  legacyApprovalPolicyFallback,
  mapNotificationToRuntimeEvent,
  splitCommandLine,
} from '../src/server/symphony/codexAppServerRunner'
import { resolveWorkflowConfig } from '../src/server/symphony/config'
import { parseWorkflow } from '../src/server/symphony/workflow'
import type { AgentRuntimeEvent, IssueTracker, Workspace } from '../src/server/symphony/types'

describe('Codex app-server runner adapter', () => {
  it('keeps a compatibility parser for simple quoted app-server commands', () => {
    expect(splitCommandLine('codex app-server --listen stdio://')).toEqual({
      executable: 'codex',
      args: ['app-server', '--listen', 'stdio://'],
    })
    expect(splitCommandLine('"C:/Program Files/Codex/codex.exe" app-server')).toEqual({
      executable: 'C:/Program Files/Codex/codex.exe',
      args: ['app-server'],
    })
  })

  it('launches codex.command through the host shell so environment-backed commands work', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-shell-command-'))
    const fakeServerPath = path.resolve('tests/fixtures/fake-codex-app-server.mjs')
    const previousNode = process.env.SYMPHONY_FAKE_NODE
    const previousServer = process.env.SYMPHONY_FAKE_CODEX_APP_SERVER
    process.env.SYMPHONY_FAKE_NODE = process.execPath
    process.env.SYMPHONY_FAKE_CODEX_APP_SERVER = fakeServerPath

    const command =
      process.platform === 'win32'
        ? '"%SYMPHONY_FAKE_NODE%" "%SYMPHONY_FAKE_CODEX_APP_SERVER%"'
        : '"$SYMPHONY_FAKE_NODE" "$SYMPHONY_FAKE_CODEX_APP_SERVER"'
    const config = codexRunnerConfig('', command)
    const events: Array<AgentRuntimeEvent> = []

    try {
      await new CodexAppServerRunner().run({
        issue: issueFixture('issue-shell', 'SYM-SHELL'),
        workspace: {
          path: workspaceRoot,
          workspace_key: 'SYM-SHELL',
          created_now: false,
        },
        prompt: 'Run through shell.',
        turn_number: 1,
        continuation: false,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })

      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining(['session_started', 'turn_started', 'turn_completed']),
      )
    } finally {
      restoreEnv('SYMPHONY_FAKE_NODE', previousNode)
      restoreEnv('SYMPHONY_FAKE_CODEX_APP_SERVER', previousServer)
      await removeWorkspaceRoot(workspaceRoot)
    }
  }, 15_000)

  it('launches Codex app-server over ssh when a worker host is assigned', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-ssh-'))
    const traceFile = path.join(dir, 'ssh.trace')
    const restoreSsh = await installFakeSshAppServer(dir, traceFile)
    const config = codexRunnerConfig('', 'codex app-server --listen stdio://')
    const events: Array<AgentRuntimeEvent> = []

    try {
      await new CodexAppServerRunner().run({
        issue: issueFixture('issue-ssh', 'SYM-SSH'),
        workspace: {
          path: '/remote/workspaces/SYM-SSH',
          workspace_key: 'SYM-SSH',
          created_now: false,
        },
        worker_host: 'worker-ssh:2222',
        prompt: 'Run remotely.',
        turn_number: 1,
        continuation: false,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })

      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining(['session_started', 'turn_started', 'turn_completed']),
      )

      const trace = await readFile(traceFile, 'utf8')
      expect(trace).toContain('-p')
      expect(trace).toContain('2222')
      expect(trace).toContain('worker-ssh')
      expect(trace).toContain('/remote/workspaces/SYM-SSH')
      expect(trace).toContain('exec codex app-server --listen stdio://')
    } finally {
      restoreSsh()
      await removeWorkspaceRoot(dir)
    }
  }, 15_000)

  it('builds v2 thread and turn params from workflow config', () => {
    const config = resolveDemoConfig([
      'agent:',
      '  runner: codex',
      'codex:',
      '  command: codex app-server',
      '  model: gpt-5.4',
      '  approval_policy: on-request',
      '  approvals_reviewer: auto_review',
      '  thread_sandbox: workspace-write',
      'demo:',
      '  mock_tracker: false',
    ])
    const workspace: Workspace = {
      path: path.resolve('workspaces/SYM-101'),
      workspace_key: 'SYM-101',
      created_now: false,
    }
    const issue = {
      ...issueFixture('issue-101', 'SYM-101'),
      title: 'Preserve issue metadata',
    }

    const threadParams = buildThreadStartParams(config, workspace)
    const turnParams = buildTurnStartParams(config, workspace, 'thread-1', 'Prompt', { issue })

    expect(threadParams).toMatchObject({
      cwd: workspace.path,
      model: 'gpt-5.4',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'workspace-write',
    })
    expect(threadParams.dynamicTools).toEqual([
      expect.objectContaining({ name: 'linear_graphql' }),
    ])
    expect(turnParams).toMatchObject({
      threadId: 'thread-1',
      cwd: workspace.path,
      model: 'gpt-5.4',
      input: [{ type: 'text', text: 'Prompt' }],
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [workspace.path],
      },
      responsesapiClientMetadata: {
        service: 'symphony',
        issue_id: 'issue-101',
        issue_identifier: 'SYM-101',
        issue_title: 'Preserve issue metadata',
      },
    })
  })

  it('builds a bounded one-line app-server thread name from issue context', () => {
    const issue = {
      ...issueFixture('issue-name', 'SYM-NAME'),
      title: `Name\n${'x'.repeat(180)}`,
    }

    expect(issueThreadName(issue)).toBe(`SYM-NAME: Name ${'x'.repeat(142)}...`)
    expect(issueThreadName(issue)).toHaveLength(160)
  })

  it('uses reference-safe Codex defaults when workflow omits sandbox settings', () => {
    const config = resolveDemoConfig([
      'agent:',
      '  runner: codex',
      'codex:',
      '  command: codex app-server',
      'demo:',
      '  mock_tracker: true',
    ])
    const workspace: Workspace = {
      path: path.resolve('workspaces/SYM-202'),
      workspace_key: 'SYM-202',
      created_now: false,
    }

    expect(buildThreadStartParams(config, workspace)).toMatchObject({
      approvalPolicy: {
        reject: {
          sandbox_approval: true,
          rules: true,
          mcp_elicitations: true,
        },
      },
      sandbox: 'workspace-write',
    })
    expect(buildTurnStartParams(config, workspace, 'thread-safe', 'Prompt')).toMatchObject({
      approvalPolicy: {
        reject: {
          sandbox_approval: true,
          rules: true,
          mcp_elicitations: true,
        },
      },
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [workspace.path],
      },
    })
    expect(legacyApprovalPolicyFallback(config.codex.approval_policy)).toEqual({
      granular: {
        sandbox_approval: true,
        rules: true,
        mcp_elicitations: true,
      },
    })
  })

  it('falls back to legacy granular approval policy when app-server rejects object-form defaults', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-approval-fallback-'))
    const config = codexRunnerConfig('--reject-unsupported')
    const events: Array<AgentRuntimeEvent> = []

    try {
      await new CodexAppServerRunner().run({
        issue: issueFixture('issue-approval-fallback', 'SYM-FALLBACK'),
        workspace: {
          path: workspaceRoot,
          workspace_key: 'SYM-FALLBACK',
          created_now: false,
        },
        prompt: 'Run after approval fallback.',
        turn_number: 1,
        continuation: false,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })

      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining(['session_started', 'turn_started', 'turn_completed']),
      )
    } finally {
      await removeWorkspaceRoot(workspaceRoot)
    }
  })

  it('sets the app-server thread name when the protocol supports it', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-thread-name-'))
    const previousName = process.env.SYMPHONY_EXPECTED_THREAD_NAME
    process.env.SYMPHONY_EXPECTED_THREAD_NAME = 'SYM-NAME: Name fake thread'
    const config = codexRunnerConfig('--require-thread-name')
    const events: Array<AgentRuntimeEvent> = []

    try {
      await new CodexAppServerRunner().run({
        issue: {
          ...issueFixture('issue-thread-name', 'SYM-NAME'),
          title: 'Name fake thread',
        },
        workspace: {
          path: workspaceRoot,
          workspace_key: 'SYM-NAME',
          created_now: false,
        },
        prompt: 'Run after thread naming.',
        turn_number: 1,
        continuation: false,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })

      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining(['session_started', 'turn_started', 'turn_completed']),
      )
    } finally {
      restoreEnv('SYMPHONY_EXPECTED_THREAD_NAME', previousName)
      await removeWorkspaceRoot(workspaceRoot)
    }
  }, 15_000)

  it('maps app-server notifications into Symphony runtime events', () => {
    const tokenEvent = mapNotificationToRuntimeEvent(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          tokenUsage: {
            total: {
              inputTokens: 100,
              outputTokens: 25,
              totalTokens: 125,
            },
          },
        },
      },
      { pid: '1234', threadId: null, turnId: null },
    )

    const completedEvent = mapNotificationToRuntimeEvent(
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed' },
        },
      },
      { pid: '1234', threadId: 'thread-1', turnId: 'turn-1' },
    )

    const rateLimitEvent = mapNotificationToRuntimeEvent(
      {
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            limitId: 'codex',
            primary: { usedPercent: 25 },
          },
        },
      },
      { pid: '1234', threadId: 'thread-1', turnId: 'turn-1' },
    )

    const progressEvent = mapNotificationToRuntimeEvent(
      {
        method: 'turn/plan/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          explanation: 'Check the workspace',
          plan: [{ step: 'Inspect files', status: 'completed' }],
        },
      },
      { pid: '1234', threadId: null, turnId: null },
    )

    expect(tokenEvent?.usage).toEqual({
      input_tokens: 100,
      output_tokens: 25,
      total_tokens: 125,
    })
    expect(completedEvent).toMatchObject({
      event: 'turn_completed',
      session_id: 'thread-1-turn-1',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
    })
    expect(rateLimitEvent).toMatchObject({
      event: 'account/rateLimits/updated',
      session_id: 'thread-1',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      rate_limits: {
        limitId: 'codex',
        primary: { usedPercent: 25 },
      },
    })
    expect(progressEvent).toMatchObject({
      event: 'turn/plan/updated',
      session_id: 'thread-1-turn-1',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      message: 'plan updated: Check the workspace',
    })
  })

  it('extracts cumulative token usage from supported app-server payload shapes', () => {
    const snakeCaseThreadUsage = mapNotificationToRuntimeEvent(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-usage',
          turnId: 'turn-usage',
          tokenUsage: {
            total: {
              input_tokens: '12',
              output_tokens: 4,
              total_tokens: 16,
            },
          },
        },
      },
      { pid: '4242', threadId: null, turnId: null },
    )
    const turnCompletedUsage = mapNotificationToRuntimeEvent(
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-usage',
          turn: { id: 'turn-usage', status: 'completed' },
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        },
      },
      { pid: '4242', threadId: null, turnId: null },
    )
    const wrapperUsage = mapNotificationToRuntimeEvent(
      {
        method: 'codex/event/token_count',
        params: {
          threadId: 'thread-usage',
          turnId: 'turn-usage',
          msg: {
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                last_token_usage: {
                  input_tokens: 2,
                  output_tokens: 1,
                  total_tokens: 3,
                },
                total_token_usage: {
                  input_tokens: 200,
                  output_tokens: 100,
                  total_tokens: 300,
                },
              },
            },
          },
        },
      },
      { pid: '4242', threadId: null, turnId: null },
    )
    const lastOnlyWrapperUsage = mapNotificationToRuntimeEvent(
      {
        method: 'codex/event/token_count',
        params: {
          threadId: 'thread-usage',
          turnId: 'turn-usage',
          msg: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 8,
                output_tokens: 3,
                total_tokens: 11,
              },
            },
          },
        },
      },
      { pid: '4242', threadId: null, turnId: null },
    )

    expect(snakeCaseThreadUsage?.usage).toEqual({
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16,
    })
    expect(turnCompletedUsage).toMatchObject({
      event: 'turn_completed',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
    })
    expect(wrapperUsage).toMatchObject({
      event: 'codex/event/token_count',
      usage: {
        input_tokens: 200,
        output_tokens: 100,
        total_tokens: 300,
      },
    })
    expect(lastOnlyWrapperUsage?.usage).toBeUndefined()
  })

  it('extracts rate limits from codex wrapper events', () => {
    const rateLimits = {
      limit_id: 'codex',
      primary: { remaining: 90, limit: 100 },
      secondary: null,
    }
    const event = mapNotificationToRuntimeEvent(
      {
        method: 'codex/event/token_count',
        params: {
          threadId: 'thread-rate',
          turnId: 'turn-rate',
          msg: {
            type: 'event_msg',
            payload: {
              type: 'token_count',
              rate_limits: rateLimits,
            },
          },
        },
      },
      { pid: '4242', threadId: null, turnId: null },
    )

    expect(event).toMatchObject({
      event: 'codex/event/token_count',
      session_id: 'thread-rate-turn-rate',
      rate_limits: rateLimits,
    })
  })

  it('drives a JSONL app-server process through a complete turn', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-runner-'))
    const config = codexRunnerConfig()
    const events: Array<AgentRuntimeEvent> = []

    try {
      await new CodexAppServerRunner().run({
        issue: {
          ...issueFixture('issue-1', 'SYM-1'),
          title: 'Run fake app server',
        },
        workspace: {
          path: workspaceRoot,
          workspace_key: 'SYM-1',
          created_now: false,
        },
        prompt: 'Do the fake work.',
        turn_number: 1,
        continuation: false,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })

      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining([
          'session_started',
          'turn_started',
          'thread/tokenUsage/updated',
          'account/rateLimits/updated',
          'turn/plan/updated',
          'notification',
          'turn_completed',
        ]),
      )
      expect(events.find((event) => event.event === 'thread/tokenUsage/updated')?.usage).toEqual({
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      })
      expect(events.find((event) => event.event === 'account/rateLimits/updated')?.rate_limits).toMatchObject({
        limitId: 'codex',
        primary: { usedPercent: 42 },
      })
      expect(events.find((event) => event.event === 'turn/plan/updated')).toMatchObject({
        session_id: 'thread-fake-turn-fake',
        message: 'plan updated: Fake plan update',
      })
      expect(events.at(-1)).toMatchObject({
        event: 'turn_completed',
        thread_id: 'thread-fake',
        turn_id: 'turn-fake',
      })
    } finally {
      await removeWorkspaceRoot(workspaceRoot)
    }
  }, 15_000)

  it('turns app-server approval requests into blocked handoff events', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-approval-'))
    const config = codexRunnerConfig('--approval')
    const events: Array<AgentRuntimeEvent> = []

    try {
      await new CodexAppServerRunner().run({
        issue: {
          ...issueFixture('issue-2', 'SYM-2'),
          title: 'Request approval',
        },
        workspace: {
          path: workspaceRoot,
          workspace_key: 'SYM-2',
          created_now: false,
        },
        prompt: 'Ask for approval.',
        turn_number: 1,
        continuation: false,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'approval_required',
            session_id: 'thread-fake-turn-fake',
            thread_id: 'thread-fake',
            turn_id: 'turn-fake',
            message: 'Need operator approval in fake app-server',
          }),
        ]),
      )
      expect(events.map((event) => event.event)).not.toContain('turn_completed')
    } finally {
      await removeWorkspaceRoot(workspaceRoot)
    }
  }, 15_000)

  it('auto-approves command approval requests when approval policy is never', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-auto-approval-'))
    const config = codexRunnerConfig('--auto-approval', undefined, ['  approval_policy: never'])
    const events: Array<AgentRuntimeEvent> = []

    try {
      await new CodexAppServerRunner().run({
        issue: {
          ...issueFixture('issue-auto-approval', 'SYM-AUTO'),
          title: 'Auto approve',
        },
        workspace: {
          path: workspaceRoot,
          workspace_key: 'SYM-AUTO',
          created_now: false,
        },
        prompt: 'Auto approve command approval.',
        turn_number: 1,
        continuation: false,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'approval_auto_approved',
            message: 'acceptForSession',
          }),
          expect.objectContaining({
            event: 'turn_completed',
          }),
        ]),
      )
      expect(events.map((event) => event.event)).not.toContain('approval_required')
    } finally {
      await removeWorkspaceRoot(workspaceRoot)
    }
  }, 15_000)

  it('auto-approves tool approval prompts when approval policy is never', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-tool-approval-'))
    const config = codexRunnerConfig('--tool-approval-input', undefined, ['  approval_policy: never'])
    const events: Array<AgentRuntimeEvent> = []

    try {
      await new CodexAppServerRunner().run({
        issue: {
          ...issueFixture('issue-tool-approval', 'SYM-TOOL-APPROVAL'),
          title: 'Auto approve tool input',
        },
        workspace: {
          path: workspaceRoot,
          workspace_key: 'SYM-TOOL-APPROVAL',
          created_now: false,
        },
        prompt: 'Auto approve tool approval input.',
        turn_number: 1,
        continuation: false,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'approval_auto_approved',
            message: 'Approve this Session',
          }),
          expect.objectContaining({
            event: 'turn_completed',
          }),
        ]),
      )
      expect(events.map((event) => event.event)).not.toContain('mcp_elicitation_required')
    } finally {
      await removeWorkspaceRoot(workspaceRoot)
    }
  }, 15_000)

  it('answers tool input prompts with a generic non-interactive response', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-tool-input-'))
    const config = codexRunnerConfig('--tool-input')
    const events: Array<AgentRuntimeEvent> = []

    try {
      await new CodexAppServerRunner().run({
        issue: {
          ...issueFixture('issue-tool-input', 'SYM-TOOL-INPUT'),
          title: 'Answer tool input',
        },
        workspace: {
          path: workspaceRoot,
          workspace_key: 'SYM-TOOL-INPUT',
          created_now: false,
        },
        prompt: 'Answer tool input.',
        turn_number: 1,
        continuation: false,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'tool_input_auto_answered',
            message: 'This is a non-interactive session. Operator input is unavailable.',
          }),
          expect.objectContaining({
            event: 'turn_completed',
          }),
        ]),
      )
      expect(events.map((event) => event.event)).not.toContain('mcp_elicitation_required')
    } finally {
      await removeWorkspaceRoot(workspaceRoot)
    }
  }, 15_000)

  it('treats MCP elicitation notifications as hard input blockers', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-mcp-elicitation-'))
    const config = codexRunnerConfig('--mcp-elicitation')
    const events: Array<AgentRuntimeEvent> = []

    try {
      await new CodexAppServerRunner().run({
        issue: {
          ...issueFixture('issue-mcp-elicitation', 'SYM-MCP'),
          title: 'Block on MCP elicitation',
        },
        workspace: {
          path: workspaceRoot,
          workspace_key: 'SYM-MCP',
          created_now: false,
        },
        prompt: 'Request MCP elicitation.',
        turn_number: 1,
        continuation: false,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'mcp_elicitation_required',
            session_id: 'thread-fake-turn-fake',
            thread_id: 'thread-fake',
            turn_id: 'turn-fake',
            message: 'Need operator input',
          }),
        ]),
      )
      expect(events.map((event) => event.event)).not.toContain('turn_completed')
    } finally {
      await removeWorkspaceRoot(workspaceRoot)
    }
  }, 15_000)

  it('treats turn needs_input notifications as hard input blockers', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-turn-needs-input-'))
    const config = codexRunnerConfig('--turn-needs-input')
    const events: Array<AgentRuntimeEvent> = []

    try {
      await new CodexAppServerRunner().run({
        issue: {
          ...issueFixture('issue-turn-needs-input', 'SYM-NEEDS-INPUT'),
          title: 'Block on turn needs input',
        },
        workspace: {
          path: workspaceRoot,
          workspace_key: 'SYM-NEEDS-INPUT',
          created_now: false,
        },
        prompt: 'Request turn-level operator input.',
        turn_number: 1,
        continuation: false,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'turn_input_required',
            session_id: 'thread-fake-turn-fake',
            thread_id: 'thread-fake',
            turn_id: 'turn-fake',
            message: 'Need operator input from turn notification',
          }),
        ]),
      )
      expect(events.map((event) => event.event)).not.toContain('turn_completed')
    } finally {
      await removeWorkspaceRoot(workspaceRoot)
    }
  }, 15_000)

  it('emits malformed events for JSON-like protocol lines that fail to decode', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-malformed-protocol-'))
    const config = codexRunnerConfig('--malformed-protocol')
    const events: Array<AgentRuntimeEvent> = []

    try {
      await new CodexAppServerRunner().run({
        issue: {
          ...issueFixture('issue-malformed-protocol', 'SYM-MALFORMED'),
          title: 'Report malformed protocol lines',
        },
        workspace: {
          path: workspaceRoot,
          workspace_key: 'SYM-MALFORMED',
          created_now: false,
        },
        prompt: 'Emit malformed protocol line.',
        turn_number: 1,
        continuation: false,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'malformed',
            session_id: 'thread-fake-turn-fake',
            thread_id: 'thread-fake',
            turn_id: 'turn-fake',
            message: 'malformed JSON event from codex',
          }),
          expect.objectContaining({
            event: 'turn_completed',
          }),
        ]),
      )
    } finally {
      await removeWorkspaceRoot(workspaceRoot)
    }
  }, 15_000)

  it('rejects unsupported dynamic tool calls without stalling the turn', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-unsupported-tool-'))
    const config = codexRunnerConfig('--unsupported-tool-call')
    const events: Array<AgentRuntimeEvent> = []

    try {
      await new CodexAppServerRunner().run({
        issue: {
          ...issueFixture('issue-tool-unsupported', 'SYM-TOOL'),
          title: 'Reject unsupported tool',
        },
        workspace: {
          path: workspaceRoot,
          workspace_key: 'SYM-TOOL',
          created_now: false,
        },
        prompt: 'Ask for an unsupported dynamic tool.',
        turn_number: 1,
        continuation: false,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })

      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining(['session_started', 'turn_started', 'turn_completed']),
      )
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'unsupported_tool_call',
            session_id: 'thread-fake-turn-fake',
            message: 'not_a_real_tool',
          }),
        ]),
      )
    } finally {
      await removeWorkspaceRoot(workspaceRoot)
    }
  }, 15_000)

  it('executes supported dynamic tool calls and returns the tool result', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-linear-tool-'))
    const fakeLinear = await startFakeLinearEndpoint()
    const baseConfig = codexRunnerConfig('--linear-tool-call')
    const config = {
      ...baseConfig,
      tracker: {
        ...baseConfig.tracker,
        endpoint: fakeLinear.url,
      },
      demo: {
        ...baseConfig.demo,
        mock_tracker: false,
      },
    }
    const events: Array<AgentRuntimeEvent> = []

    try {
      await new CodexAppServerRunner().run({
        issue: {
          ...issueFixture('issue-tool-linear', 'SYM-LINEAR'),
          title: 'Execute supported dynamic tool',
        },
        workspace: {
          path: workspaceRoot,
          workspace_key: 'SYM-LINEAR',
          created_now: false,
        },
        prompt: 'Ask for a supported dynamic tool.',
        turn_number: 1,
        continuation: false,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })

      expect(fakeLinear.calls).toEqual([
        expect.objectContaining({
          authorization: 'demo-token',
          query: 'query Viewer { viewer { id } }',
          variables: { includeTeams: false },
        }),
      ])
      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining(['session_started', 'turn_started', 'turn_completed']),
      )
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'tool_call_completed',
            session_id: 'thread-fake-turn-fake',
            message: 'linear_graphql',
          }),
        ]),
      )
    } finally {
      await fakeLinear.close()
      await removeWorkspaceRoot(workspaceRoot)
    }
  }, 15_000)

  it('emits tool_call_failed for supported dynamic tool failures', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-linear-tool-failure-'))
    const fakeLinear = await startFakeLinearEndpoint({
      responseBody: { errors: [{ message: 'fake Linear GraphQL failure' }] },
    })
    const baseConfig = codexRunnerConfig('--linear-tool-call-failure')
    const config = {
      ...baseConfig,
      tracker: {
        ...baseConfig.tracker,
        endpoint: fakeLinear.url,
      },
      demo: {
        ...baseConfig.demo,
        mock_tracker: false,
      },
    }
    const events: Array<AgentRuntimeEvent> = []

    try {
      await new CodexAppServerRunner().run({
        issue: {
          ...issueFixture('issue-tool-linear-failed', 'SYM-LINEAR-FAIL'),
          title: 'Record supported dynamic tool failure',
        },
        workspace: {
          path: workspaceRoot,
          workspace_key: 'SYM-LINEAR-FAIL',
          created_now: false,
        },
        prompt: 'Ask for a supported dynamic tool that fails.',
        turn_number: 1,
        continuation: false,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })

      expect(fakeLinear.calls).toEqual([
        expect.objectContaining({
          authorization: 'demo-token',
          query: 'query Viewer { viewer { id } }',
          variables: { includeTeams: false },
        }),
      ])
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'tool_call_failed',
            session_id: 'thread-fake-turn-fake',
            message: 'linear_graphql',
          }),
          expect.objectContaining({
            event: 'turn_completed',
          }),
        ]),
      )
    } finally {
      await fakeLinear.close()
      await removeWorkspaceRoot(workspaceRoot)
    }
  }, 15_000)

  it('emits usage and rate limits from wrapper token-count events', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-wrapper-usage-'))
    const config = codexRunnerConfig('--wrapper-token-count')
    const events: Array<AgentRuntimeEvent> = []

    try {
      await new CodexAppServerRunner().run({
        issue: {
          ...issueFixture('issue-wrapper-usage', 'SYM-USAGE'),
          title: 'Track wrapper usage',
        },
        workspace: {
          path: workspaceRoot,
          workspace_key: 'SYM-USAGE',
          created_now: false,
        },
        prompt: 'Emit wrapper usage.',
        turn_number: 1,
        continuation: false,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })

      const wrapperEvent = events.find((event) => event.event === 'codex/event/token_count')
      expect(wrapperEvent).toMatchObject({
        usage: {
          input_tokens: 24,
          output_tokens: 6,
          total_tokens: 30,
        },
        rate_limits: {
          limit_id: 'codex',
          primary: {
            remaining: 9,
            limit: 10,
          },
        },
      })
    } finally {
      await removeWorkspaceRoot(workspaceRoot)
    }
  }, 15_000)

  it('reuses one app-server thread for multiple turns in a session', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'symphony-codex-session-'))
    const config = codexRunnerConfig()
    const events: Array<AgentRuntimeEvent> = []
    const issue = {
      ...issueFixture('issue-3', 'SYM-3'),
      title: 'Run two fake turns',
    }
    const workspace: Workspace = {
      path: workspaceRoot,
      workspace_key: 'SYM-3',
      created_now: false,
    }
    const runner = new CodexAppServerRunner()

    try {
      const session = await runner.startSession({
        issue,
        workspace,
        attempt: null,
        config,
        tracker: fakeTracker,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      })
      try {
        await session.run({
          issue,
          workspace,
          prompt: 'First turn.',
          turn_number: 1,
          continuation: false,
          attempt: null,
          config,
          tracker: fakeTracker,
          signal: new AbortController().signal,
          emit: (event) => events.push(event),
        })
        await session.run({
          issue,
          workspace,
          prompt: 'Continue turn.',
          turn_number: 2,
          continuation: true,
          attempt: null,
          config,
          tracker: fakeTracker,
          signal: new AbortController().signal,
          emit: (event) => events.push(event),
        })
      } finally {
        await session.close()
      }

      expect(events.filter((event) => event.event === 'session_started')).toHaveLength(1)
      expect([
        ...new Set(events.filter((event) => event.event === 'turn_started').map((event) => event.turn_id)),
      ]).toEqual(['turn-fake', 'turn-fake-2'])
      expect(new Set(events.map((event) => event.thread_id).filter(Boolean))).toEqual(new Set(['thread-fake']))
    } finally {
      await removeWorkspaceRoot(workspaceRoot)
    }
  }, 15_000)
})

function resolveDemoConfig(extraFrontMatter: Array<string>) {
  const workflow = parseWorkflow(
    [
      '---',
      'tracker:',
      '  kind: linear',
      '  api_key: demo-token',
      '  project_slug: demo',
      'workspace:',
      '  root: ./workspaces',
      ...extraFrontMatter,
      '---',
      'Prompt',
    ].join('\n'),
    path.resolve('WORKFLOW.md'),
  )

  const result = resolveWorkflowConfig(workflow, {})
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error('expected valid config')
  }

  return result.config
}

function codexRunnerConfig(mode = '', commandOverride?: string, extraCodexLines: Array<string> = []) {
  const fakeServerPath = path.resolve('tests/fixtures/fake-codex-app-server.mjs').replaceAll('\\', '/')
  const nodePath = process.execPath.replaceAll('\\', '/')
  const command = commandOverride ?? [`"${nodePath}"`, `"${fakeServerPath}"`, mode].filter(Boolean).join(' ')

  return resolveDemoConfig([
    'agent:',
    '  runner: codex',
    'codex:',
    `  command: '${command}'`,
    '  read_timeout_ms: 1000',
    '  turn_timeout_ms: 3000',
    ...extraCodexLines,
    'demo:',
    '  mock_tracker: true',
  ])
}

async function startFakeLinearEndpoint(options: { responseBody?: unknown } = {}): Promise<{
  url: string
  calls: Array<{ authorization: string | null; query: unknown; variables: unknown }>
  close: () => Promise<void>
}> {
  const calls: Array<{ authorization: string | null; query: unknown; variables: unknown }> = []
  const server = createServer(async (request, response) => {
    let body = ''
    request.setEncoding('utf8')
    for await (const chunk of request) {
      body += chunk
    }

    const payload = JSON.parse(body) as { query?: unknown; variables?: unknown }
    calls.push({
      authorization: request.headers.authorization ?? null,
      query: payload.query,
      variables: payload.variables,
    })

    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(options.responseBody ?? { data: { viewer: { id: 'viewer-from-fake-linear' } } }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${address.port}/graphql`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      }),
  }
}

function issueFixture(id: string, identifier: string) {
  return {
    id,
    identifier,
    title: `${identifier} test issue`,
    description: null,
    priority: null,
    state: 'Todo',
    branch_name: null,
    url: null,
    assignee_id: 'worker-1',
    assigned_to_worker: true,
    labels: ['codex'],
    blocked_by: [],
    created_at: null,
    updated_at: null,
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }

  process.env[key] = value
}

async function removeWorkspaceRoot(workspaceRoot: string): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await rm(workspaceRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      })
      return
    } catch (error) {
      lastError = error
      if (!isRetryableRemoveError(error)) {
        throw error
      }
      await delay(250)
    }
  }

  throw lastError
}

function isRetryableRemoveError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY'
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function installFakeSshAppServer(dir: string, traceFile: string): Promise<() => void> {
  const previousPath = process.env.PATH
  const previousSshBin = process.env.SYMPHONY_SSH_BIN
  const previousSshBinArgs = process.env.SYMPHONY_SSH_BIN_ARGS
  const previousTrace = process.env.SYMPHONY_FAKE_SSH_TRACE
  const fakeSshScript = path.join(dir, 'fake-ssh-app-server.mjs')

  await writeFile(
    fakeSshScript,
    [
      "import fs from 'node:fs'",
      "import readline from 'node:readline'",
      "const traceFile = process.env.SYMPHONY_FAKE_SSH_TRACE",
      "fs.appendFileSync(traceFile, `ARGV:${process.argv.slice(2).join(' ')}\\n`, 'utf8')",
      'const rl = readline.createInterface({ input: process.stdin })',
      'function write(message) { process.stdout.write(`${JSON.stringify(message)}\\n`) }',
      "rl.on('line', (line) => {",
      '  const message = JSON.parse(line)',
      "  if (message.method === 'initialize') {",
      "    write({ id: message.id, result: { server: 'fake-ssh' } })",
      "  } else if (message.method === 'thread/start') {",
      "    write({ id: message.id, result: { thread: { id: 'thread-ssh' } } })",
      "  } else if (message.method === 'thread/name/set') {",
      '    write({ id: message.id, result: {} })',
      "  } else if (message.method === 'turn/start') {",
      "    write({ id: message.id, result: { turn: { id: 'turn-ssh' } } })",
      "    write({ method: 'turn/completed', params: { threadId: 'thread-ssh', turn: { id: 'turn-ssh', status: 'completed' } } })",
      '  }',
      '})',
    ].join('\n'),
    'utf8',
  )

  process.env.PATH = previousPath ? `${dir}${path.delimiter}${previousPath}` : dir
  process.env.SYMPHONY_SSH_BIN = process.execPath
  process.env.SYMPHONY_SSH_BIN_ARGS = JSON.stringify([fakeSshScript])
  process.env.SYMPHONY_FAKE_SSH_TRACE = traceFile

  return () => {
    restoreEnv('PATH', previousPath)
    restoreEnv('SYMPHONY_SSH_BIN', previousSshBin)
    restoreEnv('SYMPHONY_SSH_BIN_ARGS', previousSshBinArgs)
    restoreEnv('SYMPHONY_FAKE_SSH_TRACE', previousTrace)
  }
}

const fakeTracker: IssueTracker = {
  async fetchCandidateIssues() {
    return []
  },
  async fetchIssuesByStates() {
    return []
  },
  async fetchIssueStatesByIds() {
    return []
  },
  async createComment() {},
  async updateIssueState() {},
}

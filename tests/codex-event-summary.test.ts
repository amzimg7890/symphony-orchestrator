import { describe, expect, it } from 'vitest'
import {
  summarizeCodexMessage,
  summarizeCodexNotification,
  summarizeCodexRuntimeMessage,
} from '../src/server/symphony/codexEventSummary'

describe('Codex event summaries', () => {
  it('humanizes core thread, turn, plan, diff, and usage notifications', () => {
    expect(summarizeCodexNotification('thread/started', { thread: { id: 'thread-abcdef1234567890' } })).toBe(
      'thread started (thread-abcde)',
    )
    expect(summarizeCodexNotification('turn/started', { turn: { id: 'turn-1234567890' } })).toBe(
      'turn started (turn-1234567)',
    )
    expect(
      summarizeCodexNotification('turn/completed', {
        turn: { id: 'turn-1', status: 'completed' },
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          totalTokens: 1200,
        },
      }),
    ).toBe('turn completed (completed, in 1,000, out 200, total 1,200)')
    expect(
      summarizeCodexNotification('turn/plan/updated', {
        explanation: 'Inspect the workspace\nthen run tests',
      }),
    ).toBe('plan updated: Inspect the workspace then run tests')
    expect(summarizeCodexNotification('turn/diff/updated', { fileChangeCount: 3 })).toBe(
      'diff updated (3 files)',
    )
    expect(
      summarizeCodexNotification('thread/tokenUsage/updated', {
        tokenUsage: { total: { input_tokens: '12', output_tokens: 3 } },
      }),
    ).toBe('token usage updated (in 12, out 3, total 15)')
  })

  it('humanizes streaming, approval, user-input, and tool events', () => {
    expect(
      summarizeCodexNotification('item/agentMessage/delta', {
        delta: 'Working\nthrough the failing test',
      }),
    ).toBe('agent message streaming: Working through the failing test')
    expect(
      summarizeCodexNotification('item/commandExecution/requestApproval', {
        command: 'npm test',
      }),
    ).toBe('command approval requested: npm test')
    expect(
      summarizeCodexNotification('item/fileChange/requestApproval', {
        fileChangeCount: 2,
      }),
    ).toBe('file change approval requested: 2 files')
    expect(
      summarizeCodexNotification('item/tool/requestUserInput', {
        question: 'Which branch should I use?',
      }),
    ).toBe('tool requires user input: Which branch should I use?')
    expect(
      summarizeCodexNotification('item/tool/call', {
        tool: 'linear_graphql',
      }),
    ).toBe('dynamic tool call requested: linear_graphql')
    expect(
      summarizeCodexNotification('turn/needs_input', {
        reason: 'Need operator input from turn notification',
      }),
    ).toBe('turn requires operator input: Need operator input from turn notification')
  })

  it('humanizes Codex wrapper event shapes', () => {
    expect(
      summarizeCodexNotification('codex/event/token_count', {
        msg: {
          payload: {
            info: {
              total_token_usage: {
                input_tokens: 24,
                output_tokens: 6,
                total_tokens: 30,
              },
            },
          },
        },
      }),
    ).toBe('token count update (in 24, out 6, total 30)')
    expect(
      summarizeCodexNotification('codex/event/exec_command_begin', {
        msg: {
          command: ['npm', 'run', 'build'],
        },
      }),
    ).toBe('npm run build')
    expect(
      summarizeCodexNotification('codex/event/exec_command_end', {
        msg: {
          exit_code: 1,
        },
      }),
    ).toBe('command completed (exit 1)')
    expect(
      summarizeCodexNotification('codex/event/mcp_startup_update', {
        msg: {
          server: 'linear',
          status: { state: 'ready' },
        },
      }),
    ).toBe('mcp startup: linear ready')
    expect(
      summarizeCodexNotification('account/rateLimits/updated', {
        rateLimits: {
          primary: { usedPercent: 50, windowDurationMins: 5 },
        },
      }),
    ).toBe('rate limits updated: primary 50% / 5m')
  })

  it('keeps runtime message fallback observability-only and bounded', () => {
    expect(summarizeCodexRuntimeMessage(null, null)).toBe('no codex message yet')
    expect(summarizeCodexRuntimeMessage('turn/started', null)).toBe('turn started')
    expect(summarizeCodexRuntimeMessage('notification', 'hello\\nworld')).toBe('hello world')
    expect(summarizeCodexRuntimeMessage('notification', 'cmd: \x1B[31mRED\x1B[0m after\nline\x07')).toBe(
      'cmd: RED after line',
    )
    expect(summarizeCodexRuntimeMessage('approval_auto_approved', 'acceptForSession')).toBe(
      'approval request auto-approved: acceptForSession',
    )
    expect(
      summarizeCodexRuntimeMessage(
        'tool_input_auto_answered',
        'This is a non-interactive session. Operator input is unavailable.',
      ),
    ).toBe('tool input auto-answered: This is a non-interactive session. Operator input is unavailable.')
    expect(summarizeCodexRuntimeMessage('malformed', 'ignored raw payload')).toBe('malformed JSON event from codex')
    expect(summarizeCodexRuntimeMessage('tool_call_completed', 'linear_graphql')).toBe(
      'dynamic tool call completed (linear_graphql)',
    )
    expect(summarizeCodexRuntimeMessage('tool_call_failed', 'linear_graphql')).toBe(
      'dynamic tool call failed (linear_graphql)',
    )
    expect(
      summarizeCodexRuntimeMessage('tool_call_failed', 'dynamic tool call failed (linear_graphql)'),
    ).toBe('dynamic tool call failed (linear_graphql)')
    expect(
      summarizeCodexRuntimeMessage(
        'tool_input_auto_answered',
        'tool input auto-answered: This is a non-interactive session.',
      ),
    ).toBe('tool input auto-answered: This is a non-interactive session.')
    expect(summarizeCodexRuntimeMessage('unsupported_tool_call', 'unknown_tool')).toBe(
      'unsupported dynamic tool call rejected (unknown_tool)',
    )
    expect(summarizeCodexRuntimeMessage('turn_input_required', null)).toBe(
      'codex turn requires operator input',
    )
  })

  it('unwraps nested Codex runtime message envelopes like the upstream dashboard', () => {
    expect(
      summarizeCodexMessage({
        event: 'notification',
        message: {
          payload: {
            method: 'turn/completed',
            params: {
              usage: {
                input_tokens: 10,
              },
            },
          },
          raw: '{"method":"turn/completed"}',
        },
      }),
    ).toContain('turn completed')
    expect(
      summarizeCodexMessage({
        event: 'notification',
        message: {
          payload: {
            method: 'turn/completed',
            params: {
              usage: {
                input_tokens: 10,
              },
            },
          },
          raw: '{"method":"turn/completed"}',
        },
      }),
    ).toContain('in 10')

    expect(
      summarizeCodexMessage({
        event: 'notification',
        message: {
          method: 'codex/event/exec_command_begin',
          params: { msg: { command: 'git status --short' } },
        },
      }),
    ).toBe('git status --short')
  })

  it('humanizes auto-handled and dynamic-tool runtime envelopes', () => {
    const autoApproved = summarizeCodexMessage({
      event: 'approval_auto_approved',
      message: {
        payload: {
          method: 'item/commandExecution/requestApproval',
          params: { parsedCmd: 'mix test' },
        },
        decision: 'acceptForSession',
      },
    })
    expect(autoApproved).toContain('command approval requested')
    expect(autoApproved).toContain('auto-approved')
    expect(autoApproved).toContain('acceptForSession')

    const autoAnswered = summarizeCodexMessage({
      event: 'tool_input_auto_answered',
      message: {
        payload: {
          method: 'item/tool/requestUserInput',
          params: { question: 'Continue?' },
        },
        answer: 'This is a non-interactive session. Operator input is unavailable.',
      },
    })
    expect(autoAnswered).toContain('tool requires user input')
    expect(autoAnswered).toContain('auto-answered')

    expect(
      summarizeCodexMessage({
        event: 'tool_call_completed',
        message: {
          payload: {
            method: 'item/tool/call',
            params: { tool: 'linear_graphql' },
          },
        },
      }),
    ).toBe('dynamic tool call completed (linear_graphql)')
  })
})

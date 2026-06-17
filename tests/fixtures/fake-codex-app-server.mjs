import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
const approvalMode = process.argv.includes('--approval')
const autoApprovalMode = process.argv.includes('--auto-approval')
const toolApprovalInputMode = process.argv.includes('--tool-approval-input')
const toolInputMode = process.argv.includes('--tool-input')
const mcpElicitationMode = process.argv.includes('--mcp-elicitation')
const turnNeedsInputMode = process.argv.includes('--turn-needs-input')
const malformedProtocolMode = process.argv.includes('--malformed-protocol')
const rejectUnsupportedMode = process.argv.includes('--reject-unsupported')
const unsupportedToolCallMode = process.argv.includes('--unsupported-tool-call')
const linearToolCallMode = process.argv.includes('--linear-tool-call')
const linearToolCallFailureMode = process.argv.includes('--linear-tool-call-failure')
const wrapperTokenCountMode = process.argv.includes('--wrapper-token-count')
const requireThreadNameMode = process.argv.includes('--require-thread-name')
let turnCount = 0
let pendingUnsupportedToolCallId = null
let pendingUnsupportedToolCallTurnId = null
let pendingLinearToolCallId = null
let pendingLinearToolCallTurnId = null
let pendingApprovalRequestId = null
let pendingApprovalTurnId = null
let pendingApprovalDecision = null
let pendingToolInputId = null
let pendingToolInputTurnId = null
let pendingToolInputQuestionId = null
let pendingToolInputAnswer = null
let threadNameSet = false

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

rl.on('line', (line) => {
  const message = JSON.parse(line)

  if (pendingUnsupportedToolCallId !== null && message.id === pendingUnsupportedToolCallId) {
    const output = message.result?.output ?? ''
    if (
      message.result?.success !== false ||
      !String(output).includes('Unsupported dynamic tool') ||
      !Array.isArray(message.result?.contentItems)
    ) {
      process.stderr.write(`unexpected unsupported tool response: ${JSON.stringify(message)}\n`)
      process.exit(2)
      return
    }

    sendTurnCompleted(pendingUnsupportedToolCallTurnId)
    pendingUnsupportedToolCallId = null
    pendingUnsupportedToolCallTurnId = null
    return
  }

  if (pendingLinearToolCallId !== null && message.id === pendingLinearToolCallId) {
    const output = message.result?.output ?? ''
    let payload = null
    try {
      payload = JSON.parse(output)
    } catch {
      // Handled by validation below.
    }

    const expectedSuccess = linearToolCallFailureMode ? false : true
    const expectedPayload = linearToolCallFailureMode
      ? payload?.errors?.[0]?.message === 'fake Linear GraphQL failure'
      : payload?.data?.viewer?.id === 'viewer-from-fake-linear'
    if (message.result?.success !== expectedSuccess || !expectedPayload || !Array.isArray(message.result?.contentItems)) {
      process.stderr.write(`unexpected linear tool response: ${JSON.stringify(message)}\n`)
      process.exit(2)
      return
    }

    sendTurnCompleted(pendingLinearToolCallTurnId)
    pendingLinearToolCallId = null
    pendingLinearToolCallTurnId = null
    return
  }

  if (pendingApprovalRequestId !== null && message.id === pendingApprovalRequestId) {
    if (message.result?.decision !== pendingApprovalDecision) {
      process.stderr.write(`unexpected approval response: ${JSON.stringify(message)}\n`)
      process.exit(2)
      return
    }

    sendTurnCompleted(pendingApprovalTurnId)
    pendingApprovalRequestId = null
    pendingApprovalTurnId = null
    pendingApprovalDecision = null
    return
  }

  if (pendingToolInputId !== null && message.id === pendingToolInputId) {
    const answers = message.result?.answers?.[pendingToolInputQuestionId]?.answers ?? []
    if (!Array.isArray(answers) || answers[0] !== pendingToolInputAnswer) {
      process.stderr.write(`unexpected tool input response: ${JSON.stringify(message)}\n`)
      process.exit(2)
      return
    }

    sendTurnCompleted(pendingToolInputTurnId)
    pendingToolInputId = null
    pendingToolInputTurnId = null
    pendingToolInputQuestionId = null
    pendingToolInputAnswer = null
    return
  }

  if (message.method === 'initialize') {
    send({
      id: message.id,
      result: {
        userAgent: 'fake-codex-app-server',
        platformFamily: 'test',
        platformOs: 'test',
      },
    })
    return
  }

  if (message.method === 'initialized') {
    return
  }

  if (message.method === 'thread/start') {
    if (rejectUnsupportedMode && message.params?.approvalPolicy?.reject) {
      send({
        id: message.id,
        error: {
          code: -32600,
          message: 'Invalid request: unknown variant `reject`, expected one of `granular`',
        },
      })
      return
    }

    send({
      id: message.id,
      result: {
        thread: { id: 'thread-fake' },
      },
    })
    return
  }

  if (message.method === 'thread/name/set') {
    const expectedName = process.env.SYMPHONY_EXPECTED_THREAD_NAME
    if (requireThreadNameMode && message.params?.name !== expectedName) {
      process.stderr.write(`unexpected thread name: ${JSON.stringify(message.params)}\n`)
      process.exit(2)
      return
    }

    threadNameSet = true
    send({
      id: message.id,
      result: {},
    })
    return
  }

  if (message.method === 'turn/start') {
    if (requireThreadNameMode && !threadNameSet) {
      process.stderr.write('turn started before thread/name/set\n')
      process.exit(2)
      return
    }

    if (rejectUnsupportedMode && message.params?.approvalPolicy?.reject) {
      send({
        id: message.id,
        error: {
          code: -32600,
          message: 'Invalid request: unknown variant `reject`, expected one of `granular`',
        },
      })
      return
    }

    turnCount += 1
    const turnId = turnCount === 1 ? 'turn-fake' : `turn-fake-${turnCount}`
    send({
      id: message.id,
      result: {
        turn: {
          id: turnId,
          status: 'inProgress',
          items: [],
        },
      },
    })

    setTimeout(() => {
      if (approvalMode) {
        send({
          id: 'approval-request-1',
          method: 'item/permissions/requestApproval',
          params: {
            cwd: process.cwd(),
            itemId: 'item-1',
            permissions: {},
            reason: 'Need operator approval in fake app-server',
            startedAtMs: Date.now(),
            threadId: 'thread-fake',
            turnId,
          },
        })
        return
      }

      if (autoApprovalMode) {
        sendTurnStarted(turnId)
        pendingApprovalRequestId = 'approval-request-auto-1'
        pendingApprovalTurnId = turnId
        pendingApprovalDecision = 'acceptForSession'
        send({
          id: pendingApprovalRequestId,
          method: 'item/commandExecution/requestApproval',
          params: {
            command: 'gh pr view',
            cwd: process.cwd(),
            reason: 'Need approval in fake app-server',
            threadId: 'thread-fake',
            turnId,
          },
        })
        return
      }

      if (toolApprovalInputMode) {
        sendTurnStarted(turnId)
        pendingToolInputId = 'tool-input-approval-1'
        pendingToolInputTurnId = turnId
        pendingToolInputQuestionId = 'mcp_tool_call_approval_call-717'
        pendingToolInputAnswer = 'Approve this Session'
        send({
          id: pendingToolInputId,
          method: 'item/tool/requestUserInput',
          params: {
            itemId: 'call-717',
            threadId: 'thread-fake',
            turnId,
            questions: [
              {
                header: 'Approve app tool call?',
                id: pendingToolInputQuestionId,
                isOther: false,
                isSecret: false,
                question: 'Allow this action?',
                options: [
                  { label: 'Approve Once', description: 'Run the tool and continue.' },
                  { label: 'Approve this Session', description: 'Run the tool and remember this choice.' },
                  { label: 'Deny', description: 'Decline this tool call.' },
                ],
              },
            ],
          },
        })
        return
      }

      if (toolInputMode) {
        sendTurnStarted(turnId)
        pendingToolInputId = 'tool-input-generic-1'
        pendingToolInputTurnId = turnId
        pendingToolInputQuestionId = 'freeform-718'
        pendingToolInputAnswer = 'This is a non-interactive session. Operator input is unavailable.'
        send({
          id: pendingToolInputId,
          method: 'item/tool/requestUserInput',
          params: {
            itemId: 'call-718',
            threadId: 'thread-fake',
            turnId,
            questions: [
              {
                header: 'Provide context',
                id: pendingToolInputQuestionId,
                isOther: false,
                isSecret: false,
                question: 'What comment should I post back to the issue?',
                options: null,
              },
            ],
          },
        })
        return
      }

      if (mcpElicitationMode) {
        sendTurnStarted(turnId)
        send({
          method: 'mcpServer/elicitation/request',
          params: {
            message: 'Need operator input',
            threadId: 'thread-fake',
            turnId,
          },
        })
        return
      }

      if (turnNeedsInputMode) {
        sendTurnStarted(turnId)
        send({
          method: 'turn/needs_input',
          params: {
            reason: 'Need operator input from turn notification',
            threadId: 'thread-fake',
            turnId,
          },
        })
        return
      }

      if (malformedProtocolMode) {
        sendTurnStarted(turnId)
        process.stdout.write('{"method":"turn/completed"\n')
        sendTurnCompleted(turnId)
        return
      }

      if (unsupportedToolCallMode) {
        sendTurnStarted(turnId)
        pendingUnsupportedToolCallId = 'tool-call-unsupported-1'
        pendingUnsupportedToolCallTurnId = turnId
        send({
          id: pendingUnsupportedToolCallId,
          method: 'item/tool/call',
          params: {
            tool: 'not_a_real_tool',
            callId: 'call-unsupported-1',
            threadId: 'thread-fake',
            turnId,
            arguments: {},
          },
        })
        return
      }

      if (linearToolCallMode || linearToolCallFailureMode) {
        sendTurnStarted(turnId)
        pendingLinearToolCallId = 'tool-call-linear-1'
        pendingLinearToolCallTurnId = turnId
        send({
          id: pendingLinearToolCallId,
          method: 'item/tool/call',
          params: {
            tool: 'linear_graphql',
            callId: 'call-linear-1',
            threadId: 'thread-fake',
            turnId,
            arguments: {
              query: '  query Viewer { viewer { id } }  ',
              variables: { includeTeams: false },
              operationName: 'Viewer',
            },
          },
        })
        return
      }

      sendTurnStarted(turnId)
      if (wrapperTokenCountMode) {
        send({
          method: 'codex/event/token_count',
          params: {
            threadId: 'thread-fake',
            turnId,
            msg: {
              type: 'event_msg',
              payload: {
                type: 'token_count',
                info: {
                  last_token_usage: {
                    input_tokens: 1,
                    output_tokens: 1,
                    total_tokens: 2,
                  },
                  total_token_usage: {
                    input_tokens: '24',
                    output_tokens: 6,
                    total_tokens: 30,
                  },
                },
                rate_limits: {
                  limit_id: 'codex',
                  primary: {
                    remaining: 9,
                    limit: 10,
                  },
                },
              },
            },
          },
        })
      }
      send({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-fake',
          turnId,
          tokenUsage: {
            last: {
              cachedInputTokens: 0,
              inputTokens: 10,
              outputTokens: 5,
              reasoningOutputTokens: 0,
              totalTokens: 15,
            },
            total: {
              cachedInputTokens: 0,
              inputTokens: 10,
              outputTokens: 5,
              reasoningOutputTokens: 0,
              totalTokens: 15,
            },
          },
        },
      })
      send({
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            limitId: 'codex',
            limitName: 'Codex',
            primary: {
              usedPercent: 42,
              windowDurationMins: 300,
              resetsAt: null,
            },
            secondary: null,
            individualLimit: null,
            credits: null,
            planType: null,
            rateLimitReachedType: null,
          },
        },
      })
      send({
        method: 'turn/plan/updated',
        params: {
          threadId: 'thread-fake',
          turnId,
          explanation: 'Fake plan update',
          plan: [
            {
              step: 'Check workspace',
              status: 'completed',
            },
          ],
        },
      })
      send({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-fake',
          turnId,
          delta: 'Fake app-server progress',
        },
      })
      sendTurnCompleted(turnId)
    }, 10)
    return
  }

  send({
    id: message.id,
    error: {
      code: -32601,
      message: `unsupported ${message.method}`,
    },
  })
})

function sendTurnStarted(turnId) {
  send({
    method: 'turn/started',
    params: {
      threadId: 'thread-fake',
      turn: { id: turnId, status: 'inProgress', items: [] },
    },
  })
}

function sendTurnCompleted(turnId) {
  send({
    method: 'turn/completed',
    params: {
      threadId: 'thread-fake',
      turn: { id: turnId, status: 'completed', items: [] },
    },
  })
}

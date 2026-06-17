import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexAppServerRunner } from './codexAppServerRunner'
import { isMutableMemoryTracker } from './memoryTracker'
import { isMutableMockTracker } from './mockTracker'
import type {
  AgentRuntimeEvent,
  EffectiveConfig,
  Issue,
  IssueTracker,
  Workspace,
} from './types'

export type AgentRunInput = {
  issue: Issue
  workspace: Workspace
  worker_host?: string | null
  prompt: string
  turn_number: number
  continuation: boolean
  attempt: number | null
  config: EffectiveConfig
  tracker: IssueTracker
  signal: AbortSignal
  emit: (event: AgentRuntimeEvent) => void
}

export type AgentSessionInput = Omit<AgentRunInput, 'prompt' | 'turn_number' | 'continuation'>

export type AgentSession = {
  run(input: AgentRunInput): Promise<void>
  close(): Promise<void>
}

export type AgentRunner = {
  run(input: AgentRunInput): Promise<void>
  startSession?(input: AgentSessionInput): Promise<AgentSession>
}

export async function openAgentSession(
  runner: AgentRunner,
  input: AgentSessionInput,
): Promise<AgentSession> {
  if (runner.startSession) {
    return runner.startSession(input)
  }

  return {
    run: (turnInput) => runner.run(turnInput),
    async close() {},
  }
}

export class ConfiguredAgentRunner implements AgentRunner {
  private readonly simulated = new SimulatedAgentRunner()
  private readonly codex = new CodexAppServerRunner()

  run(input: AgentRunInput): Promise<void> {
    return input.config.agent.runner === 'codex'
      ? this.codex.run(input)
      : this.simulated.run(input)
  }

  startSession(input: AgentSessionInput): Promise<AgentSession> {
    return input.config.agent.runner === 'codex'
      ? this.codex.startSession(input)
      : this.simulated.startSession(input)
  }
}

export class SimulatedAgentRunner implements AgentRunner {
  async startSession(_input: AgentSessionInput): Promise<AgentSession> {
    const threadId = `thread-${randomUUID()}`
    let started = false

    return {
      run: async (input) => {
        const turnId = `turn-${randomUUID()}`
        const sessionId = `${threadId}-${turnId}`

        if (!started) {
          started = true
          input.emit({
            event: 'session_started',
            timestamp: new Date().toISOString(),
            session_id: threadId,
            thread_id: threadId,
            message: `${input.issue.identifier}: session initialized`,
            usage: {
              input_tokens: Math.max(input.prompt.length / 4, 1),
              output_tokens: 0,
              total_tokens: Math.max(input.prompt.length / 4, 1),
            },
          })
        }

        await delayWithAbort(550, input.signal)
        input.emit({
          event: 'notification',
          timestamp: new Date().toISOString(),
          session_id: sessionId,
          thread_id: threadId,
          turn_id: turnId,
          message: `Prepared workspace ${input.workspace.workspace_key}`,
        })

        if (input.issue.labels.map((label) => label.trim().toLowerCase()).includes('needs-approval')) {
          input.emit({
            event: 'approval_required',
            timestamp: new Date().toISOString(),
            session_id: sessionId,
            thread_id: threadId,
            turn_id: turnId,
            message: 'Operator approval required before modifying protected files',
          })
          return
        }

        await delayWithAbort(850, input.signal)
        input.emit({
          event: 'turn_completed',
          timestamp: new Date().toISOString(),
          session_id: sessionId,
          thread_id: threadId,
          turn_id: turnId,
          message: input.continuation
            ? 'Simulated continuation turn completed'
            : 'Simulated proof of work collected',
          usage: {
            input_tokens: Math.ceil(input.prompt.length / 4) + 420,
            output_tokens: 310,
            total_tokens: Math.ceil(input.prompt.length / 4) + 730,
          },
          rate_limits: {
            model: 'simulated',
            remaining_percent: 100,
          },
        })

        if (isMutableMockTracker(input.tracker) || isMutableMemoryTracker(input.tracker)) {
          input.tracker.transitionIssue(input.issue.id, 'Human Review')
        }
      },
      async close() {},
    }
  }

  async run(input: AgentRunInput): Promise<void> {
    const session = await this.startSession(input)
    try {
      await session.run(input)
    } finally {
      await session.close()
    }
  }
}

async function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal })
}

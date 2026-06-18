import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { stateInList } from '../src/server/symphony/config'
import { SymphonyError } from '../src/server/symphony/errors'
import { isMutableMockTracker } from '../src/server/symphony/mockTracker'
import { SymphonyOrchestrator } from '../src/server/symphony/orchestrator'
import type { AgentRunner } from '../src/server/symphony/runner'
import type { EffectiveConfig, Issue, IssueTracker } from '../src/server/symphony/types'

const blockingRunner: AgentRunner = {
  async run(input) {
    input.emit({
      event: 'approval_required',
      timestamp: new Date().toISOString(),
      session_id: `session-${input.issue.identifier}`,
      thread_id: `thread-${input.issue.identifier}`,
      turn_id: `turn-${input.issue.identifier}`,
      codex_app_server_pid: `pid-${input.issue.identifier}`,
      message: 'approval needed',
    })
  },
}

describe('orchestrator blocked handoffs', () => {
  it('keeps approval-required issues claimed and visible as blocked', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-test-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    await writeFile(
      workflowPath,
      [
        '---',
        'tracker:',
        '  kind: linear',
        '  api_key: demo-token',
        '  project_slug: demo',
        '  required_labels:',
        '    - codex',
        'polling:',
        '  interval_ms: 60000',
        'workspace:',
        '  root: ./workspaces',
        'agent:',
        '  max_concurrent_agents: 3',
        'codex:',
        '  command: codex app-server',
        'logging:',
        '  root: ./logs',
        '  file: symphony.jsonl',
        'demo:',
        '  mock_tracker: true',
        '---',
        'Work on {{ issue.identifier }}.',
      ].join('\n'),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(blockingRunner)
    try {
      await orchestrator.start(workflowPath)
      const snapshot = await waitForBlocked(orchestrator)
      const blocked = snapshot.blocked[0]
      const detail = orchestrator.issueDetail(blocked.issue_identifier)

      expect(snapshot.counts.blocked).toBeGreaterThan(0)
      expect(snapshot.counts.claimed).toBeGreaterThanOrEqual(snapshot.counts.blocked)
      expect(snapshot.counts.retrying).toBe(0)
      expect(blocked.reason).toBe('approval needed')
      expect(blocked.error).toBe('approval needed')
      expect(blocked).toMatchObject({
        session_id: `session-${blocked.issue_identifier}`,
        thread_id: `thread-${blocked.issue_identifier}`,
        turn_id: `turn-${blocked.issue_identifier}`,
        codex_app_server_pid: `pid-${blocked.issue_identifier}`,
        last_event_at: expect.any(String),
      })
      expect(detail?.status).toBe('blocked')
      expect(detail?.blocked?.issue_id).toBe(blocked.issue_id)
      expect(detail?.workspace).toMatchObject({
        path: blocked.workspace_path,
        host: null,
      })
      expect(detail?.attempts).toMatchObject({
        restart_count: 0,
        current_retry_attempt: 0,
      })
      expect(detail?.last_error).toBe('approval needed')
      expect(detail?.logs.codex_session_logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: `session-${blocked.issue_identifier}`,
            path: path.join(dir, 'logs', 'symphony.jsonl'),
            session_id: `session-${blocked.issue_identifier}`,
            thread_id: `thread-${blocked.issue_identifier}`,
            turn_id: `turn-${blocked.issue_identifier}`,
            event_count: expect.any(Number),
            latest_event: expect.any(String),
            url: null,
          }),
        ]),
      )
      expect(detail?.blocked).toMatchObject({
        error: 'approval needed',
        thread_id: `thread-${blocked.issue_identifier}`,
        turn_id: `turn-${blocked.issue_identifier}`,
        codex_app_server_pid: `pid-${blocked.issue_identifier}`,
        last_event_at: blocked.last_event_at,
      })
      expect(detail?.issue).toMatchObject({
        id: blocked.issue_id,
        identifier: blocked.issue_identifier,
        assigned_to_worker: true,
      })
      expect(detail?.issue?.labels).toContain('codex')
      detail?.issue?.labels.push('mutated')
      expect(orchestrator.issueDetail(blocked.issue_identifier)?.issue?.labels).not.toContain('mutated')
      expect(snapshot.config.logging_path).toBe(path.join(dir, 'logs', 'symphony.jsonl'))

      const logBody = await readFile(path.join(dir, 'logs', 'symphony.jsonl'), 'utf8')
      const logEvents = logBody.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
        event: string
        issue_id?: string
        issue_identifier?: string
        session_id?: string
        thread_id?: string
        turn_id?: string
        codex_app_server_pid?: string
      })
      expect(logEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'run_blocked',
            issue_id: blocked.issue_id,
            issue_identifier: blocked.issue_identifier,
            session_id: `session-${blocked.issue_identifier}`,
            thread_id: `thread-${blocked.issue_identifier}`,
            turn_id: `turn-${blocked.issue_identifier}`,
            codex_app_server_pid: `pid-${blocked.issue_identifier}`,
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps runtime seconds when a running issue becomes blocked', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-blocked-runtime-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const runner: AgentRunner = {
      async run(input) {
        await new Promise((resolve) => setTimeout(resolve, 30))
        input.emit({
          event: 'approval_required',
          timestamp: new Date().toISOString(),
          session_id: `session-${input.issue.identifier}`,
          thread_id: `thread-${input.issue.identifier}`,
          turn_id: `turn-${input.issue.identifier}`,
          message: 'approval needed',
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'cleanup',
        maxConcurrentAgents: 1,
        prompt: 'Block after running {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner)
    try {
      await orchestrator.start(workflowPath)
      const snapshot = await waitForBlocked(orchestrator)

      expect(snapshot.counts.running).toBe(0)
      expect(snapshot.counts.blocked).toBe(1)
      expect(snapshot.codex_totals.seconds_running).toBeGreaterThan(0)
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('treats turn input-required events as blocked handoffs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-turn-input-required-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const runner: AgentRunner = {
      async run(input) {
        input.emit({
          event: 'turn_input_required',
          timestamp: new Date().toISOString(),
          session_id: `session-${input.issue.identifier}`,
          thread_id: `thread-${input.issue.identifier}`,
          turn_id: `turn-${input.issue.identifier}`,
          message: 'codex turn requires operator input',
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'cleanup',
        maxConcurrentAgents: 1,
        prompt: 'Block on turn input for {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner)
    try {
      await orchestrator.start(workflowPath)
      const snapshot = await waitForBlocked(orchestrator)

      expect(snapshot.counts.running).toBe(0)
      expect(snapshot.counts.blocked).toBe(1)
      expect(snapshot.blocked[0]).toMatchObject({
        last_event: 'turn_input_required',
        reason: 'codex turn requires operator input',
      })
      expect(snapshot.recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'run_blocked',
            message: 'codex turn requires operator input',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps running and surfaces an event when the structured log sink fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-log-sink-failure-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const badLogRoot = path.join(dir, 'not-a-directory')
    await writeFile(badLogRoot, 'this blocks log directory creation', 'utf8')
    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'automation',
        maxConcurrentAgents: 1,
        prompt: 'Exercise logging failure handling.',
        loggingRoot: badLogRoot,
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(blockingRunner)
    try {
      const snapshot = await orchestrator.start(workflowPath)

      expect(snapshot.service_status).toBe('running')
      expect(snapshot.last_error?.message).toBeTruthy()
      expect(snapshot.recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'structured_log_failed',
            message: expect.any(String),
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('records human-readable dynamic tool runtime messages in event and session logs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-runtime-log-summary-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const logRoot = path.join(dir, 'logs')
    let emitted = false
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'runtime-log-1',
        identifier: 'TOOL-1',
        label: 'runtime-log-summary',
      }),
    ])
    const runner: AgentRunner = {
      async run(input) {
        input.emit({
          event: 'tool_call_failed',
          timestamp: new Date().toISOString(),
          session_id: `session-${input.issue.identifier}`,
          thread_id: `thread-${input.issue.identifier}`,
          turn_id: `turn-${input.issue.identifier}`,
          message: 'linear_graphql',
        })
        emitted = true
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'runtime-log-summary',
        maxConcurrentAgents: 1,
        prompt: 'Exercise runtime log summaries for {{ issue.identifier }}.',
        loggingRoot: logRoot,
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => emitted && orchestrator.snapshot().counts.running === 1)

      const snapshot = orchestrator.snapshot()
      const detail = orchestrator.issueDetail('TOOL-1')
      expect(snapshot.recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'tool_call_failed',
            message: 'dynamic tool call failed (linear_graphql)',
            issue_identifier: 'TOOL-1',
            session_id: 'session-TOOL-1',
            thread_id: 'thread-TOOL-1',
            turn_id: 'turn-TOOL-1',
          }),
        ]),
      )
      expect(detail?.logs.codex_session_logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'session-TOOL-1',
            latest_event: 'tool_call_failed',
            latest_message: 'dynamic tool call failed (linear_graphql)',
            path: path.join(logRoot, 'symphony.jsonl'),
          }),
        ]),
      )

      const logBody = await readFile(path.join(logRoot, 'symphony.jsonl'), 'utf8')
      expect(logBody).toContain('"message":"dynamic tool call failed (linear_graphql)"')
      expect(logBody).not.toContain('"message":"linear_graphql"')
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})

describe('orchestrator workflow reload', () => {
  it('keeps the last good config after invalid reloads and applies later valid prompt/config changes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-reload-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const prompts: Array<{ identifier: string; prompt: string; maxConcurrentAgents: number }> = []
    const runner: AgentRunner = {
      async run(input) {
        prompts.push({
          identifier: input.issue.identifier,
          prompt: input.prompt,
          maxConcurrentAgents: input.config.agent.max_concurrent_agents,
        })
        input.emit({
          event: 'turn_completed',
          timestamp: new Date().toISOString(),
          session_id: `session-${input.issue.identifier}`,
          thread_id: `thread-${input.issue.identifier}`,
          turn_id: `turn-${input.issue.identifier}`,
          message: 'done',
        })
        if (isMutableMockTracker(input.tracker)) {
          input.tracker.transitionIssue(input.issue.id, 'Human Review')
        }
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'automation',
        maxConcurrentAgents: 1,
        prompt: 'Version one {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => prompts.length === 1)
      expect(orchestrator.snapshot().config.tracker_project_slug).toBe('demo')
      expect(prompts[0]).toEqual({
        identifier: 'SYM-101',
        prompt: 'Version one SYM-101.',
        maxConcurrentAgents: 1,
      })

      await writeFile(
        workflowPath,
        workflowFixture({
          label: 'cleanup',
          maxConcurrentAgents: 0,
          prompt: 'Broken {{ issue.identifier }}.',
        }),
        'utf8',
      )
      const invalidSnapshot = await orchestrator.refresh()
      expect(invalidSnapshot.config_errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'invalid_config',
            message: 'agent.max_concurrent_agents must be a positive integer',
          }),
        ]),
      )
      expect(invalidSnapshot.config.max_concurrent_agents).toBe(1)
      expect(invalidSnapshot.recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'workflow_reload_failed',
          }),
        ]),
      )

      await writeFile(
        workflowPath,
        workflowFixture({
          label: 'cleanup',
          maxConcurrentAgents: 2,
          prompt: 'Version two {{ issue.identifier }}.',
        }),
        'utf8',
      )
      await orchestrator.refresh()
      await waitFor(() => prompts.length === 2)

      expect(orchestrator.snapshot().config.max_concurrent_agents).toBe(2)
      expect(orchestrator.snapshot().config_errors).toEqual([])
      expect(prompts[1]).toEqual({
        identifier: 'SYM-102',
        prompt: 'Version two SYM-102.',
        maxConcurrentAgents: 2,
      })
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('replaces the tracker backend when reload changes mock tracker mode', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-tracker-reload-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const mockTracker = new MutableIssueTracker([
      issueFixture({
        id: 'issue-mock',
        identifier: 'MOCK-1',
        label: 'mock-mode',
      }),
    ])
    const linearTracker = new MutableIssueTracker([
      issueFixture({
        id: 'issue-linear',
        identifier: 'LIN-1',
        label: 'linear-mode',
      }),
    ])
    const trackerModes: Array<string> = []
    const prompts: Array<{ identifier: string; mockTracker: boolean }> = []
    const runner: AgentRunner = {
      async run(input) {
        prompts.push({
          identifier: input.issue.identifier,
          mockTracker: input.config.demo.mock_tracker,
        })
        input.emit({
          event: 'turn_completed',
          timestamp: new Date().toISOString(),
          session_id: `session-${input.issue.identifier}`,
          thread_id: `thread-${input.issue.identifier}`,
          turn_id: `turn-${input.issue.identifier}`,
          message: 'done',
        })
        if (input.tracker instanceof MutableIssueTracker) {
          input.tracker.transitionIssue(input.issue.id, 'Human Review')
        }
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'mock-mode',
        maxConcurrentAgents: 1,
        prompt: 'Mock {{ issue.identifier }}.',
        mockTracker: true,
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, (config) => {
      const mode = config.demo.mock_tracker ? 'mock-linear' : 'linear'
      trackerModes.push(mode)
      return config.demo.mock_tracker ? mockTracker : linearTracker
    })

    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => prompts.length === 1)

      await writeFile(
        workflowPath,
        workflowFixture({
          label: 'linear-mode',
          maxConcurrentAgents: 1,
          prompt: 'Linear {{ issue.identifier }}.',
          mockTracker: false,
        }),
        'utf8',
      )
      await orchestrator.refresh()
      await waitFor(() => prompts.length === 2)

      expect(trackerModes).toEqual(['mock-linear', 'linear'])
      expect(prompts).toEqual([
        { identifier: 'MOCK-1', mockTracker: true },
        { identifier: 'LIN-1', mockTracker: false },
      ])
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'tracker_reconfigured',
            message: 'linear',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reschedules the next poll when a runtime reload changes the polling interval', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-poll-reload-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'slow-1',
        identifier: 'POLL-1',
        label: 'slow-poll',
      }),
      issueFixture({
        id: 'fast-1',
        identifier: 'POLL-2',
        label: 'fast-poll',
      }),
    ])
    const prompts: Array<string> = []
    const runner: AgentRunner = {
      async run(input) {
        prompts.push(input.issue.identifier)
        input.emit({
          event: 'turn_completed',
          timestamp: new Date().toISOString(),
          session_id: `session-${input.issue.identifier}`,
          thread_id: `thread-${input.issue.identifier}`,
          turn_id: `turn-${input.issue.identifier}`,
          message: 'done',
        })
        if (input.tracker instanceof MutableIssueTracker) {
          input.tracker.transitionIssue(input.issue.id, 'Human Review')
        }
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'slow-poll',
        maxConcurrentAgents: 1,
        pollIntervalMs: 60_000,
        prompt: 'Slow {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => prompts.length === 1)

      await writeFile(
        workflowPath,
        workflowFixture({
          label: 'fast-poll',
          maxConcurrentAgents: 1,
          pollIntervalMs: 25,
          prompt: 'Fast {{ issue.identifier }}.',
        }),
        'utf8',
      )
      await reloadWorkflowForTest(orchestrator)
      await waitFor(() => prompts.length === 2)

      expect(prompts).toEqual(['POLL-1', 'POLL-2'])
      expect(orchestrator.snapshot().config.poll_interval_ms).toBe(25)
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'polling_rescheduled',
            message: 'interval_ms=25',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('exposes upstream polling countdown and checking status in snapshots', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-poll-snapshot-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'poll-status',
        maxConcurrentAgents: 1,
        pollIntervalMs: 60_000,
        prompt: 'Poll status {{ issue.identifier }}.',
      }),
      'utf8',
    )

    let releaseCandidates = (): void => {}
    let candidateFetchStarted = false
    const fetchGate = new Promise<void>((resolve) => {
      releaseCandidates = resolve
    })

    class BlockingCandidateTracker extends MutableIssueTracker {
      override async fetchCandidateIssues(config: EffectiveConfig): Promise<Array<Issue>> {
        candidateFetchStarted = true
        await fetchGate
        return await super.fetchCandidateIssues(config)
      }
    }

    const tracker = new BlockingCandidateTracker([])
    const orchestrator = new SymphonyOrchestrator(blockingRunner, () => tracker)

    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => candidateFetchStarted)

      expect(orchestrator.snapshot().polling).toEqual({
        'checking?': true,
        next_poll_in_ms: null,
        poll_interval_ms: 60_000,
      })

      releaseCandidates()
      await waitFor(() => !orchestrator.snapshot().polling['checking?'])

      const polling = orchestrator.snapshot().polling
      expect(polling['checking?']).toBe(false)
      expect(polling.poll_interval_ms).toBe(60_000)
      expect(polling.next_poll_in_ms).not.toBeNull()
      expect(polling.next_poll_in_ms).toBeGreaterThan(0)
      expect(polling.next_poll_in_ms).toBeLessThanOrEqual(60_000)
    } finally {
      releaseCandidates()
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('orchestrator candidate selection', () => {
  it('dispatches candidates by priority, creation time, and identifier tie-breaks', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-dispatch-order-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'sort-late-priority-2',
        identifier: 'SORT-3',
        label: 'dispatch-order',
        priority: 2,
        createdAt: '2026-01-03T00:00:00.000Z',
      }),
      issueFixture({
        id: 'sort-null-priority',
        identifier: 'SORT-4',
        label: 'dispatch-order',
        priority: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      issueFixture({
        id: 'sort-priority-1',
        identifier: 'SORT-1',
        label: 'dispatch-order',
        priority: 1,
        createdAt: '2026-01-04T00:00:00.000Z',
      }),
      issueFixture({
        id: 'sort-identifier-b',
        identifier: 'SORT-2',
        label: 'dispatch-order',
        priority: 2,
        createdAt: '2026-01-02T00:00:00.000Z',
      }),
      issueFixture({
        id: 'sort-identifier-a',
        identifier: 'SORT-0',
        label: 'dispatch-order',
        priority: 2,
        createdAt: '2026-01-02T00:00:00.000Z',
      }),
    ])
    const runner: AgentRunner = {
      async run(input) {
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'dispatch-order',
        maxConcurrentAgents: 5,
        prompt: 'Dispatch {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.running === 5)

      const dispatchOrder = orchestrator
        .snapshot()
        .recent_events
        .filter((event) => event.event === 'dispatch_started')
        .reverse()
        .map((event) => event.issue_identifier)

      expect(dispatchOrder).toEqual(['SORT-1', 'SORT-0', 'SORT-2', 'SORT-3', 'SORT-4'])
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('respects per-state concurrency limits while filling other available slots', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-state-slots-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const started: Array<string> = []
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'todo-1',
        identifier: 'SEL-1',
        label: 'state-limit',
        state: 'Todo',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      issueFixture({
        id: 'todo-2',
        identifier: 'SEL-2',
        label: 'state-limit',
        state: 'Todo',
        createdAt: '2026-01-02T00:00:00.000Z',
      }),
      issueFixture({
        id: 'in-progress-1',
        identifier: 'SEL-3',
        label: 'state-limit',
        state: 'In Progress',
        createdAt: '2026-01-03T00:00:00.000Z',
      }),
    ])
    const runner: AgentRunner = {
      async run(input) {
        started.push(input.issue.identifier)
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'state-limit',
        maxConcurrentAgents: 3,
        maxConcurrentAgentsByState: {
          todo: 1,
        },
        prompt: 'Dispatch {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.running === 2 && started.length === 2)

      expect(orchestrator.snapshot().running.map((row) => row.issue_identifier).sort()).toEqual(['SEL-1', 'SEL-3'])
      expect(started.sort()).toEqual(['SEL-1', 'SEL-3'])
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('assigns SSH worker hosts by capacity instead of falling back to local dispatch', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-worker-host-slots-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const started: Array<{ identifier: string; workerHost: string | null }> = []
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'worker-host-1',
        identifier: 'WH-1',
        label: 'worker-hosts',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      issueFixture({
        id: 'worker-host-2',
        identifier: 'WH-2',
        label: 'worker-hosts',
        createdAt: '2026-01-02T00:00:00.000Z',
      }),
      issueFixture({
        id: 'worker-host-3',
        identifier: 'WH-3',
        label: 'worker-hosts',
        createdAt: '2026-01-03T00:00:00.000Z',
      }),
    ])
    const runner: AgentRunner = {
      async run(input) {
        started.push({
          identifier: input.issue.identifier,
          workerHost: input.worker_host ?? null,
        })
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'worker-hosts',
        maxConcurrentAgents: 3,
        workerHosts: ['worker-a', 'worker-b'],
        maxConcurrentAgentsPerHost: 1,
        prompt: 'Dispatch {{ issue.identifier }} to a worker host.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    const restoreSsh = await installFakeSsh(dir, '/remote/workspaces/worker-host-test')
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.running === 2 && started.length === 2)

      expect(started.sort((a, b) => a.identifier.localeCompare(b.identifier))).toEqual([
        { identifier: 'WH-1', workerHost: 'worker-a' },
        { identifier: 'WH-2', workerHost: 'worker-b' },
      ])
      expect(orchestrator.snapshot().counts.claimed).toBe(2)
      expect(orchestrator.snapshot().config).toMatchObject({
        worker_ssh_hosts: ['worker-a', 'worker-b'],
        worker_max_concurrent_agents_per_host: 1,
      })
      expect(orchestrator.snapshot().running.map((row) => row.worker_host).sort()).toEqual([
        'worker-a',
        'worker-b',
      ])
      expect(orchestrator.issueDetail('WH-1')?.workspace).toEqual({
        path: '/remote/workspaces/worker-host-test',
        host: 'worker-a',
      })
      expect(orchestrator.snapshot().recent_events).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            issue_identifier: 'WH-3',
            event: 'dispatch_started',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      restoreSsh()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('skips Todo issues with non-terminal blockers and dispatches unblocked or terminal-blocked candidates', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-blocker-skip-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const started: Array<string> = []
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'blocked-1',
        identifier: 'BLK-1',
        label: 'blockers',
        state: 'Todo',
        createdAt: '2026-01-01T00:00:00.000Z',
        blockedBy: [
          {
            id: 'dependency-1',
            identifier: 'DEP-1',
            state: 'In Progress',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
      issueFixture({
        id: 'open-1',
        identifier: 'BLK-2',
        label: 'blockers',
        state: 'Todo',
        createdAt: '2026-01-02T00:00:00.000Z',
      }),
      issueFixture({
        id: 'terminal-blocked-1',
        identifier: 'BLK-3',
        label: 'blockers',
        state: 'Todo',
        createdAt: '2026-01-03T00:00:00.000Z',
        blockedBy: [
          {
            id: 'dependency-2',
            identifier: 'DEP-2',
            state: 'Done',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-02T00:00:00.000Z',
          },
        ],
      }),
    ])
    const runner: AgentRunner = {
      async run(input) {
        started.push(input.issue.identifier)
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'blockers',
        maxConcurrentAgents: 3,
        prompt: 'Dispatch {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.running === 2 && started.length === 2)
      await orchestrator.refresh()

      expect(orchestrator.snapshot().running.map((row) => row.issue_identifier).sort()).toEqual([
        'BLK-2',
        'BLK-3',
      ])
      expect([...started].sort()).toEqual(['BLK-2', 'BLK-3'])
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not dispatch when required labels include a blank label', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-blank-required-label-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'blank-label-1',
        identifier: 'LBL-1',
        label: 'blank-required',
      }),
    ])
    const runner: AgentRunner = {
      async run() {
        throw new Error('blank required label should prevent dispatch')
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'blank-required',
        requiredLabels: ['blank-required', '   '],
        maxConcurrentAgents: 1,
        prompt: 'Dispatch {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      const snapshot = await orchestrator.start(workflowPath)
      await orchestrator.refresh()

      expect(snapshot.config_errors).toEqual([])
      expect(orchestrator.snapshot().counts.running).toBe(0)
      expect(orchestrator.snapshot().counts.claimed).toBe(0)
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'poll_completed',
            message: '1 candidates checked',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('orchestrator reconciliation release rules', () => {
  it('uses reloaded active states for running issue reconciliation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-active-state-reload-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const workspacePath = path.join(dir, 'workspaces', 'ACT-1')
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'active-reload-1',
        identifier: 'ACT-1',
        label: 'active-reload',
        state: 'In Progress',
      }),
    ])
    const runner: AgentRunner = {
      async run(input) {
        await writeFile(path.join(input.workspace.path, 'sentinel.txt'), 'running before reload', 'utf8')
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'active-reload',
        maxConcurrentAgents: 1,
        activeStates: ['Todo', 'In Progress'],
        prompt: 'Run {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.running === 1)

      await writeFile(
        workflowPath,
        workflowFixture({
          label: 'active-reload',
          maxConcurrentAgents: 1,
          activeStates: ['Todo'],
          prompt: 'Run {{ issue.identifier }}.',
        }),
        'utf8',
      )
      await orchestrator.refresh()

      expect(orchestrator.snapshot().counts.running).toBe(0)
      expect(orchestrator.snapshot().counts.claimed).toBe(0)
      await expect(stat(workspacePath)).resolves.toBeDefined()
      expect(orchestrator.snapshot().config.active_states).toEqual(['Todo'])
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'run_terminated',
            message: 'non-active state',
            issue_identifier: 'ACT-1',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('terminates a running issue and releases its claim when the tracker no longer returns it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-running-missing-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'missing-running-1',
        identifier: 'MISS-1',
        label: 'missing-running',
      }),
    ])
    const runner: AgentRunner = {
      async run(input) {
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'missing-running',
        maxConcurrentAgents: 1,
        prompt: 'Run {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.running === 1)

      tracker.removeIssue('missing-running-1')
      await orchestrator.refresh()

      expect(orchestrator.snapshot().counts.running).toBe(0)
      expect(orchestrator.snapshot().counts.claimed).toBe(0)
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'run_terminated',
            message: 'issue missing',
            issue_identifier: 'MISS-1',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('terminates a running issue when required labels are removed during reconciliation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-running-label-change-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const workspacePath = path.join(dir, 'workspaces', 'LBL-2')
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'running-label-change-1',
        identifier: 'LBL-2',
        label: 'must-stay',
      }),
    ])
    const runner: AgentRunner = {
      async run(input) {
        await writeFile(path.join(input.workspace.path, 'sentinel.txt'), 'running before label change', 'utf8')
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'must-stay',
        maxConcurrentAgents: 1,
        prompt: 'Run while labelled {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.running === 1)

      tracker.setLabels('running-label-change-1', ['codex', 'removed'])
      await orchestrator.refresh()

      expect(orchestrator.snapshot().counts.running).toBe(0)
      expect(orchestrator.snapshot().counts.claimed).toBe(0)
      await expect(stat(workspacePath)).resolves.toBeDefined()
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'run_terminated',
            message: 'required labels changed',
            issue_identifier: 'LBL-2',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('releases a blocked issue claim when the tracker no longer returns it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-blocked-missing-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'missing-blocked-1',
        identifier: 'MISS-2',
        label: 'missing-blocked',
      }),
    ])
    const runner: AgentRunner = {
      async run(input) {
        input.emit({
          event: 'approval_required',
          timestamp: new Date().toISOString(),
          session_id: `session-${input.issue.identifier}`,
          thread_id: `thread-${input.issue.identifier}`,
          turn_id: 'turn-missing-blocked',
          message: 'approval needed',
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'missing-blocked',
        maxConcurrentAgents: 1,
        prompt: 'Block {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.blocked === 1)

      tracker.removeIssue('missing-blocked-1')
      await orchestrator.refresh()

      expect(orchestrator.snapshot().counts.blocked).toBe(0)
      expect(orchestrator.snapshot().counts.claimed).toBe(0)
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'blocked_released',
            message: 'issue missing',
            issue_identifier: 'MISS-2',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('orchestrator startup recovery', () => {
  it('removes workspaces for terminal issues during startup cleanup', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-cleanup-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const terminalWorkspace = path.join(dir, 'workspaces', 'DONE-1')
    await mkdir(terminalWorkspace, { recursive: true })
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'done-1',
        identifier: 'DONE-1',
        label: 'startup-cleanup',
        state: 'Done',
      }),
    ])
    const runner: AgentRunner = {
      async run() {
        throw new Error('terminal startup cleanup should not dispatch a worker')
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'startup-cleanup',
        maxConcurrentAgents: 1,
        prompt: 'Clean {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      await orchestrator.start(workflowPath)

      await expect(stat(terminalWorkspace)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'startup_cleanup_completed',
            message: '1 terminal workspaces checked',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('continues startup and reports an event when terminal cleanup refresh fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-startup-cleanup-failure-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const tracker = new TerminalFetchFailureTracker([])
    const runner: AgentRunner = {
      async run() {
        throw new Error('empty tracker should not dispatch a worker')
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'startup-cleanup-failure',
        maxConcurrentAgents: 1,
        prompt: 'Clean {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      const snapshot = await orchestrator.start(workflowPath)

      expect(snapshot.service_status).toBe('running')
      expect(orchestrator.snapshot().last_error).toMatchObject({
        code: 'linear_api_request',
        message: 'terminal fetch failed',
      })
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'startup_cleanup_failed',
            message: 'terminal fetch failed',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('orchestrator multi-turn sessions', () => {
  it('uses one runner session and continuation guidance for later turns', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-turns-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const turns: Array<{ prompt: string; turnNumber: number; continuation: boolean }> = []
    let sessionsStarted = 0
    let sessionsClosed = 0
    const runner: AgentRunner = {
      async run() {
        throw new Error('expected orchestrator to use startSession')
      },
      async startSession() {
        sessionsStarted += 1
        return {
          async run(input) {
            turns.push({
              prompt: input.prompt,
              turnNumber: input.turn_number,
              continuation: input.continuation,
            })
            input.emit({
              event: 'turn_completed',
              timestamp: new Date().toISOString(),
              session_id: `session-${input.issue.identifier}`,
              thread_id: `thread-${input.issue.identifier}`,
              turn_id: `turn-${input.turn_number}`,
              message: `turn ${input.turn_number} done`,
            })
            if (input.turn_number === 2 && isMutableMockTracker(input.tracker)) {
              input.tracker.transitionIssue(input.issue.id, 'Human Review')
            }
          },
          async close() {
            sessionsClosed += 1
          },
        }
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'cleanup',
        maxConcurrentAgents: 1,
        maxTurns: 2,
        prompt: 'Full prompt for {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => turns.length === 2 && sessionsClosed === 1)

      expect(sessionsStarted).toBe(1)
      expect(sessionsClosed).toBe(1)
      expect(turns[0]).toEqual({
        prompt: 'Full prompt for SYM-102.',
        turnNumber: 1,
        continuation: false,
      })
      expect(turns[1]).toMatchObject({
        turnNumber: 2,
        continuation: true,
      })
      expect(turns[1]?.prompt).toContain('Continue working on Linear issue SYM-102')
      expect(turns[1]?.prompt).not.toContain('Full prompt for SYM-102')
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stops in-session continuation and releases the claim when required labels are removed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-continuation-labels-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'continuation-label-1',
        identifier: 'CONT-1',
        label: 'keep-running',
      }),
    ])
    const turns: Array<number> = []
    let sessionsClosed = 0
    const runner: AgentRunner = {
      async run() {
        throw new Error('expected orchestrator to use startSession')
      },
      async startSession() {
        return {
          async run(input) {
            turns.push(input.turn_number)
            input.emit({
              event: 'turn_completed',
              timestamp: new Date().toISOString(),
              session_id: `session-${input.issue.identifier}`,
              thread_id: `thread-${input.issue.identifier}`,
              turn_id: `turn-${input.turn_number}`,
              message: `turn ${input.turn_number} done`,
            })
            tracker.setLabels(input.issue.id, ['codex', 'removed-from-worker'])
          },
          async close() {
            sessionsClosed += 1
          },
        }
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'keep-running',
        maxConcurrentAgents: 1,
        maxTurns: 3,
        prompt: 'Continue while eligible {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => sessionsClosed === 1)

      expect(turns).toEqual([1])
      expect(orchestrator.snapshot().counts.running).toBe(0)
      expect(orchestrator.snapshot().counts.retrying).toBe(0)
      expect(orchestrator.snapshot().counts.claimed).toBe(0)
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'continuation_stopped',
            message: 'issue no longer eligible',
            issue_identifier: 'CONT-1',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not count active continuation retries as completed issues', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-active-continuation-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const runner: AgentRunner = {
      async run(input) {
        input.emit({
          event: 'turn_completed',
          timestamp: new Date().toISOString(),
          session_id: `session-${input.issue.identifier}`,
          thread_id: `thread-${input.issue.identifier}`,
          turn_id: 'turn-active-continuation',
          message: 'done but still active',
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'cleanup',
        maxConcurrentAgents: 1,
        prompt: 'Continue {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.retrying === 1)

      const detail = orchestrator.issueDetail('SYM-102')
      const expectedWorkspacePath = path.join(dir, 'workspaces', 'SYM-102')
      expect(orchestrator.snapshot().counts.completed).toBe(0)
      expect(detail).toMatchObject({
        issue_identifier: 'SYM-102',
        status: 'retrying',
        workspace: {
          path: expectedWorkspacePath,
          host: null,
        },
        attempts: {
          restart_count: 0,
          current_retry_attempt: 1,
        },
        retry: {
          last_attempt_status: 'Succeeded',
          error: null,
          workspace_path: expectedWorkspacePath,
        },
        last_error: null,
      })
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('clears completed bookkeeping when a released issue becomes eligible again', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-reactivated-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'reactivated-1',
        identifier: 'REACT-1',
        label: 'reactivated',
      }),
    ])
    let runCount = 0
    const runner: AgentRunner = {
      async run(input) {
        runCount += 1
        input.emit({
          event: 'turn_completed',
          timestamp: new Date().toISOString(),
          session_id: `session-${input.issue.identifier}`,
          thread_id: `thread-${input.issue.identifier}`,
          turn_id: `turn-${runCount}`,
          message: 'done',
        })
        if (runCount === 1 && input.tracker instanceof MutableIssueTracker) {
          input.tracker.transitionIssue(input.issue.id, 'Human Review')
          return
        }

        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'reactivated',
        maxConcurrentAgents: 1,
        prompt: 'Run {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.completed === 1)

      tracker.transitionIssue('reactivated-1', 'Todo')
      await orchestrator.refresh()
      await waitFor(() => runCount === 2 && orchestrator.snapshot().counts.running === 1)

      expect(runCount).toBe(2)
      expect(orchestrator.snapshot().counts.completed).toBe(0)
      expect(orchestrator.issueDetail('REACT-1')).toMatchObject({
        issue_identifier: 'REACT-1',
        status: 'running',
      })
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('orchestrator run attempt lifecycle', () => {
  it('queues a typed retry when workflow prompt rendering fails before runner launch', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-template-render-failure-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    let sessionStarts = 0
    let runnerCalls = 0
    const runner: AgentRunner = {
      async startSession() {
        sessionStarts += 1
        return {
          async run() {
            runnerCalls += 1
          },
          async close() {},
        }
      },
      async run() {
        runnerCalls += 1
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'cleanup',
        maxConcurrentAgents: 1,
        prompt: 'Break before launch {{ issue.identifier | missing_filter }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.retrying === 1)

      expect(sessionStarts).toBe(0)
      expect(runnerCalls).toBe(0)
      expect(orchestrator.snapshot().service_status).toBe('running')
      expect(orchestrator.snapshot().last_error).toMatchObject({
        code: 'template_render_error',
        message: 'Issue prompt could not be rendered',
      })
      expect(orchestrator.issueDetail('SYM-102')).toMatchObject({
        issue_identifier: 'SYM-102',
        status: 'retrying',
        retry: {
          last_attempt_status: 'Failed',
          error: 'Issue prompt could not be rendered',
        },
      })
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'worker_failed',
            issue_identifier: 'SYM-102',
            message: 'Issue prompt could not be rendered',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('exposes InitializingSession while the runner session is starting', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-initializing-session-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    let releaseSession = () => {}
    const runner: AgentRunner = {
      async run() {
        throw new Error('expected orchestrator to use startSession')
      },
      startSession(input) {
        return new Promise((resolve) => {
          releaseSession = () => {
            resolve({
              async run() {},
              async close() {},
            })
          }
          input.signal.addEventListener('abort', () => releaseSession(), { once: true })
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'cleanup',
        maxConcurrentAgents: 1,
        maxTurns: 1,
        prompt: 'Initialize {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().running[0]?.status === 'InitializingSession')

      expect(orchestrator.snapshot().running[0]).toMatchObject({
        issue_identifier: 'SYM-102',
        status: 'InitializingSession',
      })
    } finally {
      releaseSession()
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('counts started turns without waiting for turn completion events', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-started-turn-count-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const runner: AgentRunner = {
      async run(input) {
        const event = {
          event: 'turn_started',
          timestamp: new Date().toISOString(),
          session_id: `session-${input.issue.identifier}`,
          thread_id: `thread-${input.issue.identifier}`,
          turn_id: 'turn-started-only',
          codex_app_server_pid: 'pid-started-only',
          message: 'started',
        }
        input.emit(event)
        input.emit(event)
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'cleanup',
        maxConcurrentAgents: 1,
        prompt: 'Count turns for {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().running[0]?.turn_count === 1)

      expect(orchestrator.snapshot().running[0]).toMatchObject({
        issue_identifier: 'SYM-102',
        thread_id: 'thread-SYM-102',
        turn_id: 'turn-started-only',
        codex_app_server_pid: 'pid-started-only',
        turn_count: 1,
        last_event: 'turn_started',
        status: 'StreamingTurn',
      })
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('orchestrator terminal cleanup', () => {
  it('removes the workspace when a running issue reaches a terminal state after a turn', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-terminal-cleanup-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const removedWorkspace = path.join(dir, 'workspaces', 'SYM-102')
    let ran = false
    const runner: AgentRunner = {
      async run(input) {
        ran = true
        await writeFile(path.join(input.workspace.path, 'sentinel.txt'), 'created during run', 'utf8')
        input.emit({
          event: 'turn_completed',
          timestamp: new Date().toISOString(),
          session_id: `session-${input.issue.identifier}`,
          thread_id: `thread-${input.issue.identifier}`,
          turn_id: 'turn-terminal',
          message: 'done',
        })
        if (isMutableMockTracker(input.tracker)) {
          input.tracker.transitionIssue(input.issue.id, 'Done')
        }
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'cleanup',
        maxConcurrentAgents: 1,
        prompt: 'Clean up {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => ran && orchestrator.snapshot().counts.completed === 1)

      await expect(stat(removedWorkspace)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(orchestrator.snapshot().counts.retrying).toBe(0)
      expect(orchestrator.snapshot().counts.claimed).toBe(0)
      expect(orchestrator.issueDetail('SYM-102')).toMatchObject({
        issue_identifier: 'SYM-102',
        status: 'completed',
        issue: {
          identifier: 'SYM-102',
          state: 'Done',
          labels: expect.arrayContaining(['codex', 'cleanup']),
          branch_name: 'codex/sym-102-cleanup',
        },
      })
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'workspace_removed',
            issue_identifier: 'SYM-102',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('removes the workspace when a blocked issue reaches a terminal state during reconciliation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-blocked-terminal-cleanup-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const removedWorkspace = path.join(dir, 'workspaces', 'BT-1')
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'blocked-terminal-1',
        identifier: 'BT-1',
        label: 'blocked-terminal',
      }),
    ])
    const runner: AgentRunner = {
      async run(input) {
        await writeFile(path.join(input.workspace.path, 'sentinel.txt'), 'blocked during run', 'utf8')
        input.emit({
          event: 'approval_required',
          timestamp: new Date().toISOString(),
          session_id: `session-${input.issue.identifier}`,
          thread_id: `thread-${input.issue.identifier}`,
          turn_id: 'turn-blocked-terminal',
          message: 'approval needed',
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'blocked-terminal',
        maxConcurrentAgents: 1,
        prompt: 'Block {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.blocked === 1)
      await expect(stat(removedWorkspace)).resolves.toBeDefined()

      tracker.transitionIssue('blocked-terminal-1', 'Done')
      await orchestrator.refresh()

      expect(orchestrator.snapshot().counts.blocked).toBe(0)
      expect(orchestrator.snapshot().counts.claimed).toBe(0)
      await expect(stat(removedWorkspace)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'blocked_released',
            issue_identifier: 'BT-1',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('logs best-effort hook failures while still completing terminal cleanup', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-hook-failures-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const removedWorkspace = path.join(dir, 'workspaces', 'SYM-102')
    const failingHook = `"${process.execPath.replaceAll('\\', '/')}" -e "process.exit(1)"`
    const runner: AgentRunner = {
      async run(input) {
        input.emit({
          event: 'turn_completed',
          timestamp: new Date().toISOString(),
          session_id: `session-${input.issue.identifier}`,
          thread_id: `thread-${input.issue.identifier}`,
          turn_id: 'turn-hook-failure',
          message: 'done',
        })
        if (isMutableMockTracker(input.tracker)) {
          input.tracker.transitionIssue(input.issue.id, 'Done')
        }
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'cleanup',
        maxConcurrentAgents: 1,
        prompt: 'Fail hooks for {{ issue.identifier }}.',
        hooks: {
          afterRun: failingHook,
          beforeRemove: failingHook,
        },
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.completed === 1)

      await expect(stat(removedWorkspace)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'after_run_hook_failed',
            issue_identifier: 'SYM-102',
          }),
          expect.objectContaining({
            event: 'before_remove_hook_failed',
            issue_identifier: 'SYM-102',
          }),
          expect.objectContaining({
            event: 'workspace_removed',
            issue_identifier: 'SYM-102',
          }),
        ]),
      )
      expect(orchestrator.snapshot().last_error).toMatchObject({
        code: 'hook_error',
      })
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('orchestrator hook lifecycle', () => {
  it('runs after_run after a before_run failure once the workspace exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-before-run-failure-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const workspacePath = path.join(dir, 'workspaces', 'SYM-102')
    const node = process.execPath.replaceAll('\\', '/')
    const failingBeforeRun = `"${node}" -e "process.exit(1)"`
    const afterRunMarker = `"${node}" -e "require('fs').writeFileSync('after-run.txt','ran')"`
    const runner: AgentRunner = {
      async run() {
        throw new Error('before_run failure should abort before launching the runner')
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'cleanup',
        maxConcurrentAgents: 1,
        prompt: 'Fail before run for {{ issue.identifier }}.',
        hooks: {
          beforeRun: failingBeforeRun,
          afterRun: afterRunMarker,
        },
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.retrying === 1)

      await expect(stat(path.join(workspacePath, 'after-run.txt'))).resolves.toBeDefined()
      expect(orchestrator.issueDetail('SYM-102')).toMatchObject({
        issue_identifier: 'SYM-102',
        status: 'retrying',
        retry: {
          last_attempt_status: 'Failed',
        },
      })
      expect(orchestrator.snapshot().last_error).toMatchObject({
        code: 'hook_error',
      })
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'worker_failed',
            issue_identifier: 'SYM-102',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})

describe('orchestrator retry detail', () => {
  it('keeps retry claims queued when only the per-state concurrency slot is unavailable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-retry-state-slot-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'running-todo',
        identifier: 'RS-1',
        label: 'retry-state-slot',
        state: 'Todo',
        priority: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      issueFixture({
        id: 'retry-todo',
        identifier: 'RS-2',
        label: 'retry-state-slot',
        state: 'Todo',
        priority: 2,
        createdAt: '2026-01-02T00:00:00.000Z',
      }),
    ])
    const runCounts = new Map<string, number>()
    const runner: AgentRunner = {
      async run(input) {
        runCounts.set(input.issue.identifier, (runCounts.get(input.issue.identifier) ?? 0) + 1)
        if (input.issue.identifier === 'RS-2') {
          throw new Error('retry later')
        }

        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'retry-state-slot',
        maxConcurrentAgents: 2,
        maxConcurrentAgentsByState: {
          todo: 2,
        },
        maxRetryBackoffMs: 25,
        prompt: 'Run {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.running === 1 && orchestrator.snapshot().counts.retrying === 1)

      await writeFile(
        workflowPath,
        workflowFixture({
          label: 'retry-state-slot',
          maxConcurrentAgents: 2,
          maxConcurrentAgentsByState: {
            todo: 1,
          },
          maxRetryBackoffMs: 25,
          prompt: 'Run {{ issue.identifier }}.',
        }),
        'utf8',
      )
      await waitFor(() => orchestrator.issueDetail('RS-2')?.retry?.attempt === 2)

      expect(runCounts.get('RS-2')).toBe(1)
      expect(orchestrator.issueDetail('RS-2')).toMatchObject({
        issue_identifier: 'RS-2',
        status: 'retrying',
        retry: {
          attempt: 2,
          error: 'no available orchestrator slots',
          last_attempt_status: 'Failed',
        },
      })
      expect(orchestrator.snapshot().counts.claimed).toBe(2)
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reloads workflow config before retry dispatch when file watch events are missed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-retry-reload-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const attempts: Array<string> = []
    const tracker = new MutableIssueTracker([
      issueFixture({
        id: 'retry-reload-1',
        identifier: 'RR-1',
        label: 'retry-before',
      }),
    ])
    const runner: AgentRunner = {
      async run(input) {
        attempts.push(input.issue.identifier)
        throw new Error('retry me')
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'retry-before',
        maxConcurrentAgents: 1,
        maxRetryBackoffMs: 25,
        prompt: 'Retry {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner, () => tracker)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.retrying === 1)

      await writeFile(
        workflowPath,
        workflowFixture({
          label: 'retry-after',
          maxConcurrentAgents: 1,
          maxRetryBackoffMs: 25,
          prompt: 'Retry {{ issue.identifier }}.',
        }),
        'utf8',
      )
      await waitFor(() => orchestrator.snapshot().counts.retrying === 0)

      expect(attempts).toEqual(['RR-1'])
      expect(orchestrator.snapshot().counts.claimed).toBe(0)
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'retry_released',
            message: 'issue no longer eligible',
            issue_identifier: 'RR-1',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the normalized issue snapshot visible while an issue is queued for retry', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-retry-detail-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const runner: AgentRunner = {
      async run() {
        throw new Error('temporary agent failure')
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'cleanup',
        maxConcurrentAgents: 1,
        prompt: 'Retry {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.retrying === 1)

      expect(orchestrator.issueDetail('SYM-102')).toMatchObject({
        issue_identifier: 'SYM-102',
        status: 'retrying',
        attempts: {
          restart_count: 0,
          current_retry_attempt: 1,
        },
        retry: {
          issue_identifier: 'SYM-102',
          last_attempt_status: 'Failed',
          error: 'temporary agent failure',
        },
        last_error: 'temporary agent failure',
        issue: {
          identifier: 'SYM-102',
          title: 'Tighten workspace cleanup around terminal states',
          labels: expect.arrayContaining(['codex', 'cleanup']),
        },
      })
      expect(orchestrator.snapshot().last_error).toMatchObject({
        code: 'agent_error',
        message: 'temporary agent failure',
      })

      const stopped = await orchestrator.stop()
      expect(stopped.counts.retrying).toBe(0)
      expect(stopped.counts.claimed).toBe(0)
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('classifies timeout failures distinctly in retry snapshots', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-timeout-detail-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const runner: AgentRunner = {
      async run() {
        throw new Error('Codex app-server turn timed out')
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'cleanup',
        maxConcurrentAgents: 1,
        prompt: 'Timeout {{ issue.identifier }}.',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => orchestrator.snapshot().counts.retrying === 1)

      expect(orchestrator.issueDetail('SYM-102')?.retry).toMatchObject({
        issue_identifier: 'SYM-102',
        last_attempt_status: 'TimedOut',
        error: 'Codex app-server turn timed out',
      })
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('carries stalled terminal reason into retry snapshots after reconciliation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-stalled-detail-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    let started = false
    const runner: AgentRunner = {
      async run(input) {
        started = true
        input.emit({
          event: 'notification',
          timestamp: new Date().toISOString(),
          session_id: `session-${input.issue.identifier}`,
          thread_id: `thread-${input.issue.identifier}`,
          turn_id: 'turn-stalled',
          message: 'still running',
        })
        await new Promise<void>((resolve) => {
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }

    await writeFile(
      workflowPath,
      workflowFixture({
        label: 'cleanup',
        maxConcurrentAgents: 1,
        prompt: 'Stall {{ issue.identifier }}.',
        stallTimeoutMs: 1,
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner)
    try {
      await orchestrator.start(workflowPath)
      await waitFor(() => started && orchestrator.snapshot().counts.running === 1)
      await new Promise((resolve) => setTimeout(resolve, 5))
      await orchestrator.refresh()
      await waitFor(() => orchestrator.snapshot().counts.retrying === 1)

      expect(orchestrator.issueDetail('SYM-102')?.retry).toMatchObject({
        issue_identifier: 'SYM-102',
        last_attempt_status: 'Stalled',
        error: 'stalled session',
      })
      expect(orchestrator.snapshot().recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'stall_detected',
            issue_identifier: 'SYM-102',
          }),
        ]),
      )
    } finally {
      await orchestrator.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function workflowFixture(args: {
  label: string
  requiredLabels?: Array<string>
  maxConcurrentAgents: number
  maxConcurrentAgentsByState?: Record<string, number>
  maxTurns?: number
  pollIntervalMs?: number
  maxRetryBackoffMs?: number
  activeStates?: Array<string>
  workerHosts?: Array<string>
  maxConcurrentAgentsPerHost?: number
  prompt: string
  mockTracker?: boolean
  stallTimeoutMs?: number
  loggingRoot?: string
  hooks?: {
    beforeRun?: string
    afterRun?: string
    beforeRemove?: string
  }
}): string {
  return [
    '---',
    'tracker:',
    '  kind: linear',
    '  api_key: demo-token',
    '  project_slug: demo',
    '  required_labels:',
    ...(args.requiredLabels ?? [args.label]).map((label) => `    - ${yamlSingleQuoted(label)}`),
    ...(args.activeStates
      ? ['  active_states:', ...args.activeStates.map((state) => `    - ${state}`)]
      : []),
    'polling:',
    `  interval_ms: ${args.pollIntervalMs ?? 60000}`,
    'workspace:',
    '  root: ./workspaces',
    ...(args.workerHosts
      ? [
          'worker:',
          '  ssh_hosts:',
          ...args.workerHosts.map((host) => `    - ${yamlSingleQuoted(host)}`),
          ...(args.maxConcurrentAgentsPerHost === undefined
            ? []
            : [`  max_concurrent_agents_per_host: ${args.maxConcurrentAgentsPerHost}`]),
        ]
      : []),
    ...(args.hooks
      ? [
          'hooks:',
          ...(args.hooks.beforeRun ? [`  before_run: ${yamlSingleQuoted(args.hooks.beforeRun)}`] : []),
          ...(args.hooks.afterRun ? [`  after_run: ${yamlSingleQuoted(args.hooks.afterRun)}`] : []),
          ...(args.hooks.beforeRemove ? [`  before_remove: ${yamlSingleQuoted(args.hooks.beforeRemove)}`] : []),
        ]
      : []),
    'agent:',
    `  max_concurrent_agents: ${args.maxConcurrentAgents}`,
    ...(args.maxConcurrentAgentsByState
      ? [
          '  max_concurrent_agents_by_state:',
          ...Object.entries(args.maxConcurrentAgentsByState).map(([state, limit]) => `    ${state}: ${limit}`),
        ]
      : []),
    `  max_turns: ${args.maxTurns ?? 1}`,
    ...(args.maxRetryBackoffMs === undefined
      ? []
      : [`  max_retry_backoff_ms: ${args.maxRetryBackoffMs}`]),
    'codex:',
    '  command: codex app-server',
    ...(args.stallTimeoutMs === undefined ? [] : [`  stall_timeout_ms: ${args.stallTimeoutMs}`]),
    ...(args.loggingRoot
      ? ['logging:', `  root: ${yamlSingleQuoted(args.loggingRoot)}`, '  file: symphony.jsonl']
      : []),
    'demo:',
    `  mock_tracker: ${args.mockTracker ?? true}`,
    '---',
    args.prompt,
  ].join('\n')
}

async function reloadWorkflowForTest(orchestrator: SymphonyOrchestrator): Promise<void> {
  await (
    orchestrator as unknown as {
      reloadWorkflow(options: { startup: boolean }): Promise<void>
    }
  ).reloadWorkflow({ startup: false })
}

async function installFakeSsh(dir: string, remoteWorkspace: string): Promise<() => void> {
  const previousPath = process.env.PATH
  const previousSshBin = process.env.SYMPHONY_SSH_BIN
  const previousSshBinArgs = process.env.SYMPHONY_SSH_BIN_ARGS
  const previousWorkspace = process.env.SYMPHONY_FAKE_REMOTE_WORKSPACE
  const fakeSshScript = path.join(dir, 'fake-ssh.mjs')

  await writeFile(
    fakeSshScript,
    [
      "const remoteWorkspace = process.env.SYMPHONY_FAKE_REMOTE_WORKSPACE",
      'const command = process.argv.at(-1) ?? ""',
      'if (command.includes("__SYMPHONY_WORKSPACE__")) {',
      '  console.log(`__SYMPHONY_WORKSPACE__\\t1\\t${remoteWorkspace}`)',
      '}',
    ].join('\n'),
    'utf8',
  )

  process.env.PATH = previousPath ? `${dir}${path.delimiter}${previousPath}` : dir
  process.env.SYMPHONY_SSH_BIN = process.execPath
  process.env.SYMPHONY_SSH_BIN_ARGS = JSON.stringify([fakeSshScript])
  process.env.SYMPHONY_FAKE_REMOTE_WORKSPACE = remoteWorkspace

  return () => {
    restoreEnv('PATH', previousPath)
    restoreEnv('SYMPHONY_SSH_BIN', previousSshBin)
    restoreEnv('SYMPHONY_SSH_BIN_ARGS', previousSshBinArgs)
    restoreEnv('SYMPHONY_FAKE_REMOTE_WORKSPACE', previousWorkspace)
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }

  process.env[key] = value
}

function yamlSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

class MutableIssueTracker implements IssueTracker {
  private readonly issues: Map<string, Issue>

  constructor(issues: Array<Issue>) {
    this.issues = new Map(issues.map((issue) => [issue.id, issue]))
  }

  async fetchCandidateIssues(config: EffectiveConfig): Promise<Array<Issue>> {
    return this.allIssues()
      .filter((issue) => stateInList(issue.state, config.tracker.active_states))
      .map(cloneIssue)
  }

  async fetchIssuesByStates(states: Array<string>): Promise<Array<Issue>> {
    return this.allIssues()
      .filter((issue) => stateInList(issue.state, states))
      .map(cloneIssue)
  }

  async fetchIssueStatesByIds(ids: Array<string>): Promise<Array<Issue>> {
    return ids
      .map((id) => this.issues.get(id))
      .filter((issue): issue is Issue => Boolean(issue))
      .map(cloneIssue)
  }

  async createComment(_issueId: string, _body: string): Promise<void> {
    return
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    this.transitionIssue(issueId, stateName)
  }

  transitionIssue(issueId: string, state: string): void {
    const issue = this.issues.get(issueId)
    if (!issue) {
      return
    }
    this.issues.set(issueId, {
      ...issue,
      state,
      updated_at: new Date().toISOString(),
    })
  }

  removeIssue(issueId: string): void {
    this.issues.delete(issueId)
  }

  setLabels(issueId: string, labels: Array<string>): void {
    const issue = this.issues.get(issueId)
    if (!issue) {
      return
    }
    this.issues.set(issueId, {
      ...issue,
      labels,
      updated_at: new Date().toISOString(),
    })
  }

  private allIssues(): Array<Issue> {
    return Array.from(this.issues.values())
  }
}

class TerminalFetchFailureTracker extends MutableIssueTracker {
  async fetchIssuesByStates(): Promise<Array<Issue>> {
    throw new SymphonyError('linear_api_request', 'terminal fetch failed')
  }
}

function issueFixture(args: {
  id: string
  identifier: string
  label: string
  state?: string
  createdAt?: string
  priority?: number | null
  blockedBy?: Issue['blocked_by']
}): Issue {
  return {
    id: args.id,
    identifier: args.identifier,
    title: `${args.identifier} test issue`,
    description: null,
    priority: args.priority === undefined ? 1 : args.priority,
    state: args.state ?? 'Todo',
    branch_name: null,
    url: null,
    assignee_id: 'worker',
    assigned_to_worker: true,
    labels: ['codex', args.label],
    blocked_by: args.blockedBy ?? [],
    created_at: args.createdAt ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function cloneIssue(issue: Issue): Issue {
  return {
    ...issue,
    labels: [...issue.labels],
    blocked_by: issue.blocked_by.map((blocker) => ({ ...blocker })),
  }
}

async function waitForBlocked(orchestrator: SymphonyOrchestrator) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const snapshot = orchestrator.snapshot()
    if (snapshot.counts.blocked > 0) {
      return snapshot
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  return orchestrator.snapshot()
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  expect(predicate()).toBe(true)
}

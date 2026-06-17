import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SymphonyOrchestrator } from '../src/server/symphony/orchestrator'
import type { AgentRunner } from '../src/server/symphony/runner'

describe('Memory tracker orchestration', () => {
  it('dispatches configured memory issues without Linear credentials', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-memory-orchestrator-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    await writeFile(
      workflowPath,
      [
        '---',
        'tracker:',
        '  kind: memory',
        '  required_labels: [codex]',
        '  active_states: [Todo]',
        '  terminal_states: [Done]',
        '  issues:',
        '    - id: issue-memory-1',
        '      identifier: MEM-1',
        '      title: Run memory tracker issue',
        '      state: Todo',
        '      labels: [codex]',
        'polling:',
        '  interval_ms: 60000',
        'workspace:',
        '  root: ./workspaces',
        'agent:',
        '  max_concurrent_agents: 1',
        '  max_turns: 1',
        'logging:',
        '  root: ./logs',
        '---',
        'Memory prompt for {{ issue.identifier }}.',
      ].join('\n'),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator()
    try {
      await orchestrator.start(workflowPath)
      const completed = await waitForSnapshot(orchestrator, (snapshot) => snapshot.counts.completed === 1)
      expect(completed.config.tracker).toBe('memory')
      expect(completed.recent_events.some((event) => event.event === 'worker_completed')).toBe(true)
      expect(orchestrator.issueDetail('MEM-1')).toMatchObject({
        status: 'completed',
        issue: {
          identifier: 'MEM-1',
          state: 'Human Review',
        },
      })
    } finally {
      await orchestrator.stop().catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('applies reloaded configured memory issues to future dispatches', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-memory-reload-'))
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    const dispatched: Array<string> = []
    const runner: AgentRunner = {
      async run(input) {
        dispatched.push(input.issue.identifier)
        input.emit({
          event: 'turn_completed',
          timestamp: new Date().toISOString(),
          session_id: `session-${input.issue.identifier}`,
          thread_id: `thread-${input.issue.identifier}`,
          turn_id: `turn-${input.issue.identifier}`,
          message: 'done',
        })
        await input.tracker.updateIssueState(input.issue.id, 'Human Review', input.config)
      },
    }

    await writeFile(
      workflowPath,
      memoryWorkflow({
        id: 'issue-memory-before',
        identifier: 'MEM-1',
        title: 'Run original memory tracker issue',
      }),
      'utf8',
    )

    const orchestrator = new SymphonyOrchestrator(runner)
    try {
      await orchestrator.start(workflowPath)
      await waitForSnapshot(orchestrator, () => dispatched.includes('MEM-1'))

      await writeFile(
        workflowPath,
        memoryWorkflow({
          id: 'issue-memory-after',
          identifier: 'MEM-2',
          title: 'Run reloaded memory tracker issue',
        }),
        'utf8',
      )
      await orchestrator.refresh()
      const completed = await waitForSnapshot(
        orchestrator,
        (snapshot) => snapshot.counts.completed === 2 && dispatched.includes('MEM-2'),
      )

      expect(dispatched).toEqual(['MEM-1', 'MEM-2'])
      expect(completed.recent_events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'tracker_reconfigured',
            message: 'memory',
          }),
        ]),
      )
      expect(orchestrator.issueDetail('MEM-2')).toMatchObject({
        status: 'completed',
        issue: {
          identifier: 'MEM-2',
          state: 'Human Review',
        },
      })
    } finally {
      await orchestrator.stop().catch(() => {})
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function memoryWorkflow(issue: { id: string; identifier: string; title: string }): string {
  return [
    '---',
    'tracker:',
    '  kind: memory',
    '  required_labels: [codex]',
    '  active_states: [Todo]',
    '  terminal_states: [Done]',
    '  issues:',
    `    - id: ${issue.id}`,
    `      identifier: ${issue.identifier}`,
    `      title: ${issue.title}`,
    '      state: Todo',
    '      labels: [codex]',
    'polling:',
    '  interval_ms: 60000',
    'workspace:',
    '  root: ./workspaces',
    'agent:',
    '  max_concurrent_agents: 1',
    '  max_turns: 1',
    'logging:',
    '  root: ./logs',
    '---',
    'Memory prompt for {{ issue.identifier }}.',
  ].join('\n')
}

async function waitForSnapshot(
  orchestrator: SymphonyOrchestrator,
  predicate: (snapshot: ReturnType<SymphonyOrchestrator['snapshot']>) => boolean,
): Promise<ReturnType<SymphonyOrchestrator['snapshot']>> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const snapshot = orchestrator.snapshot()
    if (predicate(snapshot)) {
      return snapshot
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for memory orchestrator snapshot: ${JSON.stringify(orchestrator.snapshot())}`)
}

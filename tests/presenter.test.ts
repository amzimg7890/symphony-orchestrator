import { describe, expect, it } from 'vitest'
import { presentIssueDetailSnapshot, presentRuntimeSnapshot } from '../src/server/symphony/presenter'
import type { RuntimeSnapshot } from '../src/server/symphony/types'

describe('Symphony presenter projections', () => {
  it('detaches nested runtime snapshot presenter state', () => {
    const snapshot = runtimeSnapshotFixture()
    const presented = presentRuntimeSnapshot(snapshot)

    const presentedRateLimits = presented.rate_limits as {
      primary: { windows: Array<{ remaining: number }> }
    }
    presentedRateLimits.primary.windows[0]!.remaining = 0
    presented.config_errors[0]!.details!.nested = { value: 'mutated' }
    presented.last_error!.details!.nested = { value: 'mutated' }
    presented.config.worker_ssh_hosts.push('dm-dev2')
    presented.codex_totals.total_tokens = 999

    const sourceRateLimits = snapshot.rate_limits as {
      primary: { windows: Array<{ remaining: number }> }
    }
    expect(sourceRateLimits.primary.windows[0]!.remaining).toBe(11)
    expect(snapshot.config_errors[0]!.details!.nested).toEqual({ value: 'config' })
    expect(snapshot.last_error!.details!.nested).toEqual({ value: 'last' })
    expect(snapshot.config.worker_ssh_hosts).toEqual(['dm-dev1'])
    expect(snapshot.codex_totals.total_tokens).toBe(3)
  })

  it('detaches issue detail state while projecting current recent events', () => {
    const detail = {
      issue_identifier: 'SYM-1',
      issue_id: 'issue-1',
      status: 'running',
      issue: {
        labels: ['codex'],
        metadata: {
          nested: { value: 'source' },
        },
      },
      workspace: {
        path: 'C:/workspaces/SYM-1',
        host: null,
      },
      attempts: {
        restart_count: 0,
        current_retry_attempt: 0,
      },
      running: {
        issue_id: 'issue-1',
        issue_identifier: 'SYM-1',
        issue_url: null,
        state: 'In Progress',
        session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        codex_app_server_pid: '1234',
        turn_count: 1,
        last_event: 'tool_call_failed',
        last_message: 'linear_graphql',
        started_at: new Date(0).toISOString(),
        last_event_at: new Date(30_000).toISOString(),
        workspace_path: 'C:/workspaces/SYM-1',
        worker_host: null,
        status: 'StreamingTurn',
        tokens: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
        },
      },
      retry: null,
      blocked: null,
      logs: {
        codex_session_logs: [
          {
            label: 'session',
            path: 'C:/logs/session.jsonl',
            exists: true,
            size_bytes: 42,
            updated_at: new Date(10_000).toISOString(),
          },
        ],
      },
      recent_events: [
        {
          at: new Date(10_000).toISOString(),
          event: 'stale_internal_event',
          message: 'stale internal history',
        },
      ],
      last_error: null,
      tracked: {
        labels: ['codex'],
      },
    }

    const presented = presentIssueDetailSnapshot(detail) as {
      issue: { labels: Array<string>; metadata: { nested: { value: string } } }
      logs: { codex_session_logs: Array<{ label: string }> }
      recent_events: Array<{ at: string; event: string | null; message: string | null }>
      running: { last_message: string | null }
      tracked: { labels: Array<string> }
    }

    expect(presented.running.last_message).toBe('dynamic tool call failed (linear_graphql)')
    expect(presented.recent_events).toEqual([
      {
        at: new Date(30_000).toISOString(),
        event: 'tool_call_failed',
        message: 'dynamic tool call failed (linear_graphql)',
      },
    ])

    presented.issue.labels.push('mutated')
    presented.issue.metadata.nested.value = 'mutated'
    presented.logs.codex_session_logs[0]!.label = 'mutated'
    presented.tracked.labels.push('mutated')

    expect(detail.issue.labels).toEqual(['codex'])
    expect(detail.issue.metadata.nested.value).toBe('source')
    expect(detail.logs.codex_session_logs[0]!.label).toBe('session')
    expect(detail.tracked.labels).toEqual(['codex'])
  })
})

function runtimeSnapshotFixture(): RuntimeSnapshot {
  return {
    generated_at: new Date(0).toISOString(),
    service_status: 'running',
    workflow_path: 'C:/repo/WORKFLOW.md',
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
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
      seconds_running: 4,
    },
    rate_limits: {
      primary: {
        windows: [
          {
            remaining: 11,
            limit: 100,
          },
        ],
      },
    },
    polling: {
      'checking?': false,
      next_poll_in_ms: null,
      poll_interval_ms: null,
    },
    recent_events: [],
    config_errors: [
      {
        code: 'invalid_config',
        message: 'bad config',
        details: {
          nested: { value: 'config' },
        },
      },
    ],
    last_error: {
      code: 'linear_api_request',
      message: 'Linear offline',
      details: {
        nested: { value: 'last' },
      },
    },
    config: {
      poll_interval_ms: null,
      max_concurrent_agents: null,
      workspace_root: 'C:/repo/workspaces',
      worker_ssh_hosts: ['dm-dev1'],
      worker_max_concurrent_agents_per_host: null,
      active_states: ['Todo'],
      terminal_states: ['Done'],
      runner: 'codex',
      tracker: 'linear',
      server_port: null,
      server_host: null,
      observability_dashboard_enabled: true,
      observability_refresh_ms: 5000,
      observability_render_interval_ms: 1000,
      logging_path: 'C:/repo/logs/symphony.jsonl',
    },
  }
}

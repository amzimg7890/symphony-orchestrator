import { createFileRoute } from '@tanstack/react-router'
import {
  Activity,
  AlertTriangle,
  CircleStop,
  Clock3,
  Folder,
  GitBranch,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
  TimerReset,
  Zap,
} from 'lucide-react'
import * as React from 'react'
import { safeHttpUrl } from '~/lib/safeUrl'
import { summarizeCodexRuntimeMessage } from '~/server/symphony/codexEventSummary'
import type { RuntimeSnapshot } from '~/server/symphony/types'

export const Route = createFileRoute('/')({
  component: Dashboard,
})

function Dashboard() {
  const [snapshot, setSnapshot] = React.useState<RuntimeSnapshot | null>(null)
  const [busyAction, setBusyAction] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const dashboardEnabled = snapshot?.config.observability_dashboard_enabled ?? true
  const refreshMs = snapshot?.config.observability_refresh_ms ?? 1000

  const loadState = React.useCallback(async () => {
    const response = await fetch('/api/v1/state')
    const body = await response.json()
    if (!response.ok) {
      throw new Error(body.error?.message ?? 'Unable to load state')
    }
    setSnapshot(body)
  }, [])

  React.useEffect(() => {
    void loadState().catch((err: unknown) => setError(readError(err)))
  }, [loadState])

  React.useEffect(() => {
    if (!dashboardEnabled) {
      return
    }

    const source = 'EventSource' in window ? new EventSource('/api/v1/events') : null
    if (source) {
      source.addEventListener('snapshot', (event) => {
        try {
          setSnapshot(JSON.parse(event.data) as RuntimeSnapshot)
          setError(null)
        } catch (err) {
          setError(readError(err))
        }
      })
      source.addEventListener('error', () => {
        source.close()
      })
    }

    const id = window.setInterval(() => {
      void loadState().catch((err: unknown) => setError(readError(err)))
    }, refreshMs)
    return () => {
      source?.close()
      window.clearInterval(id)
    }
  }, [dashboardEnabled, loadState, refreshMs])

  const runAction = React.useCallback(
    async (action: 'start' | 'stop' | 'refresh') => {
      setBusyAction(action)
      setError(null)
      try {
        const response = await fetch(
          action === 'refresh' ? '/api/v1/refresh' : '/api/v1/control',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: action === 'refresh' ? '{}' : JSON.stringify({ action }),
          },
        )
        const body = await response.json()
        if (!response.ok) {
          throw new Error(body.error?.message ?? `${action} failed`)
        }
        setSnapshot(body.snapshot ?? body)
      } catch (err) {
        setError(readError(err))
      } finally {
        setBusyAction(null)
      }
    },
    [],
  )

  const status = snapshot?.service_status ?? 'idle'
  const isRunning = status === 'running'
  const runtimeProblems = runtimeProblemsFromSnapshot(snapshot)

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">S</div>
          <div>
            <p className="eyebrow">Symphony Observability</p>
            <h1>Operations Dashboard</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <StatusPill status={status} />
          <button
            className="icon-button"
            type="button"
            title="Refresh"
            aria-label="Refresh"
            onClick={() => void runAction('refresh')}
            disabled={busyAction !== null || !isRunning}
          >
            {busyAction === 'refresh' ? <Loader2 className="spin" /> : <RefreshCw />}
          </button>
          <button
            className="control-button"
            type="button"
            onClick={() => void runAction(isRunning ? 'stop' : 'start')}
            disabled={busyAction !== null}
          >
            {isRunning ? <CircleStop /> : <Play />}
            <span>{isRunning ? 'Stop' : 'Start'}</span>
          </button>
        </div>
      </header>

      {error ? (
        <section className="alert-band">
          <AlertTriangle />
          <span>{error}</span>
        </section>
      ) : null}

      {runtimeProblems.length ? (
        <section className="alert-band runtime-problems" aria-label="Runtime problems">
          <AlertTriangle />
          <div>
            {runtimeProblems.map((problem) => (
              <p key={`${problem.code}-${problem.message}`}>
                <strong>{problem.code}</strong>
                <span>{problem.message}</span>
              </p>
            ))}
          </div>
        </section>
      ) : null}

      <section className="metric-grid" aria-label="Runtime summary">
        <Metric icon={<Activity />} label="Running" value={snapshot?.counts.running ?? 0} />
        <Metric icon={<TimerReset />} label="Retrying" value={snapshot?.counts.retrying ?? 0} />
        <Metric icon={<ShieldAlert />} label="Blocked" value={snapshot?.counts.blocked ?? 0} />
        <Metric icon={<Zap />} label="Tokens" value={snapshot?.codex_totals.total_tokens ?? 0} />
        <Metric
          icon={<Clock3 />}
          label="Runtime"
          value={`${Math.round(snapshot?.codex_totals.seconds_running ?? 0)}s`}
        />
        <Metric
          icon={<RefreshCw />}
          label="Next refresh"
          value={formatPolling(snapshot?.polling ?? null)}
        />
      </section>

      <section className="surface rate-limit-panel">
        <div className="panel-header compact">
          <div>
            <p className="eyebrow">Runtime</p>
            <h2>Rate limits</h2>
          </div>
        </div>
        <pre className="code-panel">{prettyValue(snapshot?.rate_limits ?? null)}</pre>
      </section>

      <section className="workspace-band">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Live Sessions</p>
            <h2>Running sessions</h2>
          </div>
          <code>{snapshot?.config.workspace_root ?? 'workspace root unavailable'}</code>
        </div>
        <div className="session-grid">
          {snapshot?.running.length ? (
            snapshot.running.map((row) => <RunningCard key={row.issue_id} row={row} />)
          ) : (
            <EmptyState label="No active sessions." />
          )}
        </div>
      </section>

      <section className="split-grid">
        <div className="surface">
          <div className="panel-header compact">
            <div>
              <p className="eyebrow">Handoff</p>
              <h2>Blocked sessions</h2>
            </div>
          </div>
          <div className="list-stack">
            {snapshot?.blocked.length ? (
              snapshot.blocked.map((row) => (
                <div className="queue-row blocked-row" key={row.issue_id}>
                  <div>
                    <IssueLink identifier={row.issue_identifier} url={row.issue_url} />
                    <DetailLink identifier={row.issue_identifier} />
                    <small>{sessionMeta(row)}</small>
                    <span>{row.reason}</span>
                    <span className="queue-row-detail">{blockedActivity(row)}</span>
                  </div>
                  <time>{new Date(row.blocked_at).toLocaleTimeString()}</time>
                </div>
              ))
            ) : (
              <EmptyState label="No blocked sessions." />
            )}
          </div>
        </div>

        <div className="surface">
          <div className="panel-header compact">
            <div>
              <p className="eyebrow">Queue</p>
              <h2>Retry queue</h2>
            </div>
          </div>
          <div className="list-stack">
            {snapshot?.retrying.length ? (
              snapshot.retrying.map((row) => (
                <div className="queue-row" key={row.issue_id}>
                  <div>
                    <IssueLink identifier={row.issue_identifier} url={row.issue_url} />
                    <DetailLink identifier={row.issue_identifier} />
                    <small>{row.last_attempt_status}</small>
                    <span>{[row.worker_host ?? 'local', row.error ?? 'continuation'].join(' / ')}</span>
                  </div>
                  <time>{new Date(row.due_at).toLocaleTimeString()}</time>
                </div>
              ))
            ) : (
              <EmptyState label="No issues are currently backing off." />
            )}
          </div>
        </div>

        <div className="surface">
          <div className="panel-header compact">
            <div>
              <p className="eyebrow">Events</p>
              <h2>Runtime Log</h2>
            </div>
          </div>
          <div className="event-log">
            {snapshot?.recent_events.length ? (
              snapshot.recent_events.slice(0, 10).map((event, index) => (
                <div
                  className="event-row"
                  key={`${event.at}-${event.event}-${event.issue_identifier ?? 'system'}-${index}`}
                >
                  <time>{new Date(event.at).toLocaleTimeString()}</time>
                  <strong>{event.event}</strong>
                  <span>{event.issue_identifier ? `${event.issue_identifier} ` : ''}{event.message}</span>
                </div>
              ))
            ) : (
              <EmptyState label="No events yet" />
            )}
          </div>
        </div>
      </section>
    </main>
  )
}

function StatusPill({ status }: { status: RuntimeSnapshot['service_status'] | 'idle' }) {
  return <span className={`status-pill status-${status}`}>{status}</span>
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="metric">
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function RunningCard({ row }: { row: RuntimeSnapshot['running'][number] }) {
  const lastUpdate = runtimeMessage(row.last_event, row.last_message)

  return (
    <article className="session-card">
      <div className="session-card-header">
        <div>
          <IssueLink identifier={row.issue_identifier} url={row.issue_url} />
          <DetailLink identifier={row.issue_identifier} />
          <span>{row.state}</span>
        </div>
        <StatusPill status={row.status === 'Succeeded' ? 'running' : 'starting'} />
      </div>
      <h3>{lastUpdate}</h3>
      <dl>
        <div>
          <dt>Worker</dt>
          <dd>{row.worker_host ?? 'local'}</dd>
        </div>
        <div>
          <dt><GitBranch /> Session</dt>
          <dd>{row.session_id ?? 'pending'}</dd>
        </div>
        <div>
          <dt>Thread</dt>
          <dd>{row.thread_id ?? 'pending'}</dd>
        </div>
        <div>
          <dt>Turn</dt>
          <dd>{row.turn_id ?? 'pending'}</dd>
        </div>
        <div>
          <dt>PID</dt>
          <dd>{row.codex_app_server_pid ?? 'pending'}</dd>
        </div>
        <div>
          <dt><Folder /> Workspace</dt>
          <dd>{row.workspace_path ?? 'preparing'}</dd>
        </div>
        <div>
          <dt><Zap /> Tokens</dt>
          <dd>{row.tokens.total_tokens}</dd>
        </div>
      </dl>
    </article>
  )
}

function sessionMeta(
  row: Pick<RuntimeSnapshot['blocked'][number], 'worker_host' | 'thread_id' | 'turn_id' | 'codex_app_server_pid'>,
) {
  const parts = [
    row.worker_host ? `worker ${row.worker_host}` : 'local',
    row.thread_id ? `thread ${row.thread_id}` : null,
    row.turn_id ? `turn ${row.turn_id}` : null,
    row.codex_app_server_pid ? `pid ${row.codex_app_server_pid}` : null,
  ].filter(Boolean)

  return parts.length ? parts.join(' / ') : 'session pending'
}

function blockedActivity(
  row: Pick<RuntimeSnapshot['blocked'][number], 'last_event' | 'last_message' | 'last_event_at'>,
): string {
  const update = runtimeMessage(row.last_event, row.last_message)
  if (!row.last_event_at) {
    return update
  }

  return `${update} / ${new Date(row.last_event_at).toLocaleTimeString()}`
}

function runtimeMessage(event: string | null, message: string | null): string {
  return message ?? summarizeCodexRuntimeMessage(event, null)
}

function IssueLink({
  identifier,
  url,
}: {
  identifier: string
  url: string | null
}) {
  const href = safeHttpUrl(url)
  if (!href) {
    return <strong>{identifier}</strong>
  }

  return (
    <a className="issue-link" href={href} target="_blank" rel="noopener noreferrer">
      {identifier}
    </a>
  )
}

function DetailLink({ identifier }: { identifier: string }) {
  return (
    <a className="detail-link" href={`/api/v1/${encodeURIComponent(identifier)}`}>
      JSON details
    </a>
  )
}

function EmptyState({ label }: { label: string }) {
  return <div className="empty-state">{label}</div>
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function prettyValue(value: unknown): string {
  return value == null ? 'n/a' : JSON.stringify(value, null, 2)
}

function formatPolling(polling: RuntimeSnapshot['polling'] | null): string {
  if (!polling) {
    return 'n/a'
  }

  if (polling['checking?']) {
    return 'checking now'
  }

  if (typeof polling.next_poll_in_ms === 'number') {
    return `${Math.ceil(Math.max(0, polling.next_poll_in_ms) / 1000)}s`
  }

  return 'n/a'
}

function runtimeProblemsFromSnapshot(snapshot: RuntimeSnapshot | null): RuntimeSnapshot['config_errors'] {
  if (!snapshot) {
    return []
  }

  const problems = [...snapshot.config_errors]
  if (
    snapshot.last_error &&
    !problems.some(
      (problem) =>
        problem.code === snapshot.last_error?.code &&
        problem.message === snapshot.last_error.message,
    )
  ) {
    problems.push(snapshot.last_error)
  }

  return problems
}

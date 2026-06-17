import { safeHttpUrl } from '../../lib/safeUrl'
import { summarizeCodexRuntimeMessage } from './codexEventSummary'
import type { RuntimeSnapshot } from './types'

export function dashboardBody(snapshot: RuntimeSnapshot): string {
  return [
    '<main class="app-shell">',
    '<section class="dashboard-shell" data-phx-main>',
    heroSection(snapshot),
    metricGrid(snapshot),
    rateLimitsSection(snapshot.rate_limits),
    runningSection(snapshot),
    blockedSection(snapshot),
    retrySection(snapshot),
    '</section>',
    '</main>',
  ].join('')
}

function heroSection(snapshot: RuntimeSnapshot): string {
  const live = snapshot.service_status === 'running'
  return [
    '<header class="hero-card">',
    '<div class="hero-grid">',
    '<div>',
    '<p class="eyebrow">Symphony Observability</p>',
    '<h1 class="hero-title">Operations Dashboard</h1>',
    '<p class="hero-copy">Current state, retry pressure, token usage, and orchestration health for the active Symphony runtime.</p>',
    '</div>',
    '<div class="status-stack">',
    `<span class="status-badge ${live ? 'status-badge-live' : 'status-badge-offline'}">`,
    '<span class="status-badge-dot"></span>',
    escapeHtml(live ? 'Live' : snapshot.service_status),
    '</span>',
    '</div>',
    '</div>',
    '</header>',
  ].join('')
}

function metricGrid(snapshot: RuntimeSnapshot): string {
  const totals = snapshot.codex_totals
  return [
    '<section class="metric-grid" aria-label="Runtime summary">',
    metricCard('Running', snapshot.counts.running, 'Active issue sessions in the current runtime.'),
    metricCard('Retrying', snapshot.counts.retrying, 'Issues waiting for the next retry window.'),
    metricCard('Blocked', snapshot.counts.blocked, 'Issues paused for operator input or approval.'),
    metricCard('Total tokens', formatInt(totals.total_tokens), `In ${formatInt(totals.input_tokens)} / Out ${formatInt(totals.output_tokens)}`),
    metricCard('Runtime', formatRuntimeSeconds(totals.seconds_running), 'Total Codex runtime across completed and active sessions.'),
    metricCard('Next refresh', formatPolling(snapshot.polling), 'Current orchestrator polling state.'),
    '</section>',
  ].join('')
}

function metricCard(label: string, value: string | number, detail: string): string {
  return [
    '<article class="metric-card">',
    `<p class="metric-label">${escapeHtml(label)}</p>`,
    `<p class="metric-value numeric">${escapeHtml(String(value))}</p>`,
    `<p class="metric-detail">${escapeHtml(detail)}</p>`,
    '</article>',
  ].join('')
}

function rateLimitsSection(rateLimits: unknown): string {
  return [
    '<section class="section-card">',
    sectionHeader('Rate limits', 'Latest upstream rate-limit snapshot, when available.'),
    `<pre class="code-panel">${escapeHtml(prettyValue(rateLimits))}</pre>`,
    '</section>',
  ].join('')
}

function runningSection(snapshot: RuntimeSnapshot): string {
  const rows = snapshot.running
    .map((row) => {
      const lastUpdate = summarizeCodexRuntimeMessage(row.last_event, row.last_message)
      return [
        '<tr>',
        '<td>',
        '<div class="issue-stack">',
        issueIdentifier(row.issue_identifier, row.issue_url),
        `<a class="issue-link" href="/api/v1/${encodeURIComponent(row.issue_identifier)}">JSON details</a>`,
        '</div>',
        '</td>',
        `<td><span class="${stateBadgeClass(row.state)}">${escapeHtml(row.state)}</span></td>`,
        '<td>',
        row.session_id
          ? `<button type="button" class="subtle-button" data-copy="${escapeHtml(row.session_id)}">Copy ID</button>`
          : '<span class="muted">n/a</span>',
        '</td>',
        `<td class="numeric">${escapeHtml(formatRuntimeAndTurns(row.started_at, row.turn_count, snapshot.generated_at))}</td>`,
        '<td>',
        '<div class="detail-stack">',
        `<span class="event-text" title="${escapeHtml(lastUpdate)}">${escapeHtml(lastUpdate)}</span>`,
        `<span class="muted event-meta">${escapeHtml(row.last_event || 'n/a')}${row.last_event_at ? ` <span class="mono numeric">${escapeHtml(row.last_event_at)}</span>` : ''}</span>`,
        '</div>',
        '</td>',
        '<td>',
        '<div class="token-stack numeric">',
        `<span>Total: ${formatInt(row.tokens.total_tokens)}</span>`,
        `<span class="muted">In ${formatInt(row.tokens.input_tokens)} / Out ${formatInt(row.tokens.output_tokens)}</span>`,
        '</div>',
        '</td>',
        '</tr>',
      ].join('')
    })
    .join('')

  return [
    '<section class="section-card">',
    sectionHeader('Running sessions', 'Active issues, last known agent activity, and token usage.'),
    snapshot.running.length
      ? [
          '<div class="table-wrap">',
          '<table class="data-table data-table-running">',
          '<colgroup>',
          '<col style="width: 12rem;" />',
          '<col style="width: 8rem;" />',
          '<col style="width: 7.5rem;" />',
          '<col style="width: 8.5rem;" />',
          '<col />',
          '<col style="width: 10rem;" />',
          '</colgroup>',
          '<thead><tr><th>Issue</th><th>State</th><th>Session</th><th>Runtime / turns</th><th>Codex update</th><th>Tokens</th></tr></thead>',
          `<tbody>${rows}</tbody>`,
          '</table>',
          '</div>',
        ].join('')
      : '<p class="empty-state">No active sessions.</p>',
    '</section>',
  ].join('')
}

function blockedSection(snapshot: RuntimeSnapshot): string {
  const rows = snapshot.blocked
    .map((row) => {
      const lastUpdate = summarizeCodexRuntimeMessage(row.last_event, row.last_message)
      return [
        '<tr>',
        '<td>',
        '<div class="issue-stack">',
        issueIdentifier(row.issue_identifier, row.issue_url),
        `<a class="issue-link" href="/api/v1/${encodeURIComponent(row.issue_identifier)}">JSON details</a>`,
        '</div>',
        '</td>',
        `<td><span class="${stateBadgeClass(row.state || 'Blocked')}">${escapeHtml(row.state || 'Blocked')}</span></td>`,
        `<td>${row.session_id ? `<button type="button" class="subtle-button" data-copy="${escapeHtml(row.session_id)}">Copy ID</button>` : '<span class="muted">n/a</span>'}</td>`,
        `<td class="mono">${escapeHtml(row.blocked_at || 'n/a')}</td>`,
        `<td>${escapeHtml(lastUpdate)}${row.last_event_at ? ` <span class="mono numeric">${escapeHtml(row.last_event_at)}</span>` : ''}</td>`,
        `<td>${escapeHtml(row.reason || 'n/a')}</td>`,
        '</tr>',
      ].join('')
    })
    .join('')

  return [
    '<section class="section-card">',
    sectionHeader('Blocked sessions', 'Issues paused because Codex requested operator input or approval.'),
    snapshot.blocked.length
      ? [
          '<div class="table-wrap">',
          '<table class="data-table">',
          '<thead><tr><th>Issue</th><th>State</th><th>Session</th><th>Blocked at</th><th>Last update</th><th>Error</th></tr></thead>',
          `<tbody>${rows}</tbody>`,
          '</table>',
          '</div>',
        ].join('')
      : '<p class="empty-state">No blocked sessions.</p>',
    '</section>',
  ].join('')
}

function retrySection(snapshot: RuntimeSnapshot): string {
  const rows = snapshot.retrying
    .map((row) => [
      '<tr>',
      '<td>',
      '<div class="issue-stack">',
      issueIdentifier(row.issue_identifier, row.issue_url),
      `<a class="issue-link" href="/api/v1/${encodeURIComponent(row.issue_identifier)}">JSON details</a>`,
      '</div>',
      '</td>',
      `<td class="numeric">${row.attempt}</td>`,
      `<td class="mono">${escapeHtml(row.due_at || 'n/a')}</td>`,
      `<td>${escapeHtml(row.error || 'n/a')}</td>`,
      '</tr>',
    ].join(''))
    .join('')

  return [
    '<section class="section-card">',
    sectionHeader('Retry queue', 'Issues waiting for the next retry window.'),
    snapshot.retrying.length
      ? [
          '<div class="table-wrap">',
          '<table class="data-table">',
          '<thead><tr><th>Issue</th><th>Attempt</th><th>Due at</th><th>Error</th></tr></thead>',
          `<tbody>${rows}</tbody>`,
          '</table>',
          '</div>',
        ].join('')
      : '<p class="empty-state">No issues are currently backing off.</p>',
    '</section>',
  ].join('')
}

function sectionHeader(title: string, copy: string): string {
  return [
    '<div class="section-header">',
    '<div>',
    `<h2 class="section-title">${escapeHtml(title)}</h2>`,
    `<p class="section-copy">${escapeHtml(copy)}</p>`,
    '</div>',
    '</div>',
  ].join('')
}

function issueIdentifier(identifier: string, url: string | null): string {
  const href = safeHttpUrl(url)
  if (!href) {
    return `<span class="issue-id">${escapeHtml(identifier)}</span>`
  }

  return [
    `<a class="issue-id issue-id-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHtml(identifier)} in the issue tracker">`,
    escapeHtml(identifier),
    '</a>',
  ].join('')
}

function stateBadgeClass(state: string): string {
  const normalized = state.toLowerCase()
  const variant =
    normalized.includes('progress') || normalized.includes('running') || normalized.includes('active')
      ? ' state-badge-active'
      : normalized.includes('blocked') || normalized.includes('error') || normalized.includes('failed')
        ? ' state-badge-danger'
        : normalized.includes('todo') || normalized.includes('queued') || normalized.includes('pending') || normalized.includes('retry')
          ? ' state-badge-warning'
          : ''
  return `state-badge${variant}`
}

function formatRuntimeAndTurns(startedAt: string, turnCount: number, generatedAt: string): string {
  const seconds = secondsBetween(startedAt, generatedAt)
  return turnCount > 0 ? `${formatRuntimeSeconds(seconds)} / ${turnCount}` : formatRuntimeSeconds(seconds)
}

function secondsBetween(startedAt: string, generatedAt: string): number {
  const start = Date.parse(startedAt)
  const end = Date.parse(generatedAt)
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return 0
  }

  return Math.max(0, Math.floor((end - start) / 1000))
}

function formatRuntimeSeconds(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.trunc(seconds))
  const mins = Math.floor(wholeSeconds / 60)
  const secs = wholeSeconds % 60
  return `${mins}m ${secs}s`
}

function formatInt(value: number): string {
  return value.toLocaleString('en-US')
}

function prettyValue(value: unknown): string {
  return value == null ? 'n/a' : JSON.stringify(value, null, 2)
}

function formatPolling(polling: RuntimeSnapshot['polling']): string {
  if (polling['checking?']) {
    return 'checking now'
  }

  if (typeof polling.next_poll_in_ms === 'number') {
    return `${Math.ceil(Math.max(0, polling.next_poll_in_ms) / 1000)}s`
  }

  return 'n/a'
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

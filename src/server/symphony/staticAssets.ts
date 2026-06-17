import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

export type SymphonyStaticAsset = {
  contentType: string
  body: BodyInit
}

const DASHBOARD_CSS = [
  ':root {',
  '  color-scheme: light;',
  '  --page: #f7f7f8;',
  '  --page-soft: #fbfbfc;',
  '  --card: rgba(255, 255, 255, 0.94);',
  '  --card-muted: #f3f4f6;',
  '  --ink: #202123;',
  '  --muted: #6e6e80;',
  '  --line: #ececf1;',
  '  --line-strong: #d9d9e3;',
  '  --accent: #10a37f;',
  '  --accent-ink: #0f513f;',
  '  --accent-soft: #e8faf4;',
  '  --danger: #b42318;',
  '  --danger-soft: #fef3f2;',
  '}',
  '* { box-sizing: border-box; }',
  'html { background: var(--page); }',
  'body {',
  '  margin: 0;',
  '  min-height: 100vh;',
  '  background: linear-gradient(180deg, var(--page-soft) 0%, var(--page) 34%, #f3f4f6 100%);',
  '  color: var(--ink);',
  '  font-family: "Sohne", "SF Pro Text", "Helvetica Neue", "Segoe UI", sans-serif;',
  '  line-height: 1.5;',
  '}',
  'a { color: var(--ink); text-decoration: none; }',
  'a:hover { color: var(--accent); }',
  'button {',
  '  appearance: none;',
  '  border: 1px solid var(--line-strong);',
  '  background: rgba(255, 255, 255, 0.72);',
  '  color: var(--muted);',
  '  border-radius: 999px;',
  '  padding: 0.34rem 0.72rem;',
  '  cursor: pointer;',
  '  font: inherit;',
  '  font-size: 0.82rem;',
  '  font-weight: 600;',
  '}',
  'pre { margin: 0; white-space: pre-wrap; word-break: break-word; }',
  'code, pre, .mono { font-family: "Sohne Mono", "SFMono-Regular", "SF Mono", Consolas, "Liberation Mono", monospace; }',
  '.mono, .numeric { font-variant-numeric: tabular-nums slashed-zero; font-feature-settings: "tnum" 1, "zero" 1; }',
  '.app-shell { max-width: 1280px; margin: 0 auto; padding: 2rem 1rem 3.5rem; }',
  '.dashboard-shell { display: grid; gap: 1rem; }',
  '.hero-card, .section-card, .metric-card, .error-card {',
  '  background: var(--card);',
  '  border: 1px solid rgba(217, 217, 227, 0.82);',
  '  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.05);',
  '}',
  '.hero-card { border-radius: 8px; padding: clamp(1.25rem, 3vw, 2rem); box-shadow: 0 20px 50px rgba(15, 23, 42, 0.08); }',
  '.hero-grid { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1.25rem; align-items: start; }',
  '.eyebrow { margin: 0; color: var(--muted); text-transform: uppercase; letter-spacing: 0; font-size: 0.76rem; font-weight: 600; }',
  '.hero-title { margin: 0.35rem 0 0; font-size: clamp(2rem, 4vw, 3.3rem); line-height: 1; }',
  '.hero-copy { margin: 0.75rem 0 0; max-width: 46rem; color: var(--muted); font-size: 1rem; }',
  '.status-stack { display: grid; justify-items: end; align-content: start; min-width: min(100%, 9rem); }',
  '.status-badge {',
  '  display: inline-flex;',
  '  align-items: center;',
  '  gap: 0.45rem;',
  '  min-height: 2rem;',
  '  padding: 0.35rem 0.78rem;',
  '  border-radius: 999px;',
  '  border: 1px solid var(--line);',
  '  background: var(--card-muted);',
  '  color: var(--muted);',
  '  font-size: 0.82rem;',
  '  font-weight: 700;',
  '}',
  '.status-badge-dot { width: 0.52rem; height: 0.52rem; border-radius: 999px; background: currentColor; opacity: 0.9; }',
  '.status-badge-live { background: var(--accent-soft); border-color: rgba(16, 163, 127, 0.18); color: var(--accent-ink); }',
  '.status-badge-offline { background: #f5f5f7; border-color: var(--line-strong); color: var(--muted); }',
  '[data-phx-main].phx-connected .status-badge-live { display: inline-flex; }',
  '[data-phx-main].phx-connected .status-badge-offline { display: none; }',
  '.metric-grid { display: grid; gap: 0.85rem; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }',
  '.metric-card { border-radius: 8px; padding: 1rem 1.05rem 1.1rem; }',
  '.metric-label { margin: 0; color: var(--muted); font-size: 0.82rem; font-weight: 600; }',
  '.metric-value { margin: 0.35rem 0 0; font-size: clamp(1.6rem, 2vw, 2.1rem); line-height: 1.05; }',
  '.metric-detail { margin: 0.45rem 0 0; color: var(--muted); font-size: 0.88rem; }',
  '.section-card { border-radius: 8px; padding: 1.15rem; }',
  '.section-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }',
  '.section-title { margin: 0; font-size: 1.08rem; line-height: 1.2; }',
  '.section-copy { margin: 0.35rem 0 0; color: var(--muted); font-size: 0.94rem; }',
  '.table-wrap { overflow-x: auto; margin-top: 1rem; }',
  '.data-table { width: 100%; min-width: 720px; border-collapse: collapse; }',
  '.data-table-running { table-layout: fixed; min-width: 980px; }',
  '.data-table th { padding: 0 0.5rem 0.75rem 0; text-align: left; color: var(--muted); font-size: 0.78rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0; }',
  '.data-table td { padding: 0.9rem 0.5rem 0.9rem 0; border-top: 1px solid var(--line); vertical-align: top; font-size: 0.94rem; }',
  '.issue-stack, .session-stack, .detail-stack, .token-stack { display: grid; gap: 0.24rem; min-width: 0; }',
  '.event-text, .event-meta { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.event-text { font-weight: 500; line-height: 1.45; }',
  '.state-badge { display: inline-flex; align-items: center; min-height: 1.85rem; padding: 0.3rem 0.68rem; border-radius: 999px; border: 1px solid var(--line); background: var(--card-muted); color: var(--ink); font-size: 0.8rem; font-weight: 600; line-height: 1; }',
  '.state-badge-active { background: var(--accent-soft); border-color: rgba(16, 163, 127, 0.18); color: var(--accent-ink); }',
  '.state-badge-warning { background: #fff7e8; border-color: #f1d8a6; color: #8a5a00; }',
  '.state-badge-danger { background: var(--danger-soft); border-color: #f6d3cf; color: var(--danger); }',
  '.issue-id { font-weight: 600; }',
  '.issue-id-link { color: inherit; text-decoration: underline; text-decoration-color: currentColor; text-decoration-thickness: 1px; text-underline-offset: 0.18em; }',
  '.issue-link { color: var(--muted); font-size: 0.86rem; }',
  '.muted { color: var(--muted); }',
  '.code-panel { margin-top: 1rem; padding: 1rem; border-radius: 8px; background: #f5f5f7; border: 1px solid var(--line); color: #353740; font-size: 0.9rem; }',
  '.empty-state { margin: 1rem 0 0; color: var(--muted); }',
  '.error-card { border-radius: 8px; padding: 1.25rem; background: var(--danger-soft); border-color: #f6d3cf; }',
  '.error-title { margin: 0; color: var(--danger); font-size: 1.15rem; }',
  '.error-copy { margin: 0.45rem 0 0; color: var(--danger); }',
  '@media (max-width: 860px) { .app-shell { padding: 1rem 0.85rem 2rem; } .hero-grid { grid-template-columns: 1fr; } .status-stack { justify-items: start; } .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }',
  '@media (max-width: 560px) { .metric-grid { grid-template-columns: 1fr; } .section-card, .hero-card, .error-card { padding: 1rem; } }',
].join('\n')

export const FAVICON_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64',
  ),
)

export const DASHBOARD_CSS_DIGEST = createHash('sha256')
  .update(DASHBOARD_CSS)
  .digest('hex')
  .slice(0, 12)

export const FAVICON_DIGEST = createHash('sha256').update(FAVICON_PNG).digest('hex').slice(0, 12)

export function staticAssetResponse(pathname: string): Response | null {
  const asset = STATIC_ASSETS[pathname]
  if (!asset) {
    return null
  }

  return new Response(asset.body, {
    headers: {
      'Cache-Control': 'public, max-age=31536000',
      'Content-Type': asset.contentType,
    },
  })
}

export const STATIC_ASSETS: Record<string, SymphonyStaticAsset> = {
  '/dashboard.css': {
    contentType: 'text/css; charset=utf-8',
    body: DASHBOARD_CSS,
  },
  '/favicon.png': {
    contentType: 'image/png; charset=utf-8',
    body: FAVICON_PNG,
  },
  '/vendor/phoenix_html/phoenix_html.js': {
    contentType: 'application/javascript; charset=utf-8',
    body: 'window.dispatchEvent(new Event("phoenix.link.click"));',
  },
  '/vendor/phoenix/phoenix.js': {
    contentType: 'application/javascript; charset=utf-8',
    body: 'var Phoenix = (() => { return { Socket: class Socket {} }; })();',
  },
  '/vendor/phoenix_live_view/phoenix_live_view.js': {
    contentType: 'application/javascript; charset=utf-8',
    body: 'var LiveView = (() => { return { LiveSocket: class LiveSocket { constructor(path, socket, options) { this.path = path; this.socket = socket; this.options = options || {}; } connect() { this.connected = true; } } }; })();',
  },
}

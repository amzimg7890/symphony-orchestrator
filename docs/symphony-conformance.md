# Symphony TanStack Conformance Notes

This document tracks how this TanStack Start implementation maps to the upstream
OpenAI Symphony shape described by `SPEC.md` and the Elixir reference
implementation.

## Covered In This Implementation

- Workflow loader parses optional YAML front matter plus a strict Liquid prompt
  template. Empty prompt bodies use a reference-style default prompt containing
  the issue identifier, title, and `Body:` description fallback, Liquid syntax
  failures surface as `template_parse_error`, and strict variable/filter
  failures surface as `template_render_error`. Prompt-only workflow files load
  with empty config, an opening `---` without a closing marker is treated as
  front matter with an empty prompt, and workflow prompts receive `attempt`
  plus nested issue collections such as labels and blockers.
- Typed config resolves defaults, `$VAR` indirection, path normalization, hook
  scripts, Codex safety defaults and overrides, logging, observability settings,
  and demo mode.
- Real Linear config supports explicit env-backed `tracker.project_slug` values
  such as `$LINEAR_PROJECT_SLUG`; empty env resolution is treated as the typed
  `missing_tracker_project_slug` preflight error.
- Linear API keys are trimmed after `$LINEAR_API_KEY` resolution, and
  whitespace-only values are treated as `missing_tracker_api_key`.
- Missing exact secret references such as `tracker.api_key: $MISSING_VAR` and
  `tracker.assignee: $MISSING_VAR` fall back to `LINEAR_API_KEY` and
  `LINEAR_ASSIGNEE` respectively, while exact references that resolve to an
  empty value remain empty/missing.
- `codex.stall_timeout_ms` is validated as a non-negative integer; `0`
  intentionally disables stall detection while negative values fail config
  resolution.
- Path config expands `~`, `~/...`, and `~\...` after `$VAR` resolution so
  workflow files remain portable across slash styles.
- Workspace config also retains a remote-root token for SSH execution so
  POSIX-style `workspace.root` values are not rewritten through the controller
  machine's local filesystem before remote command construction.
- Runtime startup overrides can replace `logging.root` and `server.port`,
  matching the upstream CLI's `--logs-root`/`--port` configuration surface,
  including `--port 0` as an ephemeral-port request in runtime config.
- Optional `worker.ssh_hosts` and `worker.max_concurrent_agents_per_host`
  config is parsed and surfaced in runtime snapshots. The orchestrator assigns
  worker hosts by least-loaded capacity, preserves worker host metadata in
  running, retrying, and blocked rows, and waits when all configured worker
  hosts are at capacity rather than falling back to local dispatch.
- SSH worker execution prepares and removes remote workspaces, runs configured
  workspace hooks on the assigned host, cleans terminal workspaces on the
  matching host, and lets startup terminal cleanup fan out across configured
  remote hosts.
- The built-in Codex runner can launch `codex.command` over SSH stdio on the
  assigned worker host while preserving the remote workspace as `cwd` and
  runtime workspace root in app-server thread/turn parameters.
- `server.host` defaults to `127.0.0.1`, is exposed in runtime snapshots, and
  the HTTP listener uses it when the daemon CLI starts the dashboard/API.
- The HTTP listener rejects malformed bind host strings such as `bad host`
  before attempting to start the daemon endpoint.
- Invalid workflow `server.port` values and non-string `server.host` values are
  surfaced as typed `invalid_config` errors instead of being silently ignored.
- `observability.dashboard_enabled`, `observability.refresh_ms`, and
  `observability.render_interval_ms` resolve with upstream defaults, surface in
  runtime snapshots, and browser dashboard auto-polling honors
  `dashboard_enabled` plus `refresh_ms`.
- CLI `--logs-root` overrides are trimmed and blank values are rejected before
  runtime config resolution, matching the upstream CLI's usage-error behavior.
- CLI lifecycle handling expands workflow paths, checks that the selected
  workflow file exists before startup, prints usage for invalid arguments, and
  returns clean startup errors.
- CLI `--run-for-ms` starts the daemon with the normal runtime path and then
  exits cleanly after the configured bounded window, which gives local GitHub
  Issues automation and manual GitHub Actions runs a portable lifecycle control.
- The daemon CLI loads `.env` from the current working directory before runtime
  startup, and `--dotenv` can select another file, so local runs use the same
  environment-backed workflow config as the read-only GitHub/Linear check
  scripts.
- Omitted, blank, or missing-env-backed `workspace.root` resolves to the
  reference default under the host temp directory,
  `<tmp>/symphony_workspaces`, normalized through the host platform's path
  rules.
- Dispatch preflight requires an explicit `tracker.kind` and reports
  `missing_tracker_kind` instead of silently defaulting the tracker backend.
- Config trims, lowercases, and de-duplicates `tracker.required_labels` while
  preserving a single blank entry so it matches no issue; issue label matching
  remains case-insensitive and trimmed.
- `tracker.active_states`, `tracker.terminal_states`, and
  `tracker.required_labels` must be lists of strings; invalid shapes surface
  `invalid_config` instead of silently falling back to defaults.
- Per-state concurrency overrides normalize state names and reject blank state
  names or non-positive/non-integer limits during config resolution.
- Linear tracker adapter normalizes issues, labels, blockers, pagination, branch
  metadata, assignee routing, terminal-state fetches, issue-state refresh,
  comment creation, issue state updates by state name, and raw `linear_graphql`
  tool calls.
- `tracker.kind: memory` provides an upstream-style in-process tracker for tests
  and local development. It reads configured `tracker.issues`, serves candidate,
  state-list, and id refresh calls without Linear credentials, filters
  candidates through configured active states, records local comments, and
  updates in-memory issue state.
- `tracker.kind: github` provides a local GitHub Issues tracker backed by the
  `gh` CLI. It uses `tracker.repo`/`GITHUB_REPOSITORY` when configured or lets
  `gh` infer the current repository, validates configured repositories as
  `OWNER/REPO` or `HOST/OWNER/REPO`, polls open issues by label, maps
  `Open`/`Closed` plus `Todo`/`In Progress`/`Done` aliases onto GitHub issue
  state, filters candidate issues through `assignee: me` via `gh api user`,
  creates comments with `gh issue comment`, and closes/reopens issues through
  `gh issue close` / `gh issue reopen`.
- Linear non-200 responses and top-level GraphQL errors surface structured,
  truncated details so operators and the `linear_graphql` tool can inspect
  schema/variable failures without logging unbounded response bodies.
- Linear 200 responses with malformed JSON and malformed successful payload
  shapes are mapped to `linear_unknown_payload` with bounded response-body
  details when a response body is available.
- Orchestrator owns in-memory claims, running entries, blocked handoffs, retry
  queue, exponential backoff, reconciliation, startup terminal workspace cleanup,
  workflow reload, invalid reload recovery, stall detection, and structured
  runtime snapshots.
- Retry snapshots carry the last run-attempt terminal reason (`Succeeded`,
  `Failed`, `TimedOut`, or `Stalled`) alongside retry attempt, due time, and
  error text.
- Retry timers defensively reload workflow config before attempting re-dispatch,
  so missed file-watch events do not let queued retries use stale eligibility
  rules.
- Workflow prompt rendering failures are scoped to the affected run attempt:
  the service remains running, no runner session is opened or launched for an
  invalid prompt, and the issue is queued for retry with the original
  `template_render_error` payload.
- Untyped runner exceptions are surfaced as `agent_error`, while typed
  Symphony errors from workflow, template, workspace, hook, Linear, and config
  layers keep their original error code.
- Run attempt snapshots expose the session initialization phase before the
  runner has returned a live app-server session.
- Running snapshots count `turn_started` events as started turns, deduplicate
  repeated events for the same turn id, and do not wait for `turn_completed`
  before exposing `turn_count`.
- Running and blocked snapshots expose live Codex session metadata (`thread_id`,
  `turn_id`, and `codex_app_server_pid`) in addition to the composed
  `session_id`.
- Runtime seconds are accumulated whenever a running entry leaves the running
  map, including normal/failed worker exits, blocked handoffs, stalls,
  reconciliation cancellations, and service stop.
- Workflow reload also reconfigures the tracker backend when the effective
  tracker mode changes, so future dispatches use the same backend reported in
  runtime snapshots.
- Workflow reload reconfigures the in-process memory tracker when configured
  `tracker.issues` change, so local no-Linear development follows the same
  future-dispatch reload semantics as the production tracker path.
- Running workers that observe a terminal issue state after a completed turn run
  `after_run`, remove the issue workspace, and release the in-memory claim
  instead of scheduling a continuation retry.
- Running workers re-check full run eligibility before in-session continuation
  and before scheduling post-exit continuation retries, so removed required
  labels, assignee routing changes, missing refreshed issues, and new
  non-terminal `Todo` blockers stop continuation rather than launching another
  turn.
- Active-run reconciliation uses the same run eligibility rules for non-terminal
  issues, releasing claims when required labels, assignee routing, or blocker
  state changes make an issue no longer routable to this worker.
- Multi-turn workers use one runner session. The first turn receives the rendered
  workflow prompt; later turns receive continuation guidance without replaying
  the original prompt.
- Completed issue bookkeeping represents currently released normal completions.
  Clean worker exits that schedule an active continuation retry stay in retrying
  state, and a released issue that becomes eligible again is removed from
  completed bookkeeping before re-dispatch.
- Workspace manager creates deterministic per-issue directories, preserves reused
  workspaces, runs hooks, and prevents paths from escaping the configured root.
- The `workspace:ensure-github` helper prepares local GitHub issue workspaces by
  cloning the configured repository into empty workspaces, skipping existing git
  checkouts, and refusing non-empty non-git directories before Codex launches.
- Workspace paths are canonicalized through existing symlinks before use:
  symlinked workspace roots resolve to their real location, workspaces that
  symlink outside the configured root are rejected, and stale non-directory
  paths at an issue workspace location are replaced with a fresh directory.
- If `after_create` fails for a newly-created workspace, the partial workspace
  directory is removed before surfacing the hook error so the next attempt can
  run bootstrap from a clean directory.
- Best-effort `after_run` and `before_remove` hook failures are logged as
  runtime events and stored in `last_error` without blocking completion or
  workspace cleanup. `before_remove` only runs when the workspace directory
  exists, avoiding false hook failures during idempotent cleanup.
- Hook failure payloads include exit metadata plus bounded stdout/stderr
  previews, and long hook output is truncated before it is surfaced through
  runtime events or `last_error` details.
- A `before_run` hook failure aborts the current attempt before launching the
  agent runner, but still executes `after_run` once the workspace directory has
  been prepared.
- Codex app-server runner performs the JSONL stdio handshake, starts one thread
  per worker session, can run multiple `turn/start` calls against that thread,
  launches `codex.command` through the host shell, streams token/session events,
  exposes `linear_graphql`, converts approval and hard elicitation requests into
  blocked runtime state with the composed `thread_id-turn_id` session id,
  normalizes `turn/input_required` and `turn/needs_input` notifications into
  blocked handoffs before turn timeout,
  emits dynamic tool completion/failure/unsupported runtime events after
  app-server tool requests,
  auto-approves approval requests only when `codex.approval_policy: never`, and
  answers tool input prompts with a fixed non-interactive response when possible.
- When the targeted Codex app-server supports it, the runner sets the thread
  name to `<issue.identifier>: <issue.title>` and includes issue id,
  identifier, and title in turn-scoped Responses API client metadata.
- Dynamic tool handling advertises the `linear_graphql` contract, accepts both
  object arguments and raw GraphQL query strings, validates required
  query/variables shapes, ignores legacy `operationName` arguments, passes
  multi-operation documents through to Linear unchanged, returns structured
  `output` plus `contentItems`, marks GraphQL `errors` payloads as tool failures
  while preserving the response body, and rejects unsupported tools without
  stalling the app-server turn.
- Additional Codex app-server progress notifications such as plan, diff, item,
  hook, command, process, Codex wrapper, MCP, and server-request updates are preserved as
  runtime progress events so active work refreshes observability and stall
  timing even when no token update is emitted.
- Codex app-server and wrapper notifications are summarized into observability-
  only human-readable messages for terminal/dashboard surfaces, covering thread
  and turn lifecycle, plan and diff updates, streaming agent/reasoning/command
  deltas, approvals, user-input requests, dynamic tool calls, account/rate-limit
  updates, token-count wrapper events, MCP startup, command begin/end, and item
  lifecycle updates. Operator-facing summaries strip ANSI escape sequences and
  control bytes before rendering.
- Codex runtime message summaries also accept upstream-style nested message
  envelopes with `payload.method`/`payload.params`, preserving auto-approved,
  auto-answered, dynamic-tool, and command-status context when raw Codex
  envelopes reach an observability surface.
- Real Codex `account/rateLimits/updated` notifications and Codex wrapper
  `rate_limits` payloads are mapped into the runtime `rate_limits` snapshot
  alongside token and session events.
- Token accounting accepts cumulative `thread/tokenUsage/updated`,
  `turn/completed` usage, and Codex wrapper `total_token_usage` payloads with
  common camelCase/snake_case token field names, while ignoring delta-only
  `last_token_usage` values for dashboard/API totals.
- Default Codex execution posture mirrors the upstream reference safety intent:
  object-form `reject` approval checks, `workspace-write` thread sandboxing,
  and per-turn `workspaceWrite` rooted at the issue workspace.
- Codex config validation mirrors reference edge cases for the startup command
  and policy fields: empty `codex.command` is invalid, whitespace-only commands
  are preserved, `codex.approval_policy` accepts strings or objects, and
  `codex.thread_sandbox` accepts strings while explicit
  `codex.turn_sandbox_policy` accepts objects. Invalid scalar policy values
  fail at config resolution.
- If a targeted Codex app-server rejects object-form `reject` approval policy,
  the runner retries the session start with the equivalent legacy `granular`
  policy so older installed schemas remain usable without weakening the
  configured safety checks.
- Observability includes a TanStack dashboard/API surface and JSONL structured
  runtime logs. Issue-related JSONL events include `issue_id` and
  `issue_identifier`, and Codex session events include session/thread/turn/app
  server metadata when the runner has reported it. Agent runtime events retain
  their structured event names while recent events and session-log messages use
  the same human-readable operator summaries as the dashboard. The HTTP/API
  presenter also projects running and blocked `last_message` fields through the
  same summaries while leaving orchestrator-internal snapshots raw and returns
  detached JSON projections for nested rate-limit, error-detail, and issue-detail
  state. Per-issue detail snapshots follow the upstream current-state contract
  for running, retrying, and blocked issues, including workspace path/host,
  recent event state, and the upstream-compatible `logs.codex_session_logs`
  section with bounded session summaries pointing at the structured JSONL log
  path. Per-issue detail responses synthesize upstream-style current-state
  `recent_events` entries from running or blocked rows and leave retrying issue
  events empty.
  Completed/released issues return `issue_not_found` at the HTTP API boundary.
  Retry rows retain `workspace_path`, and blocked rows expose both `reason` and
  the upstream-presenter `error` alias plus `last_event_at`.
- A terminal status formatter and `status:dashboard` script render an
  upstream-style `SYMPHONY STATUS` frame from either `/api/v1/state` or a saved
  runtime snapshot, including agent counts, throughput, runtime, token totals,
  rate limits, project/dashboard links, polling state, running rows, blocked
  rows, and retry/backoff rows.
- Terminal running rows follow the upstream table shape with `ID`, `STAGE`,
  `PID`, `AGE / TURN`, right-aligned `TOKENS`, compact session ids, event
  summaries, and status dots colored from the latest Codex event.
- Terminal dashboard framing follows the upstream snapshots for checking-state
  refresh text, section spacer rows, and the `╰─` closing border.
- Terminal throughput and runtime formatting follows the upstream snapshot
  semantics: TPS is integer-truncated with thousands separators, and runtime or
  running-age values always render as total minutes plus seconds.
- Terminal throughput helpers mirror the upstream 5-second rolling TPS,
  once-per-second throttling, and 24-column 10-minute sparkline bucket
  algorithms so future live terminal rendering can reuse the same metrics.
- Terminal backoff queue rows follow the upstream snapshot semantics: queued
  retries render with the retry marker, attempt count, millisecond-precision
  `in` countdown, sanitized error text, and `No queued retries` for an empty
  queue.
- Runtime snapshots include upstream-style polling state with `checking?`,
  `next_poll_in_ms`, and `poll_interval_ms`, so the API and dashboards can show
  whether a poll is running or when the next refresh is due.
- Runtime snapshots expose the non-secret tracker project slug so the terminal
  status dashboard can derive the upstream-style Linear project link directly
  from current workflow config when no CLI override is supplied.
- The terminal status dashboard also derives its dashboard URL from runtime
  `server_host`/`server_port` config when no explicit CLI override is supplied,
  including upstream host normalization for wildcard and IPv6 bind addresses.
- The dashboard/API exposes `/api/v1/events` as a server-sent events stream.
  The stream sends an immediate snapshot and then broadcasts fresh snapshots
  when orchestrator runtime events are recorded, matching the upstream
  PubSub-style "notify dashboard update" shape while preserving polling as a
  browser fallback.
- The daemon HTTP surface serves upstream-compatible static asset paths for
  `/dashboard.css`, `/favicon.png`, and the Phoenix vendor bundle URLs used by
  the reference dashboard, and the daemon dashboard HTML references those paths
  with upstream-style cache-busted CSS and favicon URLs plus the reference
  LiveView CSRF meta/bootstrap shape. Its server-rendered HTML now mirrors the
  reference dashboard's operations hero, metric cards, rate-limit panel,
  polling status, running sessions, blocked sessions, and retry queue, including
  upstream-style per-issue JSON detail links and human-readable Codex update
  text, while the primary browser experience remains TanStack-based.
- The TanStack Start runtime also serves the same upstream-compatible static
  asset URLs, backed by the same shared asset table as the daemon HTTP server.
- The TanStack dashboard route mirrors the same upstream observability sections
  in its React surface: operations hero, runtime metrics, rate limits, polling
  status, running sessions, blocked sessions, retry queue, per-issue JSON
  detail links, and human-readable Codex activity summaries. It treats API
  presenter `last_message` values as already display-ready and only falls back
  to event-name summaries when a message is absent, matching the upstream
  LiveView presenter/display split.
- Structured log sink failures are captured in `last_error` and as
  `structured_log_failed` runtime events without stopping the service or
  recursively writing to the failed sink.
- The TanStack API exposes an upstream-style `/api/v1/` discovery endpoint
  alongside `/api/v1/state`, `/api/v1/refresh`, control, and per-issue detail.
- HTTP POST endpoints accept JSON bodies and form-url-encoded submissions for
  upstream-style control and refresh requests. The parser is shared by the
  daemon HTTP server and the TanStack API route implementation.
- The TanStack API has a `/api/v1/$` splat route so unmatched multi-segment API
  paths return upstream-style `not_found` JSON instead of the default HTML 404.
- `GET /api/v1/state` mirrors the upstream observability presenter when a
  snapshot cannot be read or times out, returning HTTP 200 with a generated
  timestamp and either `snapshot_unavailable` or `snapshot_timeout`.
- Refresh-backed HTTP surfaces return the upstream-style
  `orchestrator_unavailable` HTTP 503 JSON when a manual refresh cannot be
  queued or executed.
- The daemon CLI starts an HTTP dashboard/API listener when `--port` or
  `server.port` is configured; it honors `server.host`, defaults to loopback,
  and formats all-interface bind hosts such as `0.0.0.0` as a loopback operator
  URL. `--port 0` binds an ephemeral port while keeping the requested runtime
  config visible in snapshots.
- Defined `/api/v1/*` routes return JSON `method_not_allowed` errors with an
  `Allow` header and the upstream `Method not allowed` message for unsupported
  methods.
- The control endpoint rejects unknown `action` values with a typed
  `invalid_control_action` HTTP 400 instead of treating them as an implicit
  start request.
- Dashboard issue identifiers link to tracker-provided issue URLs only when the
  URL is an `http` or `https` URL; other schemes render as plain text.
- The repository includes a Node/TanStack-side PR body checker mirroring the
  upstream `pr_body.check` gate against `.github/pull_request_template.md`.
- The repository includes a Node/TanStack-side `workspace:before-remove` helper
  mirroring the upstream `workspace.before_remove` hook utility for best-effort
  GitHub PR closure before terminal workspace cleanup.
- The repository includes a companion `workspace:ensure-github` helper for
  local GitHub issue runners. It uses the same local `gh` auth as the tracker,
  prepares an empty issue workspace with `gh repo clone <repo> .`, and is wired
  into `WORKFLOW.github.md` as a `before_run` hook.
- The repository includes a TypeScript `specs:check` gate mirroring the intent
  of upstream `specs.check` by requiring explicit return types on exported
  Symphony server functions.
- The repository includes an `acceptance:status` helper that inspects local
  `.env` and generated live workflow readiness without network access, reporting
  which local, read-only live, and opt-in mutating gates are ready, blocked, or
  skipped without printing the Linear API key.
- The repository includes a `workflow:live` preparation helper that converts
  `.env` Linear/Codex inputs into a validated real-run workflow without writing
  the Linear API key into the generated file.
- The repository includes a `workflow:check-live` read-only gate that loads the
  generated live workflow, verifies it is configured for real Linear plus Codex,
  and queries Linear candidate counts without mutating issues or invoking Codex.
- The repository includes a `workflow:check-github` read-only gate that loads a
  GitHub workflow, verifies it is configured for `tracker.kind: github` plus
  Codex, checks local `gh` authentication, and queries GitHub candidate counts
  without commenting, closing issues, or invoking Codex.
- The repository includes a guarded `workflow:prepare-github-issue` helper. Its
  default dry-run mode checks GitHub auth, repository labels, and existing
  eligible candidates without mutating GitHub; explicit `--create` and
  `--create-labels` flags are required to create a candidate issue or missing
  labels.
- The repository includes a manual GitHub Actions entrypoint for GitHub Issues
  automation. Its default mode runs the read-only GitHub workflow check, while
  the explicit worker mode runs the polling worker through the CLI's bounded
  `--run-for-ms` lifecycle and requires `codex app-server` to be installed on
  the runner.
- The repository includes a no-network GitHub CLI runtime smoke that runs the
  daemon CLI against a fake `gh` executable, proving the GitHub tracker can list
  a candidate issue, dispatch a worker, refresh issue state, and record terminal
  cleanup through the production CLI path without mutating GitHub.
- The repository includes a `workflow:smoke-live-readonly` runtime gate that
  starts the orchestrator with the generated live workflow, performs one real
  Linear candidate poll, and guards against any Codex runner dispatch.
- The repository includes a local `smoke:restart-recovery` gate that starts the
  production orchestrator with a memory workflow and pre-existing workspaces,
  proving startup terminal workspace cleanup without network access or model
  invocation.
- The repository includes an opt-in `smoke:live-e2e` gate mirroring the
  upstream live e2e shape: create a temporary Linear project and issue, run the
  production orchestrator with a real Codex turn, verify a workspace result
  file, verify a Linear comment, verify issue completion, then complete the
  temporary project and clean the workspace. Its SSH backend can use configured
  live SSH hosts or fall back to the upstream-style two-container Docker SSH
  worker setup. Routine runs skip unless `SYMPHONY_RUN_LIVE_E2E=1` is set.

## Current Verification

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run smoke:dev`
- `npm run smoke:prod-server`
- `npm run smoke:cli-http`
- `npm run smoke:cli-bounded`
- `npm run smoke:github-cli-runtime`
- `npm run smoke:orchestrator-soak`
- `npm run smoke:restart-recovery`
- `npm run smoke:codex-schema`
- `npm run smoke:codex-app-server`
- `npm run smoke:codex-live-turn` verifies its default no-model guard path and
  becomes an opt-in real model smoke when `SYMPHONY_LIVE_CODEX_SMOKE=1` is set.
- `npm run smoke:real-preflight` is available for read-only real Linear/Codex
  prerequisite checks when credentials are present; without credentials it
  reports `skipped: true` unless `SYMPHONY_REAL_PREFLIGHT_REQUIRED=1` is set.
- `npm run acceptance:status` reports a no-network readiness matrix for local
  gates, read-only Linear/Codex checks, and explicit opt-in live gates without
  printing secrets.
- `npm run status:dashboard -- --snapshot path/to/snapshot.json --no-color`
  renders a terminal status frame from a saved runtime snapshot; without
  `--snapshot`, it reads `/api/v1/state` from a running local service.
- `npm run workflow:live` prepares `.tmp/live-workflow/WORKFLOW.md` for a real
  Linear/Codex run without contacting external services or embedding secrets.
- `npm run workflow:check-live` reads the generated live workflow and checks
  real Linear candidate counts without starting the runner or mutating Linear.
- `npm run workflow:prepare-github-issue` reads `WORKFLOW.github.md`, checks
  GitHub labels and existing candidates, and prints a candidate creation
  command without mutating GitHub unless `--create` is supplied.
- `npm run workflow:check-github` reads `WORKFLOW.github.md` by default and
  checks local `gh` access plus GitHub candidate counts without starting the
  runner or mutating GitHub issues.
- `npm run cli -- WORKFLOW.github.md --run-for-ms 1800000` starts a bounded
  daemon window, which is useful for local GitHub Issues automation and manual
  GitHub Actions worker runs.
- `npm run workspace:ensure-github` prepares a local GitHub issue workspace by
  cloning the configured repository only when the workspace is empty.
- `npm run workspace:ensure-github` can also copy a local secret template from
  `SYMPHONY_WORKSPACE_ENV_FILE` into each issue workspace as
  `SYMPHONY_WORKSPACE_ENV_TARGET` or `.env.local`, without logging secret
  contents or requiring target repositories to commit `.env` files.
- `npm run workflow:smoke-live-readonly` starts the orchestrator against the
  generated live workflow for one guarded read-only Linear poll.
- `npm run smoke:ssh-worker-preflight` is available for read-only/no-model SSH
  worker prerequisite checks when `SYMPHONY_LIVE_SSH_WORKER_HOSTS` or
  `SYMPHONY_SSH_WORKER_HOSTS` is set; without hosts it reports `skipped: true`
  unless `SYMPHONY_SSH_WORKER_PREFLIGHT_REQUIRED=1` is set.
- `npm run smoke:live-e2e` is available for the full mutating Linear/Codex
  acceptance path; without `SYMPHONY_RUN_LIVE_E2E=1` it reports
  `skipped: true`. It can create a temporary project or reuse
  `SYMPHONY_LIVE_E2E_PROJECT_SLUG`/`LINEAR_PROJECT_SLUG` when an existing
  Linear project should be used as the test target.
- Dev-server smoke against the TanStack Start runtime:
  - dashboard HTML rendered through a temporary Vite dev server
  - upstream-compatible `/dashboard.css`, `/favicon.png`, and Phoenix vendor
    static asset URLs were served by the TanStack runtime
  - HEAD requests to the shared static assets and read-only JSON API routes
    returned HTTP 200 with the expected content type, and static assets retained
    the upstream `public, max-age=31536000` cache header
  - `/api/v1/` returned the API discovery payload and current runtime snapshot
  - `/api/v1/events` returned a server-sent `snapshot` event with the current
    runtime snapshot
  - unsupported methods on defined `/api/v1/*` routes returned HTTP 405 with
    JSON error envelopes, `Allow` headers, and the upstream
    `Method not allowed` message
  - `/api/v1/control` rejected an unknown action with `invalid_control_action`
  - form-url-encoded `/api/v1/control` start triggered the demo orchestrator
  - `/api/v1/state` reported `running` with mock Linear and simulated runner
  - a demo worker completed through the HTTP runtime
  - completed issue detail returned `issue_not_found`, matching the upstream
    current-state-only API contract
  - missing issue detail returned `issue_not_found` with the upstream
    `Issue not found` message
  - Stop returned `/api/v1/state` to `stopped`
  - JSONL runtime logs were written and checked for issue/session context
- Production server smoke against the TanStack build output:
  - runs `npm run build` and starts `.output/server/index.mjs` on a temporary
    loopback port
  - verifies dashboard HTML, `/dashboard.css`, `/favicon.png`, and all Phoenix
    vendor asset URLs from the production TanStack server, including the shared
    LiveView-compatible vendor stub
  - verifies HEAD support for shared static assets and read-only JSON API routes
    in the built TanStack server
  - verifies `/api/v1/` discovery and `/api/v1/events` snapshot SSE from the
    production server
  - starts the mock Linear/simulated-runner orchestrator through a
    form-url-encoded `/api/v1/control` request
  - waits for a demo worker completion, verifies JSONL worker logs, and stops
    the service cleanly
- CLI HTTP smoke:
  - starts the daemon-style CLI with `--port 0`
  - reads the printed loopback HTTP URL
  - verifies daemon dashboard HTML, cache-busted `/dashboard.css`,
    cache-busted `/favicon.png`, and Phoenix vendor asset references
  - verifies `/api/v1/` discovery, `/api/v1/state`, and observability snapshot
    config through the CLI listener
  - verifies form-url-encoded `/api/v1/refresh` and upstream-style
    method-not-allowed JSON through the CLI listener
  - sends SIGINT and shuts the CLI process down
- CLI bounded smoke:
  - starts the daemon-style CLI with a temporary memory tracker workflow and
    `--run-for-ms`
  - verifies the process exits without an external signal
- GitHub CLI runtime smoke:
  - starts the daemon-style CLI with a temporary `tracker.kind: github`
    workflow and fake `gh_command`
  - verifies `gh api user`, `gh issue list`, and `gh issue view` are invoked
  - verifies a GitHub-style issue dispatches through the simulated worker and
    records terminal cleanup plus worker completion in structured logs
- Orchestrator soak smoke:
  - runs a custom in-process Linear-like tracker and agent runner
  - proves two issues can dispatch concurrently under the configured limit
  - proves a failed issue stays claimed, retries, and completes on a later
    attempt
  - proves terminal completion removes issue workspaces
  - proves reconciliation releases a running issue after reassignment
  - proves stalled sessions are detected and queued for retry with `Stalled`
    retry detail
- CLI/config tests:
  - CLI arguments parse workflow paths plus `--logs-root`, `--port`, and
    `--run-for-ms`
    overrides
  - `--port 0` is accepted as the upstream ephemeral-port override
  - invalid `--run-for-ms` values are rejected before startup
  - CLI starts the HTTP listener when runtime config has `server.port`, and
    stops the orchestrator if the listener fails to bind
  - CLI startup output reports the automatic stop window when `--run-for-ms` is
    configured
  - blank `--logs-root` values are rejected instead of resolving to a whitespace
    directory
  - CLI lifecycle covers help output, default workflow selection, explicit path
    expansion, missing workflow files, invalid arguments, and startup failures
  - env-backed Linear project slugs resolve through `$LINEAR_PROJECT_SLUG` and
    empty env values remain dispatch-blocking config errors
  - env-backed Linear API keys are trimmed and whitespace-only values remain
    dispatch-blocking config errors
  - missing exact env references for Linear API key and assignee fall back to
    `LINEAR_API_KEY` and `LINEAR_ASSIGNEE`, while explicit empty referenced
    values do not fall back
  - omitted, blank, and missing-env-backed `workspace.root` values resolve to
    the reference temp-directory default root
  - `codex.stall_timeout_ms` accepts `0` as the disable value and rejects
    negative or non-integer values as `invalid_config`
  - runtime overrides replace workflow logging root and server port before
    snapshots/log paths are produced
  - required labels are trimmed/lowercased/de-duplicated while preserving one
    blank label, and invalid tracker state/label list shapes surface
    `invalid_config`
  - optional SSH worker host config trims empty hosts, validates per-host
    concurrency, and surfaces in runtime snapshots
  - configured `server.host` is preserved in snapshots and used when the CLI
    starts its HTTP listener
  - invalid `server.port` and non-string `server.host` values surface
    `invalid_config` errors
  - observability defaults and explicit values resolve into runtime config, and
    invalid observability booleans/intervals surface `invalid_config` errors
  - per-state concurrency overrides normalize configured state names, while
    blank names and non-integer/non-positive limits surface `invalid_config`
    errors
  - env-backed workspace/logging paths expand home directories with either
    slash style
  - SSH workspace config retains the configured remote root token while local
    workspace config still resolves to a controller-local absolute path
  - `tracker.kind: memory` resolves without Linear credentials, defaults to the
    simulated runner, parses configured issues and blockers, and disables demo
    mock tracker mode by default
- Memory tracker tests:
  - candidate fetches include only configured active-state issues, while
    state-list and id refresh calls are served from configured in-memory issues
  - local comment creation is recorded without network access
  - issue state updates mutate the in-memory issue
  - orchestrator dispatch works through the default tracker factory with a
    memory workflow and simulated runner
- PR body checker tests:
  - validate PR body markdown against the repository template headings
  - reject missing or out-of-order headings, placeholder comments, empty
    sections, missing bullet content, and missing checkbox content
  - report missing templates and unreadable PR body files as validation failures
- Workspace before-remove helper tests:
  - parse `--branch`, `--repo`, and help/invalid options
  - no-op when branch, `gh`, GitHub auth, or PR listing are unavailable
  - close open PRs for the configured branch and repo while tolerating per-PR
    close failures
- TypeScript specs checker tests:
  - report exported functions without explicit return types
  - accept exported functions with explicit return types and explicit exemptions
- HTTP server tests:
  - loopback listener exposes `/`, `/api/v1/`, `/api/v1/state`,
    `/api/v1/control`, `/api/v1/refresh`, and per-issue detail
  - daemon compatibility assets expose `/dashboard.css` and the Phoenix vendor
    JavaScript paths expected by upstream probes, with the daemon HTML linking
    those asset URLs plus cache-busted `/dashboard.css` and `/favicon.png`
    URLs, bootstrapping a LiveView-compatible socket stub, and rendering the
    upstream dashboard hero, metrics, rate-limit, polling, running, blocked,
    and retry sections
  - daemon dashboard rows expose per-issue JSON detail links and humanize Codex
    runtime events such as dynamic tool failures and auto-answered tool input
  - API index, state, refresh, SSE, and per-issue detail snapshots humanize
    running/blocked `last_message` values at the presenter boundary
  - presenter projections detach nested rate-limit, error-detail, issue labels,
    session logs, and tracked state so API formatting cannot mutate internal
    snapshots
  - API index snapshots include `polling.checking?`, `next_poll_in_ms`, and
    `poll_interval_ms`
  - `application/x-www-form-urlencoded` control and refresh POSTs are accepted
  - `/api/v1/events` streams an immediate snapshot and subsequent snapshots
    after observability broadcasts, and cleans up subscribers when clients close
  - malformed bind hosts are rejected with a typed `invalid_config` error
  - `0.0.0.0` bind hosts are accepted while the reported operator URL uses
    `127.0.0.1`
  - unsupported methods return 405 JSON envelopes with `Allow`
  - completed/released issue detail returns `issue_not_found` HTTP 404
  - missing issue detail returns `issue_not_found` HTTP 404
  - unknown routes, including raw or URL-encoded multi-segment issue-detail
    paths, return upstream style `not_found` HTTP 404 JSON
  - dashboard and discovery snapshot failures return `unavailable` HTTP 503 JSON
    envelopes, while state snapshot failures return upstream
    `snapshot_unavailable` or `snapshot_timeout` HTTP 200 payloads
  - refresh failures return `orchestrator_unavailable` HTTP 503 JSON envelopes
- Linear tracker tests:
  - candidate issue fetch uses the configured project slug, active states, and
    Linear `slugId` project filter
  - `tracker.assignee: me` resolves through the viewer query and filters
    candidates to that user
  - refreshed issue states preserve reassigned issues so reconciliation can
    release claims
  - Linear issue labels are trimmed, lowercased, and blank/null labels are
    discarded before required-label routing uses them
  - issue-state refresh splits more than 50 ids into batches and preserves the
    requested id order after merging responses, using Linear GraphQL ID typing
    (`[ID!]`)
  - tracker write operations create Linear comments, resolve target state names
    to state ids, and update issue state through Linear GraphQL mutations
  - missing target state names surface `linear_state_not_found`
  - empty state-list fetches return an empty list without calling Linear
  - terminal/active state fetches follow Linear `pageInfo` cursors across pages
  - candidate and terminal/active-state pagination reject `hasNextPage` payloads
    that omit the next cursor with `linear_missing_end_cursor`
  - transport failures surface `linear_api_request`
  - non-200 GraphQL responses surface structured, truncated body details while
    preserving useful error extension codes
  - top-level GraphQL `errors` responses surface `linear_graphql_errors` with
    truncated messages and preserved extension codes
  - successful malformed JSON, malformed candidate payloads, and malformed
    issue-state payloads surface `linear_unknown_payload` with bounded body
    details when available
- GitHub tracker tests:
  - candidate issue fetch uses `gh issue list` with repo, state, JSON fields,
    and required labels
  - `Todo`/`In Progress` and `Done` aliases map to GitHub open/closed state
    operations
  - `tracker.assignee: me` resolves through `gh api user` and marks refreshed
    issues as assigned or not assigned to this worker
  - candidate issue fetch filters out issues assigned to other GitHub users
  - comments use `gh issue comment`, state updates use `gh issue close` /
    `gh issue reopen`, and failed `gh` commands surface typed
    `github_cli_status` errors
- GitHub workflow check tests:
  - reject non-GitHub workflows before invoking `gh`
  - use a fake local `gh` executable to verify read-only auth, issue listing,
    candidate counts, terminal counts, and next-command output
- GitHub issue preparation tests:
  - default to a read-only dry run that reports missing labels and prints the
    candidate `gh issue create` command without creating an issue
  - require explicit create flags before invoking `gh label create` and
    `gh issue create`
- GitHub workflow prompt:
  - includes the GitHub issue body so local-gh workers receive the actual task
    instructions instead of only the issue title and labels
  - sets `codex.approval_policy: never` and a `dangerFullAccess` turn sandbox
    so local or Actions workers can complete `gh issue comment`/`gh issue
    close` handoff steps unattended
- GitHub workspace preparation tests:
  - parse repository, workspace, and GitHub command defaults from environment
  - clone into empty workspaces through a fake `gh repo clone`
  - skip existing git checkouts and reject non-empty non-git directories
- Dev-server workflow reload smoke with a temporary workflow:
  - invalid reload surfaced `config_errors` in `/api/v1/state`
  - valid reload cleared `config_errors`
- Browser DOM verification against the TanStack dashboard:
  - demo orchestrator state rendered a tracker issue identifier as an
    `https://linear.example/...` link
  - the issue link opened in a new tab with `rel="noopener noreferrer"`
- Terminal status dashboard tests:
  - render a `SYMPHONY STATUS` frame with agent counts, throughput, runtime,
    token totals, upstream-style rate limit id/bucket/credits details and
    colorized rate-limit segments, project/dashboard links, polling status,
    running rows, blocked rows, and retry/backoff rows
  - verify upstream-style running table headers, PID and age/turn cells,
    compact session ids, and event-derived status dot colors
  - verify upstream-style refresh text, section spacer rows, and closing border
  - verify upstream rolling TPS, throttled TPS, and 10-minute sparkline snapshots
  - normalize newline and escaped-newline sequences in inline row text
  - strip ANSI escapes and control bytes from runtime row text
  - humanize auto-approved approvals, auto-answered tool input, and malformed
    protocol events in running rows
  - humanize dynamic tool completed, failed, and unsupported runtime events in
    running rows
  - render the offline status frame
  - render a saved snapshot through the `status:dashboard` CLI script
- Orchestrator terminal cleanup test:
  - a mock worker transitions a running issue to `Done`
  - the issue workspace is removed after `after_run`
  - claimed/retrying counts return to zero for that handoff
  - a blocked handoff that later reaches `Done` during reconciliation releases
    its claim and removes its workspace
  - failing `after_run` and `before_remove` hooks are reported while cleanup
    still completes
- Orchestrator tracker reload test:
  - starts with a mock tracker backend
  - reloads the workflow into Linear mode using an injected no-network tracker
  - verifies the next dispatch is served by the new tracker backend
  - reloads configured memory tracker issues and verifies the next local
    dispatch is served from the new issue seed
- Orchestrator polling reload test:
  - a runtime workflow reload that changes `polling.interval_ms` clears the
    previously scheduled tick and applies the new interval to the next poll
  - snapshots expose upstream-style polling status, including `checking?` while
    a poll is in flight and a bounded `next_poll_in_ms` countdown after it
    completes
- Orchestrator retry reload test:
  - a queued retry re-reads workflow config before dispatch and releases its
    claim when the reloaded required labels make the issue ineligible
- Orchestrator retry capacity test:
  - a queued retry remains claimed and is requeued when the global slot is open
    but the issue's per-state concurrency slot is unavailable
- Orchestrator candidate-selection tests:
  - candidate dispatch order follows priority, creation time, and identifier
    tie-breaks even when the tracker returns issues in a different order
  - per-state concurrency limits prevent dispatching a second issue in a capped
    state while other active states can still fill available global slots
  - SSH worker host pools assign runs to the least-loaded available host and do
    not fall back to local dispatch when every configured host is full
  - `Todo` issues with non-terminal blockers are skipped while unblocked
    candidates and candidates whose blockers are all terminal continue to
    dispatch
  - blank configured required labels are not silently ignored and prevent
    dispatch because no normalized issue label can satisfy them
- Orchestrator continuation eligibility tests:
  - removing a required label after a successful turn stops in-session
    continuation and releases the claim instead of scheduling a continuation
    retry
  - removing a required label while an issue is running causes reconciliation to
    stop the active run, release the claim, and preserve the non-terminal
    workspace
- Orchestrator reconciliation release tests:
  - reloaded `active_states` are used for active-run reconciliation, so a
    running issue that is no longer active is canceled and released without
    terminal workspace cleanup
  - running issues that disappear from tracker state refresh are terminated and
    release their claims without treating the workspace as terminal
  - blocked handoffs that disappear from tracker state refresh release their
    claims and leave recovery to future tracker/filesystem state
- Orchestrator startup recovery tests:
  - terminal issue workspaces are removed before the service starts polling
  - terminal cleanup refresh failures are reported but do not prevent startup
- Restart recovery smoke:
  - creates local terminal and active workspaces under a temporary `.tmp`
    workflow
  - starts the production orchestrator with a memory tracker
  - verifies startup cleanup removes terminal workspaces, preserves non-terminal
    workspaces, records `startup_cleanup_completed`, and does not dispatch a
    runner
- Orchestrator run-attempt lifecycle test:
  - invalid workflow prompt rendering queues a typed retry without opening a
    runner session, launching the runner, or stopping the service
  - holds a runner session startup open
  - verifies `/state`-equivalent snapshots expose `InitializingSession`
  - verifies `turn_count` increments on `turn_started` without requiring
    `turn_completed`
  - verifies running snapshots expose thread, turn, and app-server process
    metadata from agent events
- Orchestrator blocked handoff tests:
  - blocked handoffs preserve elapsed runtime seconds in aggregate Codex totals
  - blocked snapshots preserve thread, turn, and app-server process metadata
  - structured log sink failures keep the service running and surface an
    operator-visible `structured_log_failed` event
  - dynamic tool runtime events are written to recent events and per-issue
    session logs with human-readable operator messages
- Orchestrator completed-bookkeeping tests:
  - clean exits that leave the issue active schedule a continuation retry
    without incrementing completed issue counts and preserve retry
    `workspace_path` plus per-issue workspace host/path
  - a previously completed issue that becomes eligible again clears its
    completed entry when it is dispatched
- Workspace lifecycle tests:
  - stale non-directory paths at an issue workspace location are replaced with
    directories
  - symlink escapes under the workspace root are rejected before hook or agent
    execution
  - symlinked workspace roots are canonicalized before issue directories are
    created
  - a failing `after_create` hook on a brand-new workspace removes the partial
    workspace before returning `hook_error`
  - fake-SSH coverage verifies remote workspace creation, remote hooks, and
    remote removal command shapes without requiring a live SSH host
- Orchestrator hook lifecycle test:
  - a failing `before_run` aborts before runner launch, runs `after_run`, and
    queues the issue for retry with `hook_error`
- Prompt rendering tests:
  - prompt-only workflow files load with empty config
  - unterminated YAML front matter loads as config with an empty prompt
  - empty prompt bodies use the reference-style default Linear prompt with
    identifier, title, and description fallback
  - prompt templates can read retry `attempt` values, detect first-run null
    attempts, and iterate labels plus blocker records
  - unknown Liquid variables and filters fail with `template_render_error`
  - invalid Liquid syntax fails with `template_parse_error`
- Codex app-server schema smoke:
  - invokes the installed Codex CLI
  - generates app-server JSON schema into a temporary directory
  - checks the v1 initialize schema, v2 thread/turn/thread-name schema,
    token/message/rate limit notifications, dynamic tool calls, and
    approval/elicitation request schemas
- Codex app-server handshake smoke:
  - starts the real installed `codex app-server`
  - completes the JSONL initialize and initialized handshake
  - starts and names a thread in a temporary workspace
  - allows a 60 second JSON-RPC request timeout for current Codex CLI cache
    warmup during `thread/start`, while preserving the runtime
    `codex.read_timeout_ms` default from the upstream spec
  - verifies object-form approval defaults, or the legacy `granular`
    compatibility fallback when the installed app-server does not support
    `reject`
  - exits before `turn/start`, so no model work is invoked
- Codex app-server runner tests:
  - verify shell-launched `codex.command` values can use host environment
    variable expansion to locate a fake app-server
  - verify worker-host runs launch the fake app-server through SSH with the
    remote workspace command path
  - verify upstream `reject` approval defaults and fallback to legacy
    `granular` on app-server schemas that reject object-form policy
  - verify thread naming and turn-scoped issue metadata are emitted from
    normalized issue context
  - drive complete turns, multiple turns, token/rate-limit/progress events, and
    approval handoffs with composed session ids through the fake app-server
  - verify `codex.approval_policy: never` auto-approves command approval
    requests and tool approval prompts while the default safer policy still
    blocks command approval
  - verify tool input prompts receive the upstream-style fixed non-interactive
    answer instead of stalling the app-server turn
  - verify no-id `mcpServer/elicitation/request` notifications are treated as
    hard input blockers rather than ordinary progress notifications
  - verify `turn/needs_input` notifications are treated as hard input blockers
    rather than waiting for the turn timeout
  - verify JSON-like malformed protocol lines are surfaced as `malformed`
    observability events without preventing a later valid turn completion
  - verify supported `linear_graphql` dynamic tool calls travel through the
    app-server request path to a local fake Linear endpoint and return the tool
    result to the fake app-server while emitting `tool_call_completed`
  - verify supported dynamic tool failures emit `tool_call_failed` without
    stalling the turn
  - verify human-readable summaries for plan updates and wrapper token-count
    events are emitted as observability messages
  - verify unsupported dynamic tool calls return a failure payload to the fake
    app-server, emit `unsupported_tool_call`, and do not stall the turn
  - verify cumulative token accounting shapes, `last_token_usage` ignore
    behavior, and Codex wrapper `rate_limits` extraction
- Codex event summary tests:
  - humanize thread/turn lifecycle, plan, diff, and token usage notifications
  - humanize streaming, approval, user-input, and dynamic tool events
  - humanize Codex wrapper token count, command, MCP, and account rate-limit
    events
  - unwrap nested Codex payload envelopes and preserve auto-handled runtime
    context
  - humanize auto-handled approval/tool-input and malformed runtime events
  - humanize dynamic tool completion, failure, and unsupported runtime events
  - keep fallback runtime message summaries bounded and observability-only
- Dynamic tool tests:
  - verify the advertised `linear_graphql` input schema
  - execute object-form and raw-string GraphQL arguments through an injected
    executor
  - ignore legacy `operationName` arguments while forwarding the GraphQL
    document
  - pass multiple-operation GraphQL documents through unchanged and preserve the
    resulting Linear GraphQL error body as tool output
  - preserve successful responses and GraphQL `errors` bodies in tool output
  - reject missing queries, invalid argument shapes, and invalid variables
    before calling Linear
  - format Linear transport failures as structured tool failures
  - return Linear HTTP status details to the agent for failed GraphQL tool calls
- Opt-in live Codex turn smoke:
  - uses the production `CodexAppServerRunner`
  - starts the real installed `codex app-server`
  - sends one `turn/start` in a temporary workspace
  - requires `SYMPHONY_LIVE_CODEX_SMOKE=1` so routine verification does not
    invoke a model accidentally
- Real preflight smoke:
  - loads `.env` if present
  - reports a skipped result when Linear credentials are unavailable, with an
    opt-in required mode for CI/release gates
  - checks Codex CLI availability
  - validates Linear viewer access, project/state issue queries, labels,
    assignee routing inputs, terminal state samples, and blocker relation shape
  - remains read-only and does not dispatch a worker
- Acceptance status matrix:
  - loads `.env` if present and reports only whether secret-backed settings are
    present
  - inspects `.tmp/live-workflow/WORKFLOW.md` by default through the same
    workflow parser/config resolver used by the runtime
  - classifies local, read-only live, no-model SSH, live Codex turn, and live
    e2e gates as ready, blocked, or skipped without network access
  - has Vitest coverage for missing prerequisites and a ready generated live
    workflow while asserting the Linear API key is not printed
- Live workflow preparation:
  - loads `.env` if present
  - validates Linear credentials and project slug through the same workflow
    parser/config resolver used by the runtime
  - writes a real `demo.mock_tracker: false` Codex workflow under `.tmp` by
    default while preserving `$LINEAR_API_KEY` as an env reference
- Live workflow read-only check:
  - loads `.env` and `.tmp/live-workflow/WORKFLOW.md` by default
  - rejects demo/mock or non-Codex workflows before network access
  - reads active, eligible candidate, and terminal issue counts from Linear
    without creating comments, updating issue state, or starting Codex
- GitHub workflow read-only check:
  - loads `.env` and `WORKFLOW.github.md` by default
  - rejects non-GitHub, mock, or non-Codex workflows before invoking `gh`
  - checks local `gh auth status` and reads active, eligible candidate, and
    terminal issue counts without mutating GitHub or starting Codex
- GitHub workspace preparation helper:
  - `WORKFLOW.github.md` calls `workspace:ensure-github` from `before_run`
  - a real local verification cloned `amzimg7890/fresh_food_butler` into the
    `GH-27` issue workspace through `gh repo clone`
- Live workflow read-only runtime smoke:
  - starts `SymphonyOrchestrator` with the generated live workflow and a guard
    runner
  - performs one real Linear candidate poll through the runtime orchestration
    path
  - returns no candidates to dispatch and fails if the Codex runner is invoked,
    keeping the smoke read-only with respect to Linear and no-model with
    respect to Codex
- SSH worker preflight smoke:
  - loads `.env` if present
  - reports a skipped result when no SSH hosts are configured, with an opt-in
    required mode for CI/release gates
  - checks `printf ready` and `$HOME` over each configured SSH host
  - creates and removes a remote workspace through the production workspace
    manager
  - starts and names a remote Codex app-server thread through the production
    SSH runner
  - exits before `turn/start`, so no model work is invoked
- Live e2e smoke:
  - loads `.env` if present
  - reports a skipped result unless `SYMPHONY_RUN_LIVE_E2E=1` is set
  - creates a temporary Linear project and issue in the configured team, or
    reuses `SYMPHONY_LIVE_E2E_PROJECT_SLUG`/`LINEAR_PROJECT_SLUG` and creates
    only a temporary issue inside that existing project
  - starts the production orchestrator with local, configured SSH, or
    Docker-backed temporary SSH worker settings
  - sends one Codex `turn/start` and expects the agent to write
    `LIVE_E2E_RESULT.txt`, create a Linear comment, and complete the issue via
    `linear_graphql`
  - verifies the result file, comment body, and completed issue state before
    completing the temporary project when one was created and cleaning the
    workspace
  - has Vitest coverage with fake Linear and fake Codex app-server services, so
    routine tests cover the orchestration path without mutating real services

Latest safe validation evidence in this workspace includes passing
`smoke:codex-schema` against `codex-cli 0.139.0`, passing daemon CLI HTTP smoke,
passing TanStack dev-server smoke, passing TanStack production-server smoke,
passing the local orchestrator soak, passing restart-recovery smoke, passing
`typecheck` and `specs:check`, and the SSH worker preflight defaulting to a
safe skip when no live worker hosts are configured.

The Vitest run currently exits successfully while still printing Vite's close
timeout diagnostic.

## Remaining Proof Gaps

- Real Linear API preflight has a passing read-only run against the configured
  project in this workspace. The mutating live e2e gate still needs explicit
  opt-in with a real project/team target before it can be counted as verified.
- Real Codex app-server no-model handshake has a passing run in this workspace:
  initialize, `thread/start`, and thread naming succeed without sending
  `turn/start`. The opt-in real Codex turn smoke still needs explicit
  `SYMPHONY_LIVE_CODEX_SMOKE=1` before it can count as verified here. Multiple
  turns, supported `linear_graphql` through the real app-server, and operator
  approval handoff remain fake-server/direct-test covered only.
- Browser/dev-server validation backed by real Linear and Codex instead of the
  mock tracker and simulated runner.
- Longer soak now has a local in-process smoke. It still needs a sustained real
  Linear and Codex-backed soak before unattended production use.
- SSH worker execution now has a no-model real-host preflight script, but still
  needs that script and a full Linear/Codex issue flow run against reachable SSH
  hosts or Docker SSH workers with a real remote Codex app-server environment.

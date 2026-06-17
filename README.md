# Symphony on TanStack

This is a TanStack Start reimplementation of the OpenAI Symphony service shape.

It follows the upstream `SPEC.md` contract: workflow loading, typed config resolution, issue selection, per-issue workspaces, retry scheduling, reconciliation, structured runtime snapshots, and an optional HTTP dashboard/API. The default `WORKFLOW.md` runs in demo mode with an in-memory Linear-compatible tracker and simulated agent runner so the app can be inspected without secrets.

Runtime events are also written as structured JSONL logs. By default, `WORKFLOW.md` writes them to `./log/symphony.jsonl`; set `logging.enabled: false` to keep logs in the in-memory dashboard only.
Dashboard refresh behavior is configured through `observability.refresh_ms`;
set `observability.dashboard_enabled: false` to keep the dashboard available
without automatic browser polling or event-stream subscription.

The TanStack status surface exposes the dashboard at `/`, an API index at
`/api/v1/`, the runtime snapshot at `/api/v1/state`, server-sent observability
events at `/api/v1/events`, manual refresh at `/api/v1/refresh`, start/stop
control at `/api/v1/control`, and per-issue runtime detail at
`/api/v1/{issue_identifier}`. Runtime snapshots include upstream-style polling
status (`checking?`, `next_poll_in_ms`, and `poll_interval_ms`) for dashboard
refresh countdowns. Per-issue detail follows the upstream current-state
contract: running, retrying, and blocked issues expose workspace metadata
(`path` and `host`), while completed/released issues return `issue_not_found`.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

The daemon-style CLI mirrors the upstream startup shape for workflow and runtime
overrides:

```bash
npm run cli -- ./WORKFLOW.md --logs-root ./runtime-log --port 3000
```

When `--port` or `server.port` is set, the CLI binds an HTTP listener and prints
its URL. The default `server.host` is `127.0.0.1`; set `server.host` explicitly
when you need another bind host. `--port 0` requests an ephemeral port while
preserving `0` in runtime snapshots, matching the upstream override semantics.
The TanStack dev and production servers expose the same dashboard/API routes for
app-style use.

## Verify

```bash
npm run typecheck
npm test
npm run build
npm run smoke:dev
npm run smoke:cli-http
npm run smoke:orchestrator-soak
npm run smoke:restart-recovery
npm run smoke:codex-schema
npm run smoke:codex-app-server
npm run smoke:codex-live-turn
npm run smoke:real-preflight
npm run smoke:ssh-worker-preflight
npm run smoke:live-e2e
npm run acceptance:status
npm run status:dashboard -- --snapshot path/to/snapshot.json --no-color
npm run workflow:live
npm run workflow:check-live
npm run workflow:smoke-live-readonly
npm run pr-body:check -- --file path/to/pr_body.md
npm run workspace:before-remove -- --branch feature/my-branch --repo owner/repo
npm run specs:check
```

`smoke:dev` starts a temporary Vite dev server, drives the Symphony HTTP API with
a temporary demo workflow, checks the SSE observability stream, checks invalid
and valid reload behavior, verifies JSONL logs, and then shuts the temporary
service down.

`smoke:cli-http` starts the daemon-style CLI with `--port 0`, reads the printed
loopback URL, verifies `/api/v1/` and `/api/v1/state`, and then shuts the CLI
down.

`smoke:orchestrator-soak` runs an in-process Linear-like tracker and custom
runner through a longer local scenario covering concurrent dispatch, retry,
terminal workspace cleanup, reassignment release, and stalled worker recovery.

`smoke:restart-recovery` is local, no-network, and no-model. It creates a
memory-tracker workflow with pre-existing workspaces, starts the production
orchestrator, verifies startup cleanup removes terminal issue workspaces, checks
that non-terminal workspaces remain, and fails if a runner is dispatched.

`smoke:codex-schema` uses the installed Codex CLI to generate the app-server JSON
schema and checks the protocol files/method names that the adapter depends on.

`smoke:codex-app-server` starts the real installed `codex app-server`, completes
the JSONL initialize handshake, starts and names a thread in a temporary
workspace, and then exits without sending `turn/start` or invoking a model. It
uses a 60 second JSON-RPC request timeout because recent Codex builds may warm
model or plugin caches during `thread/start`; set
`SYMPHONY_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS` to tune that smoke without
changing runtime `codex.read_timeout_ms` defaults.

`smoke:codex-live-turn` is safe by default: without
`SYMPHONY_LIVE_CODEX_SMOKE=1` it prints a skipped result and does not call a
model. With that variable set, it starts the real installed `codex app-server`
through the production runner, sends one `turn/start` in a temporary workspace,
expects `turn_completed`, and then tears the workspace down. Optional
`SYMPHONY_LIVE_CODEX_MODEL`, `SYMPHONY_LIVE_CODEX_READ_TIMEOUT_MS`, and
`SYMPHONY_LIVE_CODEX_TURN_TIMEOUT_MS` variables tune that live smoke.

`smoke:real-preflight` is read-only: it loads `.env` when present, checks the
installed Codex CLI, queries Linear viewer/project/state/label/assignee inputs,
and exits without starting an agent or mutating Linear. Without credentials it
prints a skipped result unless `SYMPHONY_REAL_PREFLIGHT_REQUIRED=1` is set.

`smoke:ssh-worker-preflight` is also safe by default: without
`SYMPHONY_LIVE_SSH_WORKER_HOSTS` or `SYMPHONY_SSH_WORKER_HOSTS` it prints a
skipped result. With comma-separated hosts configured, it verifies SSH reachability,
creates and removes a remote workspace through the production workspace manager,
starts a remote Codex app-server session through the production SSH runner, and
then closes it without sending `turn/start` or invoking a model. Use
`SYMPHONY_SSH_CONFIG` for custom SSH config, and set
`SYMPHONY_SSH_WORKER_PREFLIGHT_REQUIRED=1` when CI should fail instead of skip.

`smoke:live-e2e` is the opt-in destructive/live acceptance path. Without
`SYMPHONY_RUN_LIVE_E2E=1` it skips. With that variable, it creates a temporary
Linear project and issue, starts the production orchestrator, sends a real Codex
turn, expects the agent to write `LIVE_E2E_RESULT.txt`, create a Linear comment,
move the issue to a completed state through `linear_graphql`, verifies all three
effects, then completes the temporary project and cleans the workspace. It uses
local workspaces by default. Set `SYMPHONY_LIVE_E2E_PROJECT_SLUG` or
`LINEAR_PROJECT_SLUG` to reuse an existing Linear project instead of creating
and completing a temporary project; the smoke still creates a temporary issue in
that project. Set `SYMPHONY_LIVE_E2E_BACKEND=ssh` to run through SSH workers;
when `SYMPHONY_LIVE_SSH_WORKER_HOSTS` is empty, the script mirrors the upstream
live test by starting two temporary Docker SSH workers. Docker mode requires a
Codex auth file at `~/.codex/auth.json` or `SYMPHONY_LIVE_DOCKER_AUTH_JSON`.

`acceptance:status` is a local, no-network status matrix for the acceptance
gates. It loads `.env`, inspects `.tmp/live-workflow/WORKFLOW.md` by default,
reports which local/read-only/opt-in gates are ready, blocked, or skipped, and
never prints the Linear API key. Use `--workflow path/to/WORKFLOW.md` and
`--dotenv path/to/.env` to inspect alternate inputs.

`status:dashboard` renders an upstream-style terminal status frame from either
a running Symphony service or a saved runtime snapshot. By default it reads
`http://127.0.0.1:3001/api/v1/state`; use `--url http://host:port` for another
service, or `--snapshot path/to/snapshot.json` for an offline JSON file. Add
`--project-slug` when you want the terminal frame to include a Linear project
link. Codex protocol and wrapper events are summarized into short
observability-only messages for this terminal view and the dashboard.

`workflow:live` is a local preparation helper for real Linear/Codex runs. It
loads `.env`, validates that `LINEAR_API_KEY` and a project slug are available,
and writes `.tmp/live-workflow/WORKFLOW.md` with `demo.mock_tracker: false` and
a Codex runner. The generated workflow references `$LINEAR_API_KEY` instead of
embedding the secret. Use `--out path/to/WORKFLOW.md` to choose another output
path. This helper does not contact Linear or start Codex.

`workflow:check-live` is a read-only check for the generated workflow. It loads
`.tmp/live-workflow/WORKFLOW.md` by default, resolves the workflow through the
runtime config parser, verifies it is configured for real Linear plus the Codex
runner, and queries Linear for active/eligible/terminal issue counts. It does
not create issues, write comments, update states, or start Codex.

`workflow:smoke-live-readonly` starts the production orchestrator with the
generated live workflow and a guarded runner. It lets the runtime perform one
real Linear candidate poll, but returns no issues to the dispatcher so Codex is
not started and Linear is not mutated. This is useful for validating the real
runtime wiring before running the destructive `smoke:live-e2e` gate.

`pr-body:check` mirrors the upstream PR-description gate. It validates a PR body
markdown file against `.github/pull_request_template.md`, requiring the same
headings in order, non-empty sections, no placeholder comments, and bullet or
checkbox content where the template requires it.

`workspace:before-remove` mirrors the upstream workspace cleanup helper. It is a
best-effort command for `hooks.before_remove`: it discovers the current Git
branch when `--branch` is omitted, checks `gh auth status`, closes open GitHub
PRs for that branch, and quietly no-ops when GitHub CLI, auth, or branch context
is unavailable.

`specs:check` is the TypeScript counterpart to the upstream public API spec
gate. It scans `src/server/symphony` by default and fails when an exported
function is missing an explicit return type. Use repeated `--paths` flags to
scan additional source roots.

## Runner Modes

The checked-in `WORKFLOW.md` uses the safe demo path:

```yaml
agent:
  runner: simulated
demo:
  mock_tracker: true
```

For local development without Linear credentials, you can also use the upstream
style memory tracker:

```yaml
tracker:
  kind: memory
  active_states: [Todo]
  terminal_states: [Done]
  issues:
    - id: issue-local-1
      identifier: MEM-1
      title: Try the local memory tracker
      state: Todo
      labels: [codex]
```

Memory tracker issues are kept in process memory. `createComment` records local
comments and `updateIssueState` updates the in-memory issue state, which makes
it useful for exercising orchestration behavior without network access.

A real workflow can use the cleanup helper from `before_remove` when workspaces
are Git checkouts with GitHub CLI available:

```yaml
hooks:
  before_remove: npm run workspace:before-remove -- --repo owner/repo
```

To run against real Linear and Codex, set `demo.mock_tracker: false`, provide `tracker.api_key: $LINEAR_API_KEY`, set `tracker.project_slug: $LINEAR_PROJECT_SLUG`, and set `agent.runner: codex` or `SYMPHONY_RUNNER=codex`. Add `tracker.assignee: me` or `tracker.assignee: $LINEAR_ASSIGNEE` when this worker should only dispatch issues assigned to one Linear user. The Codex runner launches `codex.command` as a host shell command over JSONL stdio, performs the app-server handshake, starts one thread per worker session, runs up to `agent.max_turns` turns on that thread, streams token/session and dynamic-tool outcome events back into Symphony, and exposes a `linear_graphql` dynamic tool using the configured Linear credentials.

When Codex settings are omitted, the runner uses the reference-safe posture: `codex.approval_policy` defaults to `{"reject":{"sandbox_approval":true,"rules":true,"mcp_elicitations":true}}`; `thread_sandbox: workspace-write`; and a per-turn `workspaceWrite` sandbox policy rooted at the issue workspace. You can still override `codex.approval_policy`, `codex.approvals_reviewer`, `codex.thread_sandbox`, or `codex.turn_sandbox_policy` explicitly in `WORKFLOW.md`. Config validation follows the upstream edge cases for `codex.command`: an empty string is invalid, while a whitespace-only command is preserved for parity with the reference parser. `codex.approval_policy` accepts a string or object, `codex.thread_sandbox` accepts a string, explicit `codex.turn_sandbox_policy` accepts an object, and invalid scalar policy values fail during config resolution. Approval requests are auto-approved only when `codex.approval_policy: never`; tool input prompts receive a fixed non-interactive answer when possible.

The optional SSH worker extension is implemented for the local TanStack service:
`worker.ssh_hosts` and `worker.max_concurrent_agents_per_host` are parsed,
surfaced in snapshots, and used to assign issues to the least-loaded available
host. When a worker host is assigned, Symphony prepares and removes the issue
workspace over SSH, runs workspace hooks remotely, and launches the built-in
Codex app-server runner with `cd <workspace> && exec <codex.command>` over SSH
stdio. Host strings support `host:port` shorthand, and `SYMPHONY_SSH_CONFIG`
adds `ssh -F <config>` for custom SSH config files. For SSH runs, the remote
workspace path preserves the configured `workspace.root` token instead of
normalizing it through the controller machine's filesystem, so POSIX paths such
as `/remote/workspaces` stay POSIX even when the dashboard runs on Windows.

## Production Notes

Run `codex app-server generate-json-schema --experimental --out .tmp/codex-schema` when upgrading Codex CLI so the local adapter can be checked against the installed app-server schema. The simulated runner is intentionally safe for local development; the Codex runner is intended for trusted repositories and should be exercised with your Codex/Linear authentication before unattended use.

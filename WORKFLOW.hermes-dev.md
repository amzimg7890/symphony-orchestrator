---
tracker:
  kind: github
  repo: $GITHUB_REPOSITORY
  gh_command: gh
  assignee: $GITHUB_ASSIGNEE
  required_labels:
    - hermes:dev
  active_states:
    - Open
  terminal_states:
    - Closed
polling:
  interval_ms: 30000
workspace:
  root: ./symphony_workspaces
hooks:
  before_run: npm --prefix ../.. run workspace:ensure-github --
  timeout_ms: 600000
agent:
  runner: codex
  max_concurrent_agents: 1
  max_turns: 3
  max_retry_backoff_ms: 60000
codex:
  command: codex app-server
  approval_policy: never
  turn_sandbox_policy:
    type: dangerFullAccess
  turn_timeout_ms: 3600000
  read_timeout_ms: 60000
  stall_timeout_ms: 300000
logging:
  enabled: true
  root: ./log
  file: symphony-hermes-dev.jsonl
observability:
  dashboard_enabled: true
  refresh_ms: 1000
  render_interval_ms: 16
demo:
  mock_tracker: false
---
# Hermes Dev Stage

You are working on {{ issue.identifier }} in the Hermes dev stage.

GitHub URL: {{ issue.url | default: "not available" }}
State: {{ issue.state }}
Labels: {% for label in issue.labels %}{{ label }}{% unless forloop.last %}, {% endunless %}{% endfor %}

Body:
{{ issue.description | default: "No issue body provided." }}

Before changing code, inspect the current issue comments:

```bash
gh issue view {{ issue.id }} --repo "$GITHUB_REPOSITORY" --comments
```

Use the latest `## Hermes Context`, draft spec, plan, and previous handoff.

Allowed:
- Change product code needed for this stage.
- Add or update focused tests when needed.
- Open or update a pull request.
- Write a GitHub comment with `## Hermes Handoff`.

Forbidden:
- Do not merge.
- Do not approve.
- Do not freeze final spec.
- Do not close the issue.

Finish with a GitHub issue comment:

```md
## Hermes Handoff

stage: dev
status: ready_for_test
next: @hermes.test
spec: <spec path or issue comment URL>
artifacts:
- PR: <pull request URL>
- branch: <branch>
notes:
- <proof of work>
```

If blocked by unclear requirements, set `status: blocked` and `next: @hermes.spec`.

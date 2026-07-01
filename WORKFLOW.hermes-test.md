---
tracker:
  kind: github
  repo: $GITHUB_REPOSITORY
  gh_command: gh
  assignee: $GITHUB_ASSIGNEE
  required_labels:
    - hermes:test
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
  max_turns: 2
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
  file: symphony-hermes-test.jsonl
observability:
  dashboard_enabled: true
  refresh_ms: 1000
  render_interval_ms: 16
demo:
  mock_tracker: false
---
# Hermes Test Stage

You are working on {{ issue.identifier }} in the Hermes test stage.

GitHub URL: {{ issue.url | default: "not available" }}
State: {{ issue.state }}
Labels: {% for label in issue.labels %}{{ label }}{% unless forloop.last %}, {% endunless %}{% endfor %}

Body:
{{ issue.description | default: "No issue body provided." }}

First inspect the issue comments and linked PR:

```bash
gh issue view {{ issue.id }} --repo "$GITHUB_REPOSITORY" --comments
```

Allowed:
- Run the smallest relevant test/check commands.
- Add or fix focused tests.
- Write test evidence.
- Write a GitHub comment with `## Hermes Handoff`.

Forbidden:
- Do not make broad product implementation changes.
- Do not merge.
- Do not approve.
- Do not close the issue.

Finish with a GitHub issue comment:

```md
## Hermes Handoff

stage: test
status: ready_for_review
next: @hermes.review
artifacts:
- PR: <pull request URL>
- test evidence: <commands and result>
notes:
- <risk or coverage notes>
```

If the implementation fails, use `status: failed` and `next: @hermes.dev`.

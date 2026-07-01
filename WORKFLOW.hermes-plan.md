---
tracker:
  kind: github
  repo: $GITHUB_REPOSITORY
  gh_command: gh
  assignee: $GITHUB_ASSIGNEE
  required_labels:
    - hermes:plan
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
  file: symphony-hermes-plan.jsonl
observability:
  dashboard_enabled: true
  refresh_ms: 1000
  render_interval_ms: 16
demo:
  mock_tracker: false
---
# Hermes Plan Stage

You are working on {{ issue.identifier }} in the Hermes plan stage.

GitHub URL: {{ issue.url | default: "not available" }}
State: {{ issue.state }}
Labels: {% for label in issue.labels %}{{ label }}{% unless forloop.last %}, {% endunless %}{% endfor %}

Body:
{{ issue.description | default: "No issue body provided." }}

First inspect the issue comments:

```bash
gh issue view {{ issue.id }} --repo "$GITHUB_REPOSITORY" --comments
```

Allowed:
- Read the draft spec and prior handoffs.
- Write a small implementation plan.
- Create subissues only when the task truly needs them.
- Write a GitHub comment with `## Hermes Handoff`.

Forbidden:
- Do not edit product code.
- Do not merge.
- Do not approve.
- Do not close the issue.

Finish with a GitHub issue comment:

```md
## Hermes Handoff

stage: plan
status: ready_for_dev
next: @hermes.dev
spec: <spec path or issue comment URL>
artifacts:
- plan: <issue comment URL or subissue list>
notes:
- <short plan>
```

If requirements are still unclear, use `status: blocked` and `next: @hermes.spec`.

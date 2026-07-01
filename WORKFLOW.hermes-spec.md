---
tracker:
  kind: github
  repo: $GITHUB_REPOSITORY
  gh_command: gh
  assignee: $GITHUB_ASSIGNEE
  required_labels:
    - hermes:spec
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
  file: symphony-hermes-spec.jsonl
observability:
  dashboard_enabled: true
  refresh_ms: 1000
  render_interval_ms: 16
demo:
  mock_tracker: false
---
# Hermes Spec Stage

You are working on {{ issue.identifier }} in the Hermes spec stage.

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
- Write or update draft spec.
- Freeze final spec only when an owner approval comment exists.
- Write a GitHub comment with `## Hermes Handoff`.

Forbidden:
- Do not edit product code.
- Do not merge.
- Do not approve on behalf of the owner.
- Do not close the issue unless final spec is frozen and the issue is done.

Use `docs/specs/{{ issue.identifier }}.md` as the preferred spec path.

Draft spec minimum sections:
- Problem
- Scope
- Non-goals
- Acceptance
- Open questions

Final spec minimum sections:
- Final behavior
- Acceptance evidence
- Implementation boundary
- Test evidence
- Review report
- Owner decision

Finish with a GitHub issue comment:

```md
## Hermes Handoff

stage: spec
status: ready_for_plan
next: @hermes.plan
spec: docs/specs/{{ issue.identifier }}.md
artifacts:
- spec: docs/specs/{{ issue.identifier }}.md
notes:
- <draft/final status>
```

If this is final spec after owner approval, use `status: done` and `next: @hermes.done`.

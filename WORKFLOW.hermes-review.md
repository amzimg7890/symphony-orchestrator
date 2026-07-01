---
tracker:
  kind: github
  repo: $GITHUB_REPOSITORY
  gh_command: gh
  assignee: $GITHUB_ASSIGNEE
  required_labels:
    - hermes:review
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
  file: symphony-hermes-review.jsonl
observability:
  dashboard_enabled: true
  refresh_ms: 1000
  render_interval_ms: 16
demo:
  mock_tracker: false
---
# Hermes Review Stage

You are working on {{ issue.identifier }} in the Hermes review stage.

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
- Review the PR against the spec and test evidence.
- Create `reports/{{ issue.identifier }}-review.html`.
- Write a concise GitHub comment with the report path and `## Hermes Handoff`.

Forbidden:
- Do not edit product code.
- Do not approve.
- Do not merge.
- Do not close the issue.

The HTML report must include:
- Summary
- Spec coverage
- Changed files
- Test evidence
- Risks
- Findings
- Recommendation: approve or request_changes

Finish with a GitHub issue comment:

```md
## Hermes Handoff

stage: review
status: ready_for_owner
next: @hermes.owner
artifacts:
- review_html: reports/{{ issue.identifier }}-review.html
- PR: <pull request URL>
notes:
- <short recommendation>
```

If changes are required, use `status: changes_requested` and `next: @hermes.dev`.

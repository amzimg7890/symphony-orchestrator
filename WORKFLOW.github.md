---
tracker:
  kind: github
  repo: $GITHUB_REPOSITORY
  gh_command: gh
  assignee: $GITHUB_ASSIGNEE
  required_labels:
    - codex
  active_states:
    - Open
  terminal_states:
    - Closed
polling:
  interval_ms: 30000
workspace:
  root: ./symphony_workspaces
hooks:
  timeout_ms: 60000
agent:
  runner: codex
  max_concurrent_agents: 1
  max_turns: 3
  max_retry_backoff_ms: 60000
codex:
  command: codex app-server
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
logging:
  enabled: true
  root: ./log
  file: symphony-github.jsonl
observability:
  dashboard_enabled: true
  refresh_ms: 1000
  render_interval_ms: 16
demo:
  mock_tracker: false
---
# GitHub Issue

You are working on {{ issue.identifier }}: {{ issue.title }}.

GitHub URL: {{ issue.url | default: "not available" }}
State: {{ issue.state }}
Labels: {% for label in issue.labels %}{{ label }}{% unless forloop.last %}, {% endunless %}{% endfor %}

Use the local GitHub CLI when you need to update the issue:

- Add progress or handoff notes with `gh issue comment`.
- Close the issue with `gh issue close` only after the requested work is complete and verified.

{% if attempt %}
This is attempt {{ attempt }}. Inspect the workspace and continue from the existing state.
{% else %}
This is the first Symphony run for this issue. Read repository guidance, make the change, verify it, and hand off with proof of work.
{% endif %}

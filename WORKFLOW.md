---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: demo-linear-token
  project_slug: symphony-demo
  assignee: $LINEAR_ASSIGNEE
  required_labels:
    - codex
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
polling:
  interval_ms: 5000
workspace:
  root: ./symphony_workspaces
hooks:
  timeout_ms: 60000
agent:
  runner: simulated
  max_concurrent_agents: 3
  max_turns: 3
  max_retry_backoff_ms: 60000
  max_concurrent_agents_by_state:
    todo: 2
    in progress: 1
codex:
  command: codex app-server
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
logging:
  enabled: true
  root: ./log
  file: symphony.jsonl
observability:
  dashboard_enabled: true
  refresh_ms: 1000
  render_interval_ms: 16
demo:
  mock_tracker: true
---
# Linear Issue

You are working on {{ issue.identifier }}: {{ issue.title }}.

State: {{ issue.state }}
Priority: {{ issue.priority | default: "not set" }}
Labels: {% for label in issue.labels %}{{ label }}{% unless forloop.last %}, {% endunless %}{% endfor %}

{% if attempt %}
This is attempt {{ attempt }}. Inspect the workspace, continue from the existing state, and prefer the smallest safe change.
{% else %}
This is the first Symphony run for this issue. Read the repository guidance, make the change, verify it, and hand off with proof of work.
{% endif %}

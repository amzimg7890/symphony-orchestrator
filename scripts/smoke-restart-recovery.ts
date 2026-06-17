import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SymphonyOrchestrator } from '../src/server/symphony/orchestrator'
import type { AgentRunner } from '../src/server/symphony/runner'

const root = process.cwd()

async function main(): Promise<void> {
  const runRoot = path.join(root, '.tmp', `restart-recovery-smoke-${Date.now()}-${process.pid}`)
  const workflowPath = path.join(runRoot, 'WORKFLOW.md')
  const workspaceRoot = path.join(runRoot, 'workspaces')
  const terminalWorkspace = path.join(workspaceRoot, 'DONE-1')
  const activeWorkspace = path.join(workspaceRoot, 'TODO-1')
  const runner = new GuardRunner()
  const orchestrator = new SymphonyOrchestrator(runner)

  try {
    await mkdir(terminalWorkspace, { recursive: true })
    await mkdir(activeWorkspace, { recursive: true })
    await writeFile(path.join(terminalWorkspace, 'sentinel.txt'), 'terminal workspace', 'utf8')
    await writeFile(path.join(activeWorkspace, 'sentinel.txt'), 'active workspace', 'utf8')
    await writeFile(workflowPath, workflowContent(), 'utf8')

    const startSnapshot = await orchestrator.start(workflowPath)
    await orchestrator.stop()

    const terminalWorkspaceRemoved = !(await pathExists(terminalWorkspace))
    const activeWorkspacePreserved = await pathExists(path.join(activeWorkspace, 'sentinel.txt'))
    const startupCleanupEventSeen = startSnapshot.recent_events.some(
      (event) => event.event === 'startup_cleanup_completed',
    )
    const ok =
      terminalWorkspaceRemoved &&
      activeWorkspacePreserved &&
      startupCleanupEventSeen &&
      !runner.invoked

    console.log(
      JSON.stringify(
        {
          ok,
          read_only: true,
          network: false,
          runner_invoked: runner.invoked,
          terminal_workspace_removed: terminalWorkspaceRemoved,
          active_workspace_preserved: activeWorkspacePreserved,
          startup_cleanup_event_seen: startupCleanupEventSeen,
          terminal_issue_identifier: 'DONE-1',
          active_issue_identifier: 'TODO-1',
          workflow_path: workflowPath,
          workspace_root: workspaceRoot,
        },
        null,
        2,
      ),
    )

    if (!ok) {
      process.exitCode = 1
    }
  } finally {
    await orchestrator.stop().catch(() => {})
    await rm(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

class GuardRunner implements AgentRunner {
  invoked = false

  async run(): Promise<void> {
    this.invoked = true
    throw new Error('restart recovery smoke must not invoke the runner')
  }

  async startSession(): Promise<never> {
    this.invoked = true
    throw new Error('restart recovery smoke must not start a runner session')
  }
}

function workflowContent(): string {
  return [
    '---',
    'tracker:',
    '  kind: memory',
    '  required_labels:',
    "    - 'codex'",
    '  active_states:',
    "    - 'Todo'",
    "    - 'In Progress'",
    '  terminal_states:',
    "    - 'Done'",
    "    - 'Closed'",
    "    - 'Cancelled'",
    "    - 'Canceled'",
    "    - 'Duplicate'",
    '  issues:',
    '    - id: terminal-1',
    '      identifier: DONE-1',
    '      title: Terminal issue with stale workspace',
    '      state: Done',
    '      labels:',
    "        - 'codex'",
    '    - id: active-1',
    '      identifier: TODO-1',
    '      title: Active issue whose workspace should remain',
    '      state: Todo',
    '      labels:',
    "        - 'manual'",
    'polling:',
    '  interval_ms: 60000',
    'workspace:',
    "  root: './workspaces'",
    'logging:',
    "  root: './logs'",
    "  file: 'symphony.jsonl'",
    'agent:',
    "  runner: 'simulated'",
    '  max_concurrent_agents: 1',
    '  max_turns: 1',
    'codex:',
    "  command: 'codex app-server'",
    'demo:',
    '  mock_tracker: false',
    '---',
    'Restart recovery smoke for {{ issue.identifier }}.',
    '',
  ].join('\n')
}

async function pathExists(targetPath: string): Promise<boolean> {
  return await stat(targetPath).then(
    () => true,
    () => false,
  )
}

try {
  await main()
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

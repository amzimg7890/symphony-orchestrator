import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const projectRoot = process.cwd()
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'symphony-github-cli-'))

try {
  const gh = await writeFakeGh(tempDir)
  const workflowPath = path.join(tempDir, 'WORKFLOW.github.md')
  const logFile = path.join(tempDir, 'log', 'symphony-github-smoke.jsonl')

  await writeFile(
    workflowPath,
    [
      '---',
      'tracker:',
      '  kind: github',
      '  repo: owner/repo',
      `  gh_command: '${yamlSingleQuoted(gh.command)}'`,
      '  assignee: me',
      '  required_labels:',
      '    - codex',
      '  active_states:',
      '    - Open',
      '  terminal_states:',
      '    - Closed',
      'polling:',
      '  interval_ms: 10000',
      'workspace:',
      `  root: '${yamlSingleQuoted(path.join(tempDir, 'workspaces'))}'`,
      'agent:',
      '  runner: simulated',
      '  max_turns: 1',
      'demo:',
      '  mock_tracker: false',
      'logging:',
      `  root: '${yamlSingleQuoted(path.join(tempDir, 'log'))}'`,
      '  file: symphony-github-smoke.jsonl',
      '---',
      'Handle {{ issue.identifier }} from GitHub.',
    ].join('\n'),
    'utf8',
  )

  const result = await runCli([workflowPath, '--run-for-ms', '2500'])
  assert(result.exitCode === 0, `GitHub CLI smoke exited ${result.exitCode}\n${result.stderr}`)
  assert(result.stdout.includes('Stopping automatically after 2500ms.'), 'CLI did not report bounded runtime')

  const ghCalls = (await readFile(gh.callsPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Array<string>)
  assert(ghCalls.some((args) => args[0] === 'api' && args[1] === 'user'), 'fake gh did not receive viewer lookup')
  assert(ghCalls.some((args) => args[0] === 'issue' && args[1] === 'list' && args.includes('open')), 'fake gh did not receive open issue list')
  assert(ghCalls.some((args) => args[0] === 'issue' && args[1] === 'view' && args.includes('42')), 'fake gh did not receive issue refresh')

  const logs = (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event?: string; issue_identifier?: string })
  assert(logs.some((entry) => entry.event === 'poll_completed'), 'runtime log did not record poll completion')
  assert(logs.some((entry) => entry.event === 'turn_completed' && entry.issue_identifier === 'GH-42'), 'runtime log did not record the GitHub issue turn')
  assert(logs.some((entry) => entry.event === 'terminal_cleanup_scheduled' && entry.issue_identifier === 'GH-42'), 'runtime log did not record terminal cleanup')
  assert(logs.some((entry) => entry.event === 'worker_completed' && entry.issue_identifier === 'GH-42'), 'runtime log did not record worker completion')

  console.log(
    JSON.stringify(
      {
        ok: true,
        workflow_path: workflowPath,
        issue_identifier: 'GH-42',
        gh_call_count: ghCalls.length,
        log_event_count: logs.length,
      },
      null,
      2,
    ),
  )
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

async function writeFakeGh(dir: string): Promise<{ command: string; callsPath: string }> {
  const callsPath = path.join(dir, 'fake-gh-calls.jsonl')
  const fakeGhModule = path.join(dir, 'fake-gh.mjs')
  await writeFile(
    fakeGhModule,
    [
      "import { appendFileSync } from 'node:fs'",
      `const callsPath = ${JSON.stringify(callsPath)}`,
      "const args = process.argv.slice(2)",
      "appendFileSync(callsPath, `${JSON.stringify(args)}\\n`)",
      "const writeJson = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`)",
      "const issue = (state) => ({ number: 42, title: 'Implement checkout flow', body: 'Use the local GitHub tracker.', state, url: 'https://github.test/owner/repo/issues/42', labels: [{ name: 'codex' }], assignees: [{ login: 'amzimg7890' }], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' })",
      "if (args[0] === 'api' && args[1] === 'user') { process.stdout.write('amzimg7890\\n'); process.exit(0) }",
      "if (args[0] === 'issue' && args[1] === 'list') {",
      "  const state = args[args.indexOf('--state') + 1]",
      "  writeJson(state === 'open' ? [issue('OPEN')] : [])",
      "  process.exit(0)",
      "}",
      "if (args[0] === 'issue' && args[1] === 'view' && args[2] === '42') { writeJson(issue('CLOSED')); process.exit(0) }",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`)",
      'process.exit(1)',
      '',
    ].join('\n'),
    'utf8',
  )

  const shPath = path.join(dir, 'gh')
  await writeFile(shPath, `#!/bin/sh\nexec "${process.execPath}" "${fakeGhModule}" "$@"\n`, 'utf8')
  await chmod(shPath, 0o755)

  return {
    command: `"${process.execPath.replaceAll('\\', '/')}" "${fakeGhModule.replaceAll('\\', '/')}"`,
    callsPath,
  }
}

async function runCli(args: Array<string>): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const cliPath = path.join(projectRoot, 'src', 'cli.ts')
  const child = spawn(process.execPath, [tsxCli, cliPath, ...args], {
    cwd: projectRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`GitHub CLI runtime smoke timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 15_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (exitCode) => {
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr })
    })
  })
}

function yamlSingleQuoted(value: string): string {
  return value.replaceAll("'", "''")
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

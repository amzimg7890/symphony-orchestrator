import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const projectRoot = path.resolve('.')
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const checkScript = path.join(projectRoot, 'scripts', 'check-github-workflow.ts')

let cleanupDirs: Array<string> = []

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('GitHub workflow check script', () => {
  it('rejects non-GitHub workflows before calling gh', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-check-github-invalid-'))
    cleanupDirs.push(dir)
    const workflowPath = path.join(dir, 'WORKFLOW.md')
    await writeFile(
      workflowPath,
      [
        '---',
        'tracker:',
        '  kind: memory',
        'agent:',
        '  runner: codex',
        'demo:',
        '  mock_tracker: false',
        '---',
        'Invalid github workflow.',
      ].join('\n'),
      'utf8',
    )

    const result = await runCheck({
      args: ['--workflow', workflowPath, '--dotenv', path.join(dir, 'missing.env')],
      env: (await fakeGh(dir)).env,
    })

    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      errors: [{ code: 'not_github_tracker' }],
    })
  })

  it('uses gh to read GitHub candidates without mutating issues', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-check-github-'))
    cleanupDirs.push(dir)
    const workflowPath = path.join(dir, 'WORKFLOW.github.md')
    const gh = await fakeGh(dir)
    await writeFile(
      workflowPath,
      [
        '---',
        'tracker:',
        '  kind: github',
        '  repo: owner/repo',
        `  gh_command: '${yamlSingleQuoted(gh.command)}'`,
        '  required_labels:',
        '    - codex',
        '  assignee: me',
        '  active_states:',
        '    - Open',
        '  terminal_states:',
        '    - Closed',
        'agent:',
        '  runner: codex',
        'demo:',
        '  mock_tracker: false',
        '---',
        'Check GitHub workflow.',
      ].join('\n'),
      'utf8',
    )

    const result = await runCheck({
      args: ['--workflow', workflowPath, '--dotenv', path.join(dir, 'missing.env')],
      env: gh.env,
    })

    if (result.exitCode !== 0) {
      throw new Error(`check-github-workflow exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }

    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      read_only: true,
      tracker: {
        kind: 'github',
        repository: 'owner/repo',
        repository_source: 'workflow',
        required_labels: ['codex'],
        active_states: ['Open'],
        terminal_states: ['Closed'],
        assignee: 'me',
      },
      runner: 'codex',
      mock_tracker: false,
      github: {
        active_issue_count: 1,
        eligible_candidate_count: 1,
        terminal_issue_count: 1,
        candidate_issue_identifiers: ['GH-10'],
      },
      ready_for_existing_issue_run: true,
    })
  })
})

async function fakeGh(dir: string): Promise<{ command: string; env: Record<string, string> }> {
  const fakeGhModule = path.join(dir, 'fake-gh.mjs')
  await writeFile(
    fakeGhModule,
    [
      "const args = process.argv.slice(2)",
      "const writeJson = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`)",
      "if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write('logged in\\n'); process.exit(0) }",
      "if (args[0] === 'api' && args[1] === 'user') { process.stdout.write('amzimg\\n'); process.exit(0) }",
      "if (args[0] === 'repo' && args[1] === 'view') { writeJson({ nameWithOwner: 'owner/repo' }); process.exit(0) }",
      "if (args[0] === 'issue' && args[1] === 'list') {",
      "  const state = args[args.indexOf('--state') + 1]",
      "  if (state === 'closed') {",
      "    writeJson([{ number: 12, title: 'Closed issue', body: null, state: 'CLOSED', url: 'https://github.test/owner/repo/issues/12', labels: [{ name: 'codex' }], assignees: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' }])",
      "    process.exit(0)",
      "  }",
      "  writeJson([",
      "    { number: 10, title: 'First issue', body: 'Body', state: 'OPEN', url: 'https://github.test/owner/repo/issues/10', labels: [{ name: 'codex' }], assignees: [{ login: 'amzimg' }], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },",
      "    { number: 11, title: 'Second issue', body: 'Body', state: 'OPEN', url: 'https://github.test/owner/repo/issues/11', labels: [{ name: 'codex' }, { name: 'backend' }], assignees: [{ login: 'someone-else' }], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' }",
      "  ])",
      "  process.exit(0)",
      "}",
      "process.stderr.write(`unexpected gh args: ${args.join(' ')}\\n`)",
      'process.exit(1)',
      '',
    ].join('\n'),
    'utf8',
  )

  const cmdPath = path.join(dir, 'gh.cmd')
  await writeFile(cmdPath, `@echo off\r\n"${process.execPath}" "${fakeGhModule}" %*\r\n`, 'utf8')

  const shPath = path.join(dir, 'gh')
  await writeFile(shPath, `#!/bin/sh\nexec "${process.execPath}" "${fakeGhModule}" "$@"\n`, 'utf8')
  await chmod(shPath, 0o755)

  const pathValue = `${dir}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`
  return {
    command: `${process.execPath.replaceAll('\\', '/')} ${fakeGhModule.replaceAll('\\', '/')}`,
    env: {
      PATH: pathValue,
      Path: pathValue,
    },
  }
}

function yamlSingleQuoted(value: string): string {
  return value.replaceAll("'", "''")
}

async function runCheck(input: {
  args: Array<string>
  env: Record<string, string>
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [tsxCli, checkScript, ...input.args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...input.env,
    },
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
      reject(new Error(`check-github-workflow timed out: ${stderr || stdout}`))
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

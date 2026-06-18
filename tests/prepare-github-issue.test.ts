import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const projectRoot = path.resolve('.')
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const prepareScript = path.join(projectRoot, 'scripts', 'prepare-github-issue.ts')

let cleanupDirs: Array<string> = []

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('GitHub issue preparation script', () => {
  it('defaults to a read-only dry run with a create command suggestion', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-prepare-github-dry-'))
    cleanupDirs.push(dir)
    const gh = await fakeGh(dir, { labels: [], candidates: [] })
    const workflowPath = await writeWorkflow(dir, gh.command)

    const result = await runPrepare({
      args: ['--workflow', workflowPath, '--dotenv', path.join(dir, 'missing.env')],
      env: gh.env,
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout)
    expect(payload).toMatchObject({
      ok: true,
      dry_run: true,
      repository: 'owner/repo',
      required_labels: ['codex'],
      missing_labels: ['codex'],
      eligible_candidate_count: 0,
    })
    expect(payload.create_command).toContain('issue create')
    expect(payload.create_command).toContain('--label codex')

    const calls = await readCalls(gh.callsPath)
    expect(calls.some((args) => args[0] === 'issue' && args[1] === 'create')).toBe(false)
    expect(calls.some((args) => args[0] === 'label' && args[1] === 'create')).toBe(false)
  })

  it('creates missing labels and a candidate issue when explicitly requested', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-prepare-github-create-'))
    cleanupDirs.push(dir)
    const gh = await fakeGh(dir, { labels: [], candidates: [] })
    const workflowPath = await writeWorkflow(dir, gh.command)

    const result = await runPrepare({
      args: [
        '--workflow',
        workflowPath,
        '--dotenv',
        path.join(dir, 'missing.env'),
        '--create',
        '--create-labels',
        '--title',
        'Run Symphony',
      ],
      env: gh.env,
    })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      dry_run: false,
      repository: 'owner/repo',
      created_issue_url: 'https://github.test/owner/repo/issues/44',
      created_labels: ['codex'],
    })

    const calls = await readCalls(gh.callsPath)
    expect(calls).toContainEqual([
      'label',
      'create',
      'codex',
      '--repo',
      'owner/repo',
      '--color',
      '0E8A16',
      '--description',
      'Issues eligible for Symphony automation',
    ])
    expect(calls.some((args) => args[0] === 'issue' && args[1] === 'create' && args.includes('Run Symphony'))).toBe(true)
  })
})

async function writeWorkflow(dir: string, ghCommand: string): Promise<string> {
  const workflowPath = path.join(dir, 'WORKFLOW.github.md')
  await writeFile(
    workflowPath,
    [
      '---',
      'tracker:',
      '  kind: github',
      '  repo: owner/repo',
      `  gh_command: '${yamlSingleQuoted(ghCommand)}'`,
      '  assignee: me',
      '  required_labels:',
      '    - codex',
      'agent:',
      '  runner: codex',
      'demo:',
      '  mock_tracker: false',
      '---',
      'Prepare GitHub issue.',
    ].join('\n'),
    'utf8',
  )
  return workflowPath
}

async function fakeGh(
  dir: string,
  options: { labels: Array<string>; candidates: Array<number> },
): Promise<{ command: string; env: Record<string, string>; callsPath: string }> {
  const callsPath = path.join(dir, 'fake-gh-calls.jsonl')
  const fakeGhModule = path.join(dir, 'fake-gh.mjs')
  await writeFile(
    fakeGhModule,
    [
      "import { appendFileSync } from 'node:fs'",
      `const callsPath = ${JSON.stringify(callsPath)}`,
      `const labels = ${JSON.stringify(options.labels)}`,
      `const candidates = ${JSON.stringify(options.candidates)}`,
      "const args = process.argv.slice(2)",
      "appendFileSync(callsPath, `${JSON.stringify(args)}\\n`)",
      "const writeJson = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`)",
      "if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write('logged in\\n'); process.exit(0) }",
      "if (args[0] === 'api' && args[1] === 'user') { process.stdout.write('amzimg7890\\n'); process.exit(0) }",
      "if (args[0] === 'label' && args[1] === 'list') { writeJson(labels.map((name) => ({ name }))); process.exit(0) }",
      "if (args[0] === 'label' && args[1] === 'create') { process.stdout.write('created label\\n'); process.exit(0) }",
      "if (args[0] === 'issue' && args[1] === 'list') { writeJson(candidates.map((number) => ({ number, title: `Issue ${number}`, body: 'Body', state: 'OPEN', url: `https://github.test/owner/repo/issues/${number}`, labels: [{ name: 'codex' }], assignees: [{ login: 'amzimg7890' }], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' }))); process.exit(0) }",
      "if (args[0] === 'issue' && args[1] === 'create') { process.stdout.write('https://github.test/owner/repo/issues/44\\n'); process.exit(0) }",
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
    callsPath,
  }
}

async function readCalls(callsPath: string): Promise<Array<Array<string>>> {
  return (await readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Array<string>)
}

function yamlSingleQuoted(value: string): string {
  return value.replaceAll("'", "''")
}

async function runPrepare(input: {
  args: Array<string>
  env: Record<string, string>
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [tsxCli, prepareScript, ...input.args], {
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
      reject(new Error(`prepare-github-issue timed out: ${stderr || stdout}`))
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

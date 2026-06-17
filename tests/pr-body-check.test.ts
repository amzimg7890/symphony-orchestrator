import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkPullRequestBody, lintPullRequestBody } from '../src/server/symphony/prBodyCheck'

const template = `#### Context

<!-- Why is this change needed? -->

#### TL;DR

*<!-- A short summary -->*

#### Summary

- <!-- Summary bullet -->

#### Alternatives

- <!-- Alternative bullet -->

#### Test Plan

- [ ] <!-- Test checkbox -->
`

const validBody = `#### Context

Context text.

#### TL;DR

Short summary.

#### Summary

- First change.

#### Alternatives

- Alternative considered.

#### Test Plan

- [x] Ran targeted checks.
`

describe('PR body checker', () => {
  it('passes for a body that follows the pull request template', () => {
    expect(lintPullRequestBody(template, validBody)).toEqual([])
  })

  it('fails when required headings are missing or out of order', () => {
    const body = `#### TL;DR

Short summary.

#### Context

Context text.
`

    expect(lintPullRequestBody(template, body)).toEqual(
      expect.arrayContaining([
        'Missing required heading: #### Summary',
        'Missing required heading: #### Alternatives',
        'Missing required heading: #### Test Plan',
        'Required headings are out of order.',
      ]),
    )
  })

  it('rejects placeholder comments, empty sections, missing bullets, and missing checkboxes', () => {
    const body = `#### Context

<!-- still placeholder -->

#### TL;DR

Short summary.

#### Summary

Not a bullet.

#### Alternatives


#### Test Plan

No checkbox.
`

    expect(lintPullRequestBody(template, body)).toEqual(
      expect.arrayContaining([
        'PR description still contains template placeholder comments (<!-- ... -->).',
        'Section must include at least one bullet item: #### Summary',
        'Section cannot be empty: #### Alternatives',
        'Section must include at least one bullet item: #### Test Plan',
        'Section must include at least one checkbox item: #### Test Plan',
      ]),
    )
  })

  it('loads the repository template and body from disk', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-pr-body-check-'))
    try {
      await mkdir(path.join(dir, '.github'))
      await writeFile(path.join(dir, '.github', 'pull_request_template.md'), template, 'utf8')
      await writeFile(path.join(dir, 'body.md'), validBody, 'utf8')

      await expect(checkPullRequestBody('body.md', { cwd: dir })).resolves.toMatchObject({
        ok: true,
        template_path: path.join(dir, '.github', 'pull_request_template.md'),
      })
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('reports missing templates and unreadable body files as validation failures', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-pr-body-missing-'))
    try {
      await expect(checkPullRequestBody('missing.md', { cwd: dir })).resolves.toMatchObject({
        ok: false,
        template_path: null,
        errors: [expect.stringContaining('Unable to read PR template')],
      })

      await mkdir(path.join(dir, '.github'))
      await writeFile(path.join(dir, '.github', 'pull_request_template.md'), template, 'utf8')

      await expect(checkPullRequestBody('missing.md', { cwd: dir })).resolves.toMatchObject({
        ok: false,
        template_path: path.join(dir, '.github', 'pull_request_template.md'),
        errors: [expect.stringContaining('Unable to read missing.md')],
      })
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})

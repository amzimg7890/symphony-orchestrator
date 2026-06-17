import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderIssuePrompt } from '../src/server/symphony/prompt'
import type { Issue, WorkflowDefinition } from '../src/server/symphony/types'

describe('prompt rendering', () => {
  it('uses the reference-style fallback prompt when the workflow prompt body is empty', async () => {
    await expect(renderIssuePrompt(workflowFixture('   '), issueFixture(), null)).resolves.toBe(
      [
        'You are working on a Linear issue.',
        '',
        'Identifier: SYM-1',
        'Title: Prompt rendering test',
        '',
        'Body:',
        '',
        'No description provided.',
        '',
      ].join('\n'),
    )
  })

  it('includes issue descriptions in the fallback prompt', async () => {
    await expect(
      renderIssuePrompt(
        workflowFixture(''),
        {
          ...issueFixture(),
          description: 'The issue body explains the requested work.',
        },
        null,
      ),
    ).resolves.toContain('The issue body explains the requested work.')
  })

  it('renders attempt metadata and nested issue collections in workflow prompts', async () => {
    const prompt = await renderIssuePrompt(
      workflowFixture(
        [
          'Attempt {{ attempt }} for {{ issue.identifier }}',
          'Labels:{% for label in issue.labels %} {{ label }}{% endfor %}',
          'Blockers:{% for blocker in issue.blocked_by %} {{ blocker.identifier }}={{ blocker.state }}{% endfor %}',
        ].join('\n'),
      ),
      {
        ...issueFixture(),
        labels: ['codex', 'automation'],
        blocked_by: [
          {
            id: 'blocker-1',
            identifier: 'SYM-0',
            state: 'Done',
            created_at: '2025-12-31T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      3,
    )

    expect(prompt).toBe(
      [
        'Attempt 3 for SYM-1',
        'Labels: codex automation',
        'Blockers: SYM-0=Done',
      ].join('\n'),
    )
  })

  it('exposes first-run attempts as null to workflow prompts', async () => {
    await expect(
      renderIssuePrompt(
        workflowFixture('{% if attempt == nil %}first run{% else %}retry {{ attempt }}{% endif %}'),
        issueFixture(),
        null,
      ),
    ).resolves.toBe('first run')
  })

  it('surfaces unknown Liquid variables as template render errors', async () => {
    await expect(
      renderIssuePrompt(workflowFixture('Work on {{ issue.unknown_field }}.'), issueFixture(), null),
    ).rejects.toMatchObject({
      code: 'template_render_error',
      message: 'Issue prompt could not be rendered',
    })
  })

  it('surfaces unknown Liquid filters as template render errors', async () => {
    await expect(
      renderIssuePrompt(workflowFixture('Work on {{ issue.identifier | missing_filter }}.'), issueFixture(), null),
    ).rejects.toMatchObject({
      code: 'template_render_error',
      message: 'Issue prompt could not be rendered',
    })
  })

  it('surfaces invalid Liquid syntax as template parse errors', async () => {
    await expect(
      renderIssuePrompt(workflowFixture('{% if issue.identifier %}Unclosed block'), issueFixture(), null),
    ).rejects.toMatchObject({
      code: 'template_parse_error',
      message: 'Issue prompt could not be parsed',
    })
  })
})

function workflowFixture(promptTemplate: string): WorkflowDefinition {
  return {
    path: path.resolve('WORKFLOW.md'),
    directory: process.cwd(),
    config: {},
    prompt_template: promptTemplate,
  }
}

function issueFixture(): Issue {
  return {
    id: 'issue-1',
    identifier: 'SYM-1',
    title: 'Prompt rendering test',
    description: null,
    priority: 1,
    state: 'Todo',
    branch_name: null,
    url: null,
    assignee_id: 'worker',
    assigned_to_worker: true,
    labels: ['codex'],
    blocked_by: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

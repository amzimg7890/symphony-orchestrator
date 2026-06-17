import { Liquid } from 'liquidjs'
import { SymphonyError } from './errors'
import type { Issue, WorkflowDefinition } from './types'

const DEFAULT_PROMPT = [
  'You are working on a Linear issue.',
  '',
  'Identifier: {{ issue.identifier }}',
  'Title: {{ issue.title }}',
  '',
  'Body:',
  '{% if issue.description %}',
  '{{ issue.description }}',
  '{% else %}',
  'No description provided.',
  '{% endif %}',
].join('\n')

export async function renderIssuePrompt(
  workflow: WorkflowDefinition,
  issue: Issue,
  attempt: number | null,
): Promise<string> {
  const template = workflow.prompt_template.trim() || DEFAULT_PROMPT
  const engine = new Liquid({
    strictFilters: true,
    strictVariables: true,
  })

  let parsed: ReturnType<Liquid['parse']>
  try {
    parsed = engine.parse(template)
  } catch (error) {
    if (isUnknownFilterError(error)) {
      throw new SymphonyError('template_render_error', `Issue prompt could not be rendered`, {
        cause: error,
      })
    }

    throw new SymphonyError('template_parse_error', `Issue prompt could not be parsed`, {
      cause: error,
    })
  }

  try {
    return await engine.render(parsed, {
      issue,
      attempt,
    })
  } catch (error) {
    throw new SymphonyError('template_render_error', `Issue prompt could not be rendered`, {
      cause: error,
    })
  }
}

function isUnknownFilterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\bundefined filter\b/i.test(message)
}

export function renderContinuationPrompt(
  issue: Issue,
  attempt: number | null,
  turnNumber: number,
): string {
  return [
    `Continue working on Linear issue ${issue.identifier}: ${issue.title}.`,
    `This is turn ${turnNumber} in the same Symphony worker session.`,
    attempt === null
      ? 'This is still the first Symphony run attempt for the issue.'
      : `This is retry attempt ${attempt}; continue from the existing workspace state.`,
    `Current tracker state: ${issue.state}.`,
    'Do not repeat the original task prompt or redo completed investigation unless the workspace or tracker state requires it.',
    'Inspect the current workspace state, continue from the prior turn, and stop only when the workflow handoff or a true blocker is reached.',
  ].join('\n')
}

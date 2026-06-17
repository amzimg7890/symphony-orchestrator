import { readFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { SymphonyError } from './errors'
import type { WorkflowDefinition } from './types'

export async function loadWorkflow(filePath = path.join(process.cwd(), 'WORKFLOW.md')): Promise<WorkflowDefinition> {
  const resolvedPath = path.resolve(filePath)

  let contents: string
  try {
    contents = await readFile(resolvedPath, 'utf8')
  } catch (error) {
    throw new SymphonyError(
      'missing_workflow_file',
      `Unable to read workflow file at ${resolvedPath}`,
      { cause: error },
    )
  }

  return parseWorkflow(contents, resolvedPath)
}

export function parseWorkflow(contents: string, filePath: string): WorkflowDefinition {
  const normalized = contents.replace(/^\uFEFF/, '')
  const directory = path.dirname(path.resolve(filePath))

  if (!normalized.startsWith('---')) {
    return {
      path: path.resolve(filePath),
      directory,
      config: {},
      prompt_template: normalized.trim(),
    }
  }

  const lines = normalized.split(/\r?\n/)
  let closingIndex = -1

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') {
      closingIndex = index
      break
    }
  }

  const frontMatterLines = closingIndex === -1 ? lines.slice(1) : lines.slice(1, closingIndex)
  const promptLines = closingIndex === -1 ? [] : lines.slice(closingIndex + 1)
  const frontMatter = frontMatterLines.join('\n')
  const prompt = promptLines.join('\n').trim()

  let parsed: unknown
  try {
    parsed = frontMatter.trim() ? YAML.parse(frontMatter) : {}
  } catch (error) {
    throw new SymphonyError('workflow_parse_error', `Workflow YAML could not be parsed`, {
      cause: error,
    })
  }

  if (!isRecord(parsed)) {
    throw new SymphonyError(
      'workflow_front_matter_not_a_map',
      `Workflow front matter must decode to a map/object`,
    )
  }

  return {
    path: path.resolve(filePath),
    directory,
    config: parsed,
    prompt_template: prompt,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

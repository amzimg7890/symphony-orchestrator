import { readFile } from 'node:fs/promises'
import path from 'node:path'

export type PrBodyCheckResult =
  | {
      ok: true
      template_path: string
    }
  | {
      ok: false
      template_path: string | null
      errors: Array<string>
    }

export type PrBodyCheckOptions = {
  cwd?: string
  template_paths?: Array<string>
}

const defaultTemplatePaths = ['.github/pull_request_template.md', '../.github/pull_request_template.md']
const markdownHeadingPattern = /^#{4,6}\s+.+$/gm

export async function checkPullRequestBody(
  bodyPath: string,
  options: PrBodyCheckOptions = {},
): Promise<PrBodyCheckResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const template = await readPullRequestTemplate(cwd, options.template_paths ?? defaultTemplatePaths)
  if (!template.ok) {
    return template
  }

  let body: string
  try {
    body = await readFile(path.resolve(cwd, bodyPath), 'utf8')
  } catch (error) {
    return {
      ok: false,
      template_path: template.template_path,
      errors: [`Unable to read ${bodyPath}: ${errorMessage(error)}`],
    }
  }

  const errors = lintPullRequestBody(template.template, body, template.template_path)
  return errors.length === 0
    ? { ok: true, template_path: template.template_path }
    : { ok: false, template_path: template.template_path, errors }
}

export function lintPullRequestBody(template: string, body: string, templatePath = 'PR template'): Array<string> {
  const headings = extractTemplateHeadings(template)
  if (headings.length === 0) {
    return [`No markdown headings found in ${templatePath}`]
  }

  return [
    ...missingHeadingErrors(body, headings),
    ...headingOrderErrors(body, headings),
    ...placeholderErrors(body),
    ...sectionErrors(template, body, headings),
  ]
}

async function readPullRequestTemplate(
  cwd: string,
  templatePaths: Array<string>,
): Promise<
  | {
      ok: true
      template_path: string
      template: string
    }
  | {
      ok: false
      template_path: null
      errors: Array<string>
    }
> {
  for (const candidate of templatePaths) {
    const templatePath = path.resolve(cwd, candidate)
    try {
      return {
        ok: true,
        template_path: templatePath,
        template: await readFile(templatePath, 'utf8'),
      }
    } catch {
      // Try the next candidate.
    }
  }

  return {
    ok: false,
    template_path: null,
    errors: [`Unable to read PR template from any of: ${templatePaths.join(', ')}`],
  }
}

function extractTemplateHeadings(template: string): Array<string> {
  return Array.from(template.matchAll(markdownHeadingPattern), (match) => match[0])
}

function missingHeadingErrors(body: string, headings: Array<string>): Array<string> {
  return headings
    .filter((heading) => !body.includes(heading))
    .map((heading) => `Missing required heading: ${heading}`)
}

function headingOrderErrors(body: string, headings: Array<string>): Array<string> {
  const positions = headings
    .map((heading) => body.indexOf(heading))
    .filter((position) => position >= 0)

  return positions.every((position, index) => index === 0 || position >= positions[index - 1]!)
    ? []
    : ['Required headings are out of order.']
}

function placeholderErrors(body: string): Array<string> {
  return body.includes('<!--')
    ? ['PR description still contains template placeholder comments (<!-- ... -->).']
    : []
}

function sectionErrors(template: string, body: string, headings: Array<string>): Array<string> {
  const errors: Array<string> = []
  for (const heading of headings) {
    const templateSection = captureHeadingSection(template, heading, headings)
    const bodySection = captureHeadingSection(body, heading, headings)
    if (bodySection === null) {
      continue
    }

    if (bodySection.trim() === '') {
      errors.push(`Section cannot be empty: ${heading}`)
      continue
    }

    if (templateSection && /^- /m.test(templateSection) && !/^- /m.test(bodySection)) {
      errors.push(`Section must include at least one bullet item: ${heading}`)
    }

    if (templateSection && /^- \[ \] /m.test(templateSection) && !/^- \[[ xX]\] /m.test(bodySection)) {
      errors.push(`Section must include at least one checkbox item: ${heading}`)
    }
  }

  return errors
}

function captureHeadingSection(doc: string, heading: string, headings: Array<string>): string | null {
  const headingIndex = doc.indexOf(heading)
  if (headingIndex < 0) {
    return null
  }

  const sectionStart = headingIndex + heading.length
  if (sectionStart + 2 > doc.length) {
    return ''
  }

  if (doc.slice(sectionStart, sectionStart + 2) !== '\n\n') {
    return null
  }

  const contentStart = sectionStart + 2
  const content = doc.slice(contentStart)
  const nextOffsets = headings
    .filter((candidate) => candidate !== heading)
    .map((candidate) => content.indexOf(`\n${candidate}`))
    .filter((index) => index >= 0)

  return nextOffsets.length === 0 ? content : content.slice(0, Math.min(...nextOffsets))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

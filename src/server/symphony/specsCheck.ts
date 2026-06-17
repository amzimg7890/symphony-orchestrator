import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

export type SpecsCheckFinding = {
  file: string
  name: string
  line: number
}

export type SpecsCheckOptions = {
  exemptions?: Array<string>
}

const sourceExtensions = new Set(['.ts', '.tsx'])

export async function missingExportedReturnTypes(
  paths: Array<string>,
  options: SpecsCheckOptions = {},
): Promise<Array<SpecsCheckFinding>> {
  const exemptions = new Set(options.exemptions ?? [])
  const files = (await Promise.all(paths.map((scanPath) => collectSourceFiles(scanPath))))
    .flat()
    .sort((a, b) => a.localeCompare(b))

  const findings = (
    await Promise.all(files.map((file) => fileFindings(file, exemptions)))
  )
    .flat()
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name))

  return findings
}

export function specsFindingIdentifier(finding: SpecsCheckFinding): string {
  return `${finding.file}:${finding.name}`
}

async function collectSourceFiles(inputPath: string): Promise<Array<string>> {
  const stats = await stat(inputPath).catch(() => null)
  if (!stats) {
    return []
  }

  if (stats.isFile()) {
    return isSourceFile(inputPath) ? [inputPath] : []
  }

  if (!stats.isDirectory()) {
    return []
  }

  const entries = await readdir(inputPath, { withFileTypes: true })
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== '.output')
      .map((entry) => collectSourceFiles(path.join(inputPath, entry.name))),
  )

  return nested.flat()
}

async function fileFindings(file: string, exemptions: Set<string>): Promise<Array<SpecsCheckFinding>> {
  const source = await readFile(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindForFile(file))
  const findings: Array<SpecsCheckFinding> = []

  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !isExported(statement) || statement.type) {
      continue
    }

    const name = statement.name?.text ?? 'default'
    const finding: SpecsCheckFinding = {
      file,
      name,
      line: sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1,
    }

    if (!exemptions.has(specsFindingIdentifier(finding))) {
      findings.push(finding)
    }
  }

  return findings
}

function isExported(node: ts.Node): boolean {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  )
}

function isSourceFile(file: string): boolean {
  return sourceExtensions.has(path.extname(file)) && !file.endsWith('.d.ts')
}

function scriptKindForFile(file: string): ts.ScriptKind {
  return path.extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

import { readFile } from 'node:fs/promises'
import { missingExportedReturnTypes, specsFindingIdentifier } from '../src/server/symphony/specsCheck'

const usage = `Usage: npm run specs:check -- [--paths PATH] [--exemptions-file FILE]

Fails when exported TypeScript functions are missing explicit return types.`

const parsed = parseArgs(process.argv.slice(2))
if (!parsed.ok) {
  console.error(parsed.error)
  console.error(usage)
  process.exit(1)
}

if (parsed.help) {
  console.log(usage)
  process.exit(0)
}

const exemptions = parsed.exemptionsFile ? await loadExemptions(parsed.exemptionsFile) : []
const findings = await missingExportedReturnTypes(parsed.paths, { exemptions })

if (findings.length === 0) {
  console.log('specs.check: all exported functions have explicit return types or exemptions')
} else {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} missing return type for ${specsFindingIdentifier(finding)}`)
  }
  console.error(`specs.check failed with ${findings.length} missing return type declaration(s)`)
  process.exitCode = 1
}

async function loadExemptions(filePath: string): Promise<Array<string>> {
  const contents = await readFile(filePath, 'utf8').catch(() => '')
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

function parseArgs(args: Array<string>):
  | {
      ok: true
      help: boolean
      paths: Array<string>
      exemptionsFile: string | null
    }
  | {
      ok: false
      error: string
    } {
  const paths: Array<string> = []
  let exemptionsFile: string | null = null

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      return { ok: true, help: true, paths: ['src/server/symphony'], exemptionsFile }
    }

    if (arg === '--paths' || arg === '--exemptions-file') {
      const value = args[index + 1]
      if (!value) {
        return { ok: false, error: `Missing value for ${arg}` }
      }

      if (arg === '--paths') {
        paths.push(value)
      } else {
        exemptionsFile = value
      }
      index += 1
      continue
    }

    if (arg.startsWith('--paths=')) {
      paths.push(arg.slice('--paths='.length))
      continue
    }

    if (arg.startsWith('--exemptions-file=')) {
      exemptionsFile = arg.slice('--exemptions-file='.length)
      continue
    }

    return { ok: false, error: `Invalid option: ${arg}` }
  }

  return {
    ok: true,
    help: false,
    paths: paths.length === 0 ? ['src/server/symphony'] : paths,
    exemptionsFile,
  }
}

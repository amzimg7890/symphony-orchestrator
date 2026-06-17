import { checkPullRequestBody } from '../src/server/symphony/prBodyCheck'

const usage = `Usage: npm run pr-body:check -- --file <pr_body.md>

Validate a PR description markdown file against .github/pull_request_template.md.`

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(usage)
  process.exit(0)
}

const invalid = args.filter((arg) => arg.startsWith('-') && arg !== '--file')
if (invalid.length > 0) {
  console.error(`Invalid option(s): ${invalid.join(', ')}`)
  console.error(usage)
  process.exit(1)
}

const fileIndex = args.indexOf('--file')
const filePath = fileIndex >= 0 ? args[fileIndex + 1] : null
if (!filePath) {
  console.error('Missing required option --file')
  console.error(usage)
  process.exit(1)
}

const result = await checkPullRequestBody(filePath)
if (result.ok) {
  console.log('PR body format OK')
} else {
  for (const error of result.errors) {
    console.error(`ERROR: ${error}`)
  }
  const templatePath = result.template_path ?? '.github/pull_request_template.md'
  console.error(`PR body format invalid. Read \`${templatePath}\` and follow it precisely.`)
  process.exitCode = 1
}

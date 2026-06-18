import { runWorkspaceEnsureGithub } from '../src/server/symphony/workspaceEnsureGithub'

process.exitCode = await runWorkspaceEnsureGithub(process.argv.slice(2))

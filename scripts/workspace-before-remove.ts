import { runWorkspaceBeforeRemove } from '../src/server/symphony/workspaceBeforeRemove'

process.exitCode = await runWorkspaceBeforeRemove(process.argv.slice(2))

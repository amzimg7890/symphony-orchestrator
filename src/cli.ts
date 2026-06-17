import { createRuntimeSymphonyCliDeps, runSymphonyCli } from './server/symphony/cliMain'

const deps = createRuntimeSymphonyCliDeps()
const result = await runSymphonyCli(process.argv.slice(2), deps)

if (!result.started) {
  process.exit(result.exit_code)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await result.http_server?.close()
    await deps.stop()
    process.exit(signal === 'SIGINT' ? 0 : 143)
  })
}

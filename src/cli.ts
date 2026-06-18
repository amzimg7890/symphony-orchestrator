import { createRuntimeSymphonyCliDeps, runSymphonyCli } from './server/symphony/cliMain'

const deps = createRuntimeSymphonyCliDeps()
const result = await runSymphonyCli(process.argv.slice(2), deps)

if (!result.started) {
  process.exit(result.exit_code)
}

let stopping = false
let runDurationTimer: ReturnType<typeof setTimeout> | null = null

async function stopAndExit(exitCode: number): Promise<void> {
  if (stopping) {
    return
  }

  stopping = true
  if (runDurationTimer) {
    clearTimeout(runDurationTimer)
    runDurationTimer = null
  }

  await result.http_server?.close()
  await deps.stop()
  process.exit(exitCode)
}

if (result.run_duration_ms) {
  runDurationTimer = setTimeout(() => {
    void stopAndExit(0)
  }, result.run_duration_ms)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await stopAndExit(signal === 'SIGINT' ? 0 : 143)
  })
}

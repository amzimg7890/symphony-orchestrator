import path from 'node:path'
import { SymphonyOrchestrator } from './orchestrator'

declare global {
  // eslint-disable-next-line no-var
  var __symphonyOrchestrator: SymphonyOrchestrator | undefined
}

export function getSymphonyService(): SymphonyOrchestrator {
  globalThis.__symphonyOrchestrator ??= new SymphonyOrchestrator()
  return globalThis.__symphonyOrchestrator
}

export function defaultWorkflowPath(): string {
  return path.resolve(process.env.SYMPHONY_WORKFLOW_PATH ?? path.join(process.cwd(), 'WORKFLOW.md'))
}

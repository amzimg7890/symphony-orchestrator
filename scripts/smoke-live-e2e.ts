import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveWorkflowConfig } from '../src/server/symphony/config'
import { SymphonyOrchestrator } from '../src/server/symphony/orchestrator'
import { runSshCommand, shellEscape } from '../src/server/symphony/ssh'
import type { EffectiveConfig } from '../src/server/symphony/types'
import { parseWorkflow } from '../src/server/symphony/workflow'
import {
  removeWorkspaceForIssue,
  sanitizeWorkspaceKey,
  workspacePathForIssue,
} from '../src/server/symphony/workspace'

type Backend = 'local' | 'ssh' | 'docker'

type WorkerSetup = {
  backend: Backend
  codex_command: string
  cleanup: () => Promise<void>
  ssh_worker_hosts: Array<string>
  workspace_root: string
  selected_worker_host: string | null
}

type LinearResponse<T> = {
  data?: T
  errors?: Array<{ message?: string }>
}

type TeamLookupPayload = {
  teams?: {
    nodes?: Array<{
      id?: string | null
      key?: string | null
      name?: string | null
      states?: {
        nodes?: Array<{ id?: string | null; name?: string | null; type?: string | null }>
      } | null
    }>
  }
}

type ProjectCreatePayload = {
  projectCreate?: {
    success?: boolean | null
    project?: {
      id?: string | null
      name?: string | null
      slugId?: string | null
      url?: string | null
    } | null
  } | null
}

type ProjectLookupPayload = {
  projects?: {
    nodes?: Array<{
      id?: string | null
      name?: string | null
      slugId?: string | null
      url?: string | null
      teams?: {
        nodes?: Array<LiveTeamNode>
      } | null
    }>
  } | null
}

type IssueCreatePayload = {
  issueCreate?: {
    success?: boolean | null
    issue?: LiveIssue | null
  } | null
}

type IssueDetailsPayload = {
  issue?: {
    id?: string | null
    identifier?: string | null
    state?: { name?: string | null; type?: string | null } | null
    comments?: { nodes?: Array<{ body?: string | null }> } | null
  } | null
}

type ProjectStatusesPayload = {
  projectStatuses?: {
    nodes?: Array<{ id?: string | null; name?: string | null; type?: string | null }>
  } | null
}

type ProjectUpdatePayload = {
  projectUpdate?: { success?: boolean | null } | null
}

type LiveState = {
  id: string
  name: string
  type: string | null
}

type LiveTeamNode = {
  id?: string | null
  key?: string | null
  name?: string | null
  states?: {
    nodes?: Array<{ id?: string | null; name?: string | null; type?: string | null }>
  } | null
}

type LiveTeam = {
  id: string
  key: string
  name: string | null
  states: Array<LiveState>
}

type LiveProject = {
  id: string
  name: string
  slugId: string
  url: string | null
}

type LiveIssue = {
  id?: string | null
  identifier?: string | null
  title?: string | null
  description?: string | null
  url?: string | null
  state?: { name?: string | null; type?: string | null } | null
}

const TEAM_LOOKUP_QUERY = `
  query SymphonyLiveE2ETeam($key: String!) {
    teams(filter: {key: {eq: $key}}, first: 1) {
      nodes {
        id
        key
        name
        states(first: 50) {
          nodes {
            id
            name
            type
          }
        }
      }
    }
  }
`

const PROJECT_CREATE_MUTATION = `
  mutation SymphonyLiveE2ECreateProject($name: String!, $teamIds: [String!]!) {
    projectCreate(input: {name: $name, teamIds: $teamIds}) {
      success
      project {
        id
        name
        slugId
        url
      }
    }
  }
`

const PROJECT_LOOKUP_QUERY = `
  query SymphonyLiveE2EProject($slug: String!) {
    projects(filter: {slugId: {eq: $slug}}, first: 1) {
      nodes {
        id
        name
        slugId
        url
        teams(first: 10) {
          nodes {
            id
            key
            name
            states(first: 50) {
              nodes {
                id
                name
                type
              }
            }
          }
        }
      }
    }
  }
`

const ISSUE_CREATE_MUTATION = `
  mutation SymphonyLiveE2ECreateIssue(
    $teamId: String!
    $projectId: String!
    $title: String!
    $description: String!
    $stateId: String
  ) {
    issueCreate(input: {
      teamId: $teamId
      projectId: $projectId
      title: $title
      description: $description
      stateId: $stateId
    }) {
      success
      issue {
        id
        identifier
        title
        description
        url
        state {
          name
          type
        }
      }
    }
  }
`

const ISSUE_DETAILS_QUERY = `
  query SymphonyLiveE2EIssueDetails($id: String!) {
    issue(id: $id) {
      id
      identifier
      state {
        name
        type
      }
      comments(first: 20) {
        nodes {
          body
        }
      }
    }
  }
`

const PROJECT_STATUSES_QUERY = `
  query SymphonyLiveE2EProjectStatuses {
    projectStatuses(first: 50) {
      nodes {
        id
        name
        type
      }
    }
  }
`

const PROJECT_COMPLETE_MUTATION = `
  mutation SymphonyLiveE2ECompleteProject($id: String!, $statusId: String!, $completedAt: DateTime!) {
    projectUpdate(id: $id, input: {statusId: $statusId, completedAt: $completedAt}) {
      success
    }
  }
`

const root = process.cwd()
await loadDotEnv(path.join(root, '.env'))

const runLiveE2e = booleanEnv('SYMPHONY_RUN_LIVE_E2E')
const required = booleanEnv('SYMPHONY_LIVE_E2E_REQUIRED')

if (!runLiveE2e) {
  const payload = JSON.stringify(
    {
      ok: !required,
      skipped: true,
      required,
      reason: 'Set SYMPHONY_RUN_LIVE_E2E=1 to create a real Linear project/issue and send a real Codex turn.',
    },
    null,
    2,
  )

  if (required) {
    console.error(payload)
    process.exit(1)
  }

  console.log(payload)
  process.exit(0)
}

const endpoint = env('LINEAR_ENDPOINT') ?? 'https://api.linear.app/graphql'
const apiKey = env('LINEAR_API_KEY')
const workerHosts = csvEnv('SYMPHONY_LIVE_SSH_WORKER_HOSTS', csvEnv('SYMPHONY_SSH_WORKER_HOSTS', []))
const requestedBackend = resolveBackend(env('SYMPHONY_LIVE_E2E_BACKEND'), workerHosts)
let effectiveBackend: Backend = requestedBackend
const missing = [
  apiKey ? null : 'LINEAR_API_KEY',
].filter((item): item is string => Boolean(item))

if (missing.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        skipped: false,
        missing,
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

const runId = `symphony-live-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`
const runRoot = path.join(root, '.tmp', 'live-e2e', runId)
const workflowPath = path.join(runRoot, 'WORKFLOW.md')
const localWorkspaceRoot = env('SYMPHONY_LIVE_E2E_WORKSPACE_ROOT') ?? path.join(runRoot, 'workspaces')
const defaultRemoteRoot = `~/.${runId}`
const remoteWorkspaceRoot = env('SYMPHONY_LIVE_E2E_REMOTE_WORKSPACE_ROOT') ?? `${defaultRemoteRoot}/workspaces`
const configuredTeamKey = env('SYMPHONY_LIVE_LINEAR_TEAM_KEY')
const existingProjectSlug = env('SYMPHONY_LIVE_E2E_PROJECT_SLUG') ?? env('LINEAR_PROJECT_SLUG')
const configuredCodexCommand =
  env('SYMPHONY_LIVE_E2E_CODEX_COMMAND') ??
  env('SYMPHONY_SSH_WORKER_CODEX_COMMAND') ??
  'codex app-server'
const model = env('SYMPHONY_LIVE_E2E_MODEL')
const timeoutMs = positiveIntegerEnv('SYMPHONY_LIVE_E2E_TIMEOUT_MS', 900_000)
const pollMs = positiveIntegerEnv('SYMPHONY_LIVE_E2E_POLL_MS', 2_000)
const readTimeoutMs = positiveIntegerEnv('SYMPHONY_LIVE_E2E_CODEX_READ_TIMEOUT_MS', 60_000)
const turnTimeoutMs = positiveIntegerEnv('SYMPHONY_LIVE_E2E_CODEX_TURN_TIMEOUT_MS', 600_000)
const stallTimeoutMs = positiveIntegerEnv('SYMPHONY_LIVE_E2E_CODEX_STALL_TIMEOUT_MS', 600_000)
const keepArtifacts = booleanEnv('SYMPHONY_LIVE_E2E_KEEP_ARTIFACTS')
const resultFile = 'LIVE_E2E_RESULT.txt'
const noCleanupTerminalState = '__symphony_live_e2e_no_terminal_cleanup__'
const startedAt = Date.now()

let orchestrator: SymphonyOrchestrator | null = null
let config: EffectiveConfig | null = null
let project: LiveProject | null = null
let issue: LiveIssue | null = null
let projectCompleted = false
let workerSetup: WorkerSetup | null = null

try {
  await mkdir(runRoot, { recursive: true })
  workerSetup = await setupLiveWorker(requestedBackend)
  const projectSetup = existingProjectSlug
    ? await lookupExistingProject(existingProjectSlug, configuredTeamKey)
    : await createTemporaryProject(configuredTeamKey ?? 'SYME2E')
  const team = projectSetup.team
  const activeState = selectState(
    team.states,
    env('SYMPHONY_LIVE_LINEAR_ACTIVE_STATE'),
    ['Todo', 'Backlog', 'Triage'],
    ['unstarted', 'backlog'],
    'active',
  )
  const completedState = selectState(
    team.states,
    env('SYMPHONY_LIVE_LINEAR_COMPLETED_STATE'),
    ['Done', 'Closed', 'Complete', 'Completed'],
    ['completed'],
    'completed',
  )

  project = projectSetup.project
  issue = await createIssue(team, project, activeState, completedState)
  const issueId = requireString(issue.id, 'created issue id')
  const issueIdentifier = requireString(issue.identifier, 'created issue identifier')
  const expectedResult = `identifier=${issueIdentifier}\nproject_slug=${project.slugId}\n`
  const expectedComment = [
    'Symphony live e2e comment',
    `identifier=${issueIdentifier}`,
    `project_slug=${project.slugId}`,
  ].join('\n')

  const workflowContent = buildWorkflowContent({
    projectSlug: project.slugId,
    activeState: activeState.name,
    workspaceRoot: workerSetup.workspace_root,
    workerHosts: workerSetup.ssh_worker_hosts,
    codexCommand: workerSetup.codex_command,
  })
  await writeFile(workflowPath, workflowContent, 'utf8')
  config = resolveSmokeConfig(workflowContent, workflowPath)

  orchestrator = new SymphonyOrchestrator()
  await orchestrator.start(workflowPath)
  const verification = await waitForVerification({
    issueId,
    issueIdentifier,
    projectSlug: project.slugId,
    expectedResult,
    expectedComment,
    completedStateName: completedState.name,
    completedStateId: completedState.id,
    workerHost: workerSetup.selected_worker_host,
    config,
  })

  projectCompleted = projectSetup.complete_project_after_run ? await completeProject(project.id) : false
  await orchestrator.stop()
  orchestrator = null
  await cleanupArtifacts(config, issueIdentifier, workerSetup)

  console.log(
    JSON.stringify(
      {
        ok: true,
        skipped: false,
        backend: workerSetup.backend,
        requested_backend: requestedBackend,
        team: {
          key: team.key,
          id: team.id,
        },
        project: {
          id: project.id,
          slug_id: project.slugId,
          url: project.url,
          completed: projectCompleted,
          reused: projectSetup.reused_project,
        },
        issue: {
          id: issueId,
          identifier: issueIdentifier,
          url: issue.url ?? null,
          completed_state: completedState.name,
        },
        workflow_path: workflowPath,
        worker_host: workerSetup.selected_worker_host,
        worker_hosts: workerSetup.ssh_worker_hosts,
        workspace_root: workerSetup.workspace_root,
        keep_artifacts: keepArtifacts,
        duration_ms: Date.now() - startedAt,
        expected: {
          file: resultFile,
          file_content: expectedResult,
          comment: expectedComment,
        },
        verification,
      },
      null,
      2,
    ),
  )
} catch (error) {
  await orchestrator?.stop().catch(() => {})
  const issueIdentifier = issue?.identifier ?? null
  if (config && issueIdentifier && workerSetup) {
    await cleanupArtifacts(config, issueIdentifier, workerSetup).catch(() => {})
  } else {
    await workerSetup?.cleanup().catch(() => {})
  }

  console.error(
    JSON.stringify(
      {
        ok: false,
        skipped: false,
        backend: workerSetup?.backend ?? effectiveBackend,
        requested_backend: requestedBackend,
        error: error instanceof Error ? error.message : String(error),
        project: project
          ? {
              id: project.id,
              slug_id: project.slugId,
              url: project.url,
              completed: projectCompleted,
              reused: existingProjectSlug ? true : null,
            }
          : null,
        issue: issue
          ? {
              id: issue.id ?? null,
              identifier: issue.identifier ?? null,
              url: issue.url ?? null,
              state: issue.state?.name ?? null,
            }
          : null,
        snapshot: orchestrator ? summarizeSnapshot(orchestrator.snapshot()) : null,
        duration_ms: Date.now() - startedAt,
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

async function createTemporaryProject(teamKey: string): Promise<{
  team: LiveTeam
  project: LiveProject
  complete_project_after_run: boolean
  reused_project: boolean
}> {
  const team = await lookupTeam(teamKey)
  return {
    team,
    project: await createProject(team),
    complete_project_after_run: true,
    reused_project: false,
  }
}

async function lookupTeam(key: string): Promise<LiveTeam> {
  const payload = await linear<TeamLookupPayload>(TEAM_LOOKUP_QUERY, { key })
  const team = normalizeTeamNode(payload.teams?.nodes?.[0])
  if (!team) {
    throw new Error(`Linear team ${key} was not found`)
  }

  return team
}

async function lookupExistingProject(
  slug: string,
  preferredTeamKey: string | null,
): Promise<{
  team: LiveTeam
  project: LiveProject
  complete_project_after_run: boolean
  reused_project: boolean
}> {
  const payload = await linear<ProjectLookupPayload>(PROJECT_LOOKUP_QUERY, { slug })
  const node = payload.projects?.nodes?.[0]
  const projectId = node?.id?.trim()
  const slugId = node?.slugId?.trim()
  const name = node?.name?.trim()
  if (!node || !projectId || !slugId || !name) {
    throw new Error(`Linear project ${slug} was not found`)
  }

  const teams = node.teams?.nodes?.map((teamNode) => normalizeTeamNode(teamNode)).filter(isLiveTeam) ?? []
  const team = preferredTeamKey
    ? teams.find((candidate) => sameName(candidate.key, preferredTeamKey))
    : teams[0]
  if (!team) {
    throw new Error(
      preferredTeamKey
        ? `Linear project ${slug} is not associated with team ${preferredTeamKey}`
        : `Linear project ${slug} did not return any associated teams`,
    )
  }

  return {
    team,
    project: {
      id: projectId,
      name,
      slugId,
      url: node.url?.trim() ?? null,
    },
    complete_project_after_run: false,
    reused_project: true,
  }
}

function normalizeTeamNode(node: LiveTeamNode | null | undefined): LiveTeam | null {
  const teamId = node?.id?.trim()
  const teamKeyValue = node?.key?.trim()
  if (!node || !teamId || !teamKeyValue) {
    return null
  }

  const states =
    node.states?.nodes
      ?.map((state) => ({
        id: state.id?.trim() ?? '',
        name: state.name?.trim() ?? '',
        type: state.type?.trim() ?? null,
      }))
      .filter((state) => state.id && state.name) ?? []

  if (states.length === 0) {
    return null
  }

  return {
    id: teamId,
    key: teamKeyValue,
    name: node.name?.trim() ?? null,
    states,
  }
}

function isLiveTeam(team: LiveTeam | null): team is LiveTeam {
  return team !== null
}

async function createProject(team: LiveTeam): Promise<LiveProject> {
  const projectName = `Symphony live e2e ${new Date().toISOString()}`
  const payload = await linear<ProjectCreatePayload>(PROJECT_CREATE_MUTATION, {
    name: projectName,
    teamIds: [team.id],
  })
  const projectNode = payload.projectCreate?.project
  const projectId = projectNode?.id?.trim()
  const slugId = projectNode?.slugId?.trim()
  const name = projectNode?.name?.trim()
  if (payload.projectCreate?.success !== true || !projectNode || !projectId || !slugId || !name) {
    throw new Error('Linear projectCreate did not return a successful project')
  }

  return {
    id: projectId,
    name,
    slugId,
    url: projectNode.url?.trim() ?? null,
  }
}

async function createIssue(
  team: LiveTeam,
  project: LiveProject,
  activeState: LiveState,
  completedState: LiveState,
): Promise<LiveIssue> {
  const title = `Symphony live e2e ${Date.now()}`
  const description = [
    'This issue is created by the TanStack Symphony live e2e smoke script.',
    '',
    `Expected result file: ${resultFile}`,
    `Project slug: ${project.slugId}`,
    `Target completed state: ${completedState.name}`,
  ].join('\n')

  const payload = await linear<IssueCreatePayload>(ISSUE_CREATE_MUTATION, {
    teamId: team.id,
    projectId: project.id,
    title,
    description,
    stateId: activeState.id,
  })
  const created = payload.issueCreate?.issue
  if (payload.issueCreate?.success !== true || !created?.id || !created.identifier) {
    throw new Error('Linear issueCreate did not return a successful issue')
  }
  return created
}

async function waitForVerification(input: {
  issueId: string
  issueIdentifier: string
  projectSlug: string
  expectedResult: string
  expectedComment: string
  completedStateName: string
  completedStateId: string
  workerHost: string | null
  config: EffectiveConfig
}): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let lastObservation = 'not started'
  while (Date.now() < deadline) {
    const details = await linear<IssueDetailsPayload>(ISSUE_DETAILS_QUERY, { id: input.issueId })
    const issueDetails = details.issue
    const comments = issueDetails?.comments?.nodes?.map((comment) => comment.body ?? '') ?? []
    const resultContent = await readResultFile(input.config, input.issueIdentifier, input.workerHost).catch(() => null)
    const stateName = issueDetails?.state?.name ?? null
    const stateType = issueDetails?.state?.type ?? null
    const hasComment = comments.includes(input.expectedComment)
    const hasFile = resultContent === input.expectedResult
    const completed = stateName === input.completedStateName || stateType === 'completed'

    if (hasFile && hasComment && completed) {
      return {
        issue_state: stateName,
        issue_state_type: stateType,
        comment_found: true,
        result_file_found: true,
        result_file_content: resultContent,
        poll_ms: pollMs,
      }
    }

    lastObservation = JSON.stringify({
      stateName,
      stateType,
      hasComment,
      hasFile,
      resultContent,
      expectedCompletedState: input.completedStateName,
      completedStateId: input.completedStateId,
      commentCount: comments.length,
    })
    await delay(pollMs)
  }

  throw new Error(`Timed out waiting for live e2e verification after ${timeoutMs}ms; last=${lastObservation}`)
}

async function readResultFile(
  config: EffectiveConfig,
  issueIdentifier: string,
  workerHost: string | null,
): Promise<string> {
  if (!workerHost) {
    return await readFile(path.join(workspacePathForIssue(issueIdentifier, config), resultFile), 'utf8')
  }

  const workspacePath = remoteWorkspacePath(config, issueIdentifier)
  const command = [
    remoteShellAssign('workspace', workspacePath),
    `cat "$workspace/${resultFile}"`,
  ].join('\n')
  const result = await runSshCommand(workerHost, command, 30_000)
  if (result.exit_code !== 0 || result.timed_out) {
    throw new Error(`Remote result file read failed on ${workerHost}: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

async function completeProject(projectId: string): Promise<boolean> {
  const statuses = await linear<ProjectStatusesPayload>(PROJECT_STATUSES_QUERY, {})
  const completedStatus = statuses.projectStatuses?.nodes?.find((status) => status.type === 'completed')
  const statusId = completedStatus?.id?.trim()
  if (!statusId) {
    return false
  }

  const payload = await linear<ProjectUpdatePayload>(PROJECT_COMPLETE_MUTATION, {
    id: projectId,
    statusId,
    completedAt: new Date().toISOString(),
  })
  return payload.projectUpdate?.success === true
}

async function setupLiveWorker(backend: Backend): Promise<WorkerSetup> {
  if (backend === 'local') {
    effectiveBackend = 'local'
    return {
      backend: 'local',
      codex_command: configuredCodexCommand,
      cleanup: async () => {},
      ssh_worker_hosts: [],
      workspace_root: localWorkspaceRoot,
      selected_worker_host: null,
    }
  }

  if (backend === 'ssh' && workerHosts.length > 0) {
    effectiveBackend = 'ssh'
    return setupSshWorkers(workerHosts, configuredCodexCommand)
  }

  effectiveBackend = 'docker'
  return await setupDockerWorkers()
}

function setupSshWorkers(hosts: Array<string>, codexCommand: string): WorkerSetup {
  return {
    backend: 'ssh',
    codex_command: codexCommand,
    cleanup: async () => {
      if (!env('SYMPHONY_LIVE_E2E_REMOTE_WORKSPACE_ROOT')) {
        await cleanupRemoteTestRoot(defaultRemoteRoot, hosts)
      }
    },
    ssh_worker_hosts: hosts,
    workspace_root: remoteWorkspaceRoot,
    selected_worker_host: hosts[0] ?? null,
  }
}

async function setupDockerWorkers(): Promise<WorkerSetup> {
  const authJsonPath = expandHomePath(env('SYMPHONY_LIVE_DOCKER_AUTH_JSON') ?? path.join('~', '.codex', 'auth.json'))
  if (!existsSync(authJsonPath)) {
    throw new Error(`Docker worker mode requires Codex auth at ${authJsonPath}`)
  }

  const sshRoot = path.join(runRoot, 'live-docker-ssh')
  const keyPath = path.join(sshRoot, 'id_ed25519')
  const configPath = path.join(sshRoot, 'config')
  const workerPorts = await reserveTcpPorts(2)
  const hosts = workerPorts.map((port) => `localhost:${port}`)
  const projectName = dockerProjectName(runId)
  const previousSshConfig = process.env.SYMPHONY_SSH_CONFIG
  const composeEnv = {
    SYMPHONY_LIVE_DOCKER_AUTH_JSON: dockerPath(authJsonPath),
    SYMPHONY_LIVE_DOCKER_AUTHORIZED_KEY: dockerPath(`${keyPath}.pub`),
    SYMPHONY_LIVE_DOCKER_WORKER_1_PORT: String(workerPorts[0]),
    SYMPHONY_LIVE_DOCKER_WORKER_2_PORT: String(workerPorts[1]),
  }

  const baseCleanup = async () => {
    restoreEnv('SYMPHONY_SSH_CONFIG', previousSshConfig)
    await dockerCompose(projectName, composeEnv, ['down', '-v', '--remove-orphans']).catch(() => {})
  }

  try {
    await mkdir(sshRoot, { recursive: true })
    await generateSshKeypair(keyPath)
    await writeDockerSshConfig(configPath, keyPath)
    process.env.SYMPHONY_SSH_CONFIG = configPath
    await dockerCompose(projectName, composeEnv, ['up', '-d', '--build'])
    await waitForSshHosts(hosts)
    const remoteHome = await sharedRemoteHome(hosts)
    const remoteTestRoot = `${remoteHome.replace(/[\\/]+$/, '')}/.${runId}`

    return {
      backend: 'docker',
      codex_command: 'codex app-server',
      cleanup: async () => {
        await cleanupRemoteTestRoot(remoteTestRoot, hosts)
        await baseCleanup()
      },
      ssh_worker_hosts: hosts,
      workspace_root: remoteWorkspaceRoot,
      selected_worker_host: hosts[0] ?? null,
    }
  } catch (error) {
    await baseCleanup()
    throw error
  }
}

async function cleanupRemoteTestRoot(remoteRoot: string, hosts: Array<string>): Promise<void> {
  await Promise.all(
    hosts.map((host) =>
      runSshCommand(
        host,
        [
          remoteShellAssign('root', remoteRoot),
          'rm -rf "$root"',
        ].join('\n'),
        30_000,
      ).catch(() => null),
    ),
  )
}

async function cleanupArtifacts(
  config: EffectiveConfig,
  issueIdentifier: string,
  workerSetup: WorkerSetup,
): Promise<void> {
  if (keepArtifacts) {
    if (workerSetup.backend === 'docker') {
      await workerSetup.cleanup()
    }
    return
  }

  const workerHost = workerSetup.selected_worker_host
  await removeWorkspaceForIssue(issueIdentifier, config, workerHost)

  if (!workerHost) {
    await workerSetup.cleanup()
    await rm(runRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    return
  }

  await workerSetup.cleanup()
  await rm(runRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

function buildWorkflowContent(input: {
  projectSlug: string
  activeState: string
  workspaceRoot: string
  workerHosts: Array<string>
  codexCommand: string
}): string {
  return [
    '---',
    'tracker:',
    '  kind: linear',
    `  endpoint: ${yamlSingleQuoted(endpoint)}`,
    '  api_key: $LINEAR_API_KEY',
    `  project_slug: ${yamlSingleQuoted(input.projectSlug)}`,
    '  required_labels: []',
    '  active_states:',
    `    - ${yamlSingleQuoted(input.activeState)}`,
    '  terminal_states:',
    `    - ${yamlSingleQuoted(noCleanupTerminalState)}`,
    'polling:',
    '  interval_ms: 1000',
    'workspace:',
    `  root: ${yamlSingleQuoted(input.workspaceRoot)}`,
    'worker:',
    ...(input.workerHosts.length > 0
      ? [
          '  ssh_hosts:',
          ...input.workerHosts.map((host) => `    - ${yamlSingleQuoted(host)}`),
          '  max_concurrent_agents_per_host: 1',
        ]
      : ['  ssh_hosts: []']),
    'agent:',
    '  runner: codex',
    '  max_concurrent_agents: 1',
    '  max_turns: 1',
    '  max_retry_backoff_ms: 1000',
    'codex:',
    `  command: ${yamlSingleQuoted(input.codexCommand)}`,
    ...(model ? [`  model: ${yamlSingleQuoted(model)}`] : []),
    `  read_timeout_ms: ${readTimeoutMs}`,
    `  turn_timeout_ms: ${turnTimeoutMs}`,
    `  stall_timeout_ms: ${stallTimeoutMs}`,
    'demo:',
    '  mock_tracker: false',
    'logging:',
    '  enabled: true',
    `  root: ${yamlSingleQuoted(path.join(runRoot, 'logs'))}`,
    '  file: symphony-live-e2e.jsonl',
    '---',
    livePrompt(input.projectSlug),
  ].join('\n')
}

function livePrompt(projectSlug: string): string {
  return [
    'You are running the Symphony live e2e smoke test.',
    'Do exactly these steps and then stop:',
    '',
    `1. Create a file named ${resultFile} in the current working directory with exactly this content, including the final newline:`,
    '```',
    'identifier={{issue.identifier}}',
    `project_slug=${projectSlug}`,
    '```',
    '',
    '2. Use the linear_graphql dynamic tool to query the current Linear issue by id. Confirm its identifier is {{issue.identifier}}.',
    '',
    '3. Use the linear_graphql dynamic tool to create exactly this Linear comment on the issue:',
    '```',
    'Symphony live e2e comment',
    'identifier={{issue.identifier}}',
    `project_slug=${projectSlug}`,
    '```',
    '',
    '4. Use the linear_graphql dynamic tool to move the issue to the completed workflow state.',
    'You can query the issue team states to find the state whose type is completed.',
    '',
    'Do not ask for approval. Do not modify any other files.',
  ].join('\n')
}

function resolveSmokeConfig(workflowContent: string, workflowFilePath: string): EffectiveConfig {
  const workflow = parseWorkflow(workflowContent, workflowFilePath)
  const result = resolveWorkflowConfig(workflow, process.env)
  if (!result.ok) {
    throw new Error(`Invalid live e2e config: ${result.errors.map((error) => error.message).join('; ')}`)
  }
  return result.config
}

async function reserveTcpPorts(count: number): Promise<Array<number>> {
  const ports: Array<number> = []
  const seen = new Set<number>()
  while (ports.length < count) {
    const port = await reserveTcpPort()
    if (!seen.has(port)) {
      seen.add(port)
      ports.push(port)
    }
  }
  return ports
}

async function reserveTcpPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  if (!address || typeof address === 'string') {
    throw new Error('Unable to reserve a local TCP port')
  }
  return address.port
}

async function generateSshKeypair(keyPath: string): Promise<void> {
  await rm(keyPath, { force: true })
  await rm(`${keyPath}.pub`, { force: true })
  await runProcess('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], {
    cwd: runRoot,
    timeoutMs: 30_000,
    errorPrefix: 'failed to generate live docker SSH key',
  })
}

async function writeDockerSshConfig(configPath: string, keyPath: string): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(
    configPath,
    [
      'Host localhost 127.0.0.1',
      '  User root',
      `  IdentityFile ${sshConfigPath(keyPath)}`,
      '  IdentitiesOnly yes',
      '  StrictHostKeyChecking no',
      '  UserKnownHostsFile /dev/null',
      '  LogLevel ERROR',
      '',
    ].join('\n'),
    'utf8',
  )
}

async function dockerCompose(
  projectName: string,
  envValues: Record<string, string>,
  args: Array<string>,
): Promise<void> {
  const supportDir = path.join(root, 'tests', 'support', 'live_e2e_docker')
  await runProcess(
    'docker',
    ['compose', '-f', path.join(supportDir, 'docker-compose.yml'), '-p', projectName, ...args],
    {
      cwd: supportDir,
      timeoutMs: args[0] === 'up' ? 180_000 : 60_000,
      env: envValues,
      errorPrefix: `docker compose ${args.join(' ')}`,
    },
  )
}

async function waitForSshHosts(hosts: Array<string>): Promise<void> {
  const deadline = Date.now() + 60_000
  for (const host of hosts) {
    await waitForSshHost(host, deadline)
  }
}

async function waitForSshHost(host: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    const result = await runSshCommand(host, 'printf ready', 5_000).catch(() => null)
    if (result && result.exit_code === 0 && result.stdout === 'ready' && !result.timed_out) {
      return
    }
    await delay(1_000)
  }
  throw new Error(`Timed out waiting for SSH worker ${host} to accept connections`)
}

async function sharedRemoteHome(hosts: Array<string>): Promise<string> {
  const homes = await Promise.all(hosts.map(async (host) => [host, await remoteHome(host)] as const))
  const firstHome = homes[0]?.[1]
  if (!firstHome) {
    throw new Error('Expected at least one SSH worker host')
  }
  const mismatch = homes.find(([, home]) => home !== firstHome)
  if (mismatch) {
    throw new Error(`Expected Docker SSH workers to share one home directory, got ${JSON.stringify(homes)}`)
  }
  return firstHome
}

async function remoteHome(host: string): Promise<string> {
  const result = await runSshCommand(host, 'printf \'%s\\n\' "$HOME"', 10_000)
  if (result.exit_code !== 0 || result.timed_out) {
    throw new Error(`Failed to resolve remote home for ${host}: ${result.stderr || result.stdout}`)
  }
  const home = result.stdout.trim()
  if (!home) {
    throw new Error(`Expected non-empty remote home for ${host}`)
  }
  return home
}

async function runProcess(
  executable: string,
  args: Array<string>,
  options: {
    cwd: string
    timeoutMs: number
    errorPrefix: string
    env?: Record<string, string>
  },
): Promise<void> {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${options.errorPrefix} timed out after ${options.timeoutMs}ms: ${stderr || stdout}`))
    }, options.timeoutMs)

    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${options.errorPrefix} exited with ${code ?? signal}: ${stderr || stdout}`))
    })
  })
}

function selectState(
  states: Array<LiveState>,
  preferredName: string | null,
  fallbackNames: Array<string>,
  fallbackTypes: Array<string>,
  purpose: string,
): LiveState {
  const byPreferred = preferredName ? states.find((state) => sameName(state.name, preferredName)) : null
  const byName = fallbackNames
    .map((name) => states.find((state) => sameName(state.name, name)))
    .find((state): state is LiveState => Boolean(state))
  const byType = states.find((state) => state.type && fallbackTypes.includes(state.type))
  const selected = byPreferred ?? byName ?? byType
  if (!selected) {
    throw new Error(`Could not find ${purpose} state in Linear team workflow`)
  }
  return selected
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

async function linear<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: apiKey!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    throw new Error(`Linear returned HTTP ${response.status}: ${await response.text()}`)
  }

  const payload = (await response.json()) as LinearResponse<T>
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message ?? 'GraphQL error').join('; '))
  }
  if (!payload.data) {
    throw new Error('Linear response did not include data')
  }

  return payload.data
}

function remoteWorkspacePath(config: EffectiveConfig, issueIdentifier: string): string {
  const rootPath = (config.workspace.remote_root ?? config.workspace.root).replace(/[\\/]+$/, '')
  const workspaceKey = sanitizeWorkspaceKey(issueIdentifier)
  return rootPath ? `${rootPath}/${workspaceKey}` : workspaceKey
}

function remoteShellAssign(variableName: string, rawPath: string): string {
  return [
    `${variableName}=${shellEscape(rawPath)}`,
    `case "$${variableName}" in`,
    `  '~') ${variableName}="$HOME" ;;`,
    `  '~/'*) ${variableName}="$HOME/\${${variableName}#~/}" ;;`,
    'esac',
  ].join('\n')
}

async function loadDotEnv(dotEnvPath: string): Promise<void> {
  if (!existsSync(dotEnvPath)) {
    return
  }

  const content = await readFile(dotEnvPath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match) {
      continue
    }
    const [, key, rawValue] = match
    process.env[key] ??= unquoteDotEnvValue(rawValue)
  }
}

function env(key: string): string | null {
  const value = process.env[key]?.trim()
  return value ? value : null
}

function csvEnv(key: string, fallback: Array<string>): Array<string> {
  const value = env(key)
  if (!value) {
    return fallback
  }

  const parsed = value.split(',').map((item) => item.trim()).filter(Boolean)
  return parsed.length > 0 ? parsed : fallback
}

function booleanEnv(key: string): boolean {
  const value = env(key)?.toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer when set`)
  }
  return value
}

function resolveBackend(value: string | null, hosts: Array<string>): Backend {
  if (!value) {
    return hosts.length > 0 ? 'ssh' : 'local'
  }
  const normalized = value.toLowerCase()
  if (normalized === 'local' || normalized === 'ssh' || normalized === 'docker') {
    return normalized
  }
  throw new Error('SYMPHONY_LIVE_E2E_BACKEND must be "local", "ssh", or "docker"')
}

function requireString(value: unknown, description: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  throw new Error(`Missing ${description}`)
}

function dockerProjectName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
}

function dockerPath(value: string): string {
  return path.resolve(value).replaceAll('\\', '/')
}

function sshConfigPath(value: string): string {
  return path.resolve(value).replaceAll('\\', '/')
}

function expandHomePath(value: string): string {
  if (value === '~') {
    return os.homedir()
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

function restoreEnv(key: string, previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = previousValue
}

function unquoteDotEnvValue(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function yamlSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function summarizeSnapshot(snapshot: ReturnType<SymphonyOrchestrator['snapshot']>): Record<string, unknown> {
  return {
    service_status: snapshot.service_status,
    counts: snapshot.counts,
    last_error: snapshot.last_error,
    recent_events: snapshot.recent_events.slice(0, 10),
  }
}

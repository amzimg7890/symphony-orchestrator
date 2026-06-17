import { createFileRoute } from '@tanstack/react-router'
import { SymphonyError } from '~/server/symphony/errors'
import {
  errorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  readRequestBody,
} from '~/server/symphony/http'
import { defaultWorkflowPath, getSymphonyService } from '~/server/symphony/service'

type ControlBody = {
  action?: unknown
  workflow_path?: unknown
}

export const Route = createFileRoute('/api/v1/control')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await readRequestBody(request) as ControlBody
          const service = getSymphonyService()
          const action = typeof body.action === 'string' ? body.action : undefined

          if (body.action !== undefined && action !== 'start' && action !== 'stop') {
            throw new SymphonyError(
              'invalid_control_action',
              'control.action must be "start" or "stop"',
            )
          }

          if (action === 'stop') {
            return jsonResponse(await service.stop())
          }

          const workflowPath =
            typeof body.workflow_path === 'string' && body.workflow_path.trim()
              ? body.workflow_path
              : defaultWorkflowPath()
          return jsonResponse(await service.start(workflowPath), { status: 202 })
        } catch (error) {
          return errorResponse(error)
        }
      },
      ANY: ({ request }) => methodNotAllowedResponse(request, ['POST']),
    },
  },
})

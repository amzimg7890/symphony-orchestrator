import { createFileRoute } from '@tanstack/react-router'
import { jsonResponse, methodNotAllowedResponse, unavailableResponse } from '~/server/symphony/http'
import { presentRuntimeSnapshot } from '~/server/symphony/presenter'
import { getSymphonyService } from '~/server/symphony/service'

async function getApiIndex(): Promise<Response> {
  try {
    return jsonResponse({
      service: 'symphony',
      version: 'v1',
      dashboard: '/',
      endpoints: {
        state: '/api/v1/state',
        control: '/api/v1/control',
        refresh: '/api/v1/refresh',
        events: '/api/v1/events',
        issue_detail: '/api/v1/{issue_identifier}',
      },
      snapshot: presentRuntimeSnapshot(getSymphonyService().snapshot()),
    })
  } catch (error) {
    return unavailableResponse(error)
  }
}

export const Route = createFileRoute('/api/v1/')({
  server: {
    handlers: {
      GET: getApiIndex,
      HEAD: getApiIndex,
      ANY: ({ request }) => methodNotAllowedResponse(request, ['GET']),
    },
  },
})

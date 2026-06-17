import { createFileRoute } from '@tanstack/react-router'
import { jsonResponse, methodNotAllowedResponse, snapshotStateErrorResponse } from '~/server/symphony/http'
import { presentRuntimeSnapshot } from '~/server/symphony/presenter'
import { getSymphonyService } from '~/server/symphony/service'

async function getState(): Promise<Response> {
  try {
    return jsonResponse(presentRuntimeSnapshot(getSymphonyService().snapshot()))
  } catch (error) {
    return snapshotStateErrorResponse(error)
  }
}

export const Route = createFileRoute('/api/v1/state')({
  server: {
    handlers: {
      GET: getState,
      HEAD: getState,
      ANY: ({ request }) => methodNotAllowedResponse(request, ['GET']),
    },
  },
})

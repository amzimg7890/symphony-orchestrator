import { createFileRoute } from '@tanstack/react-router'
import { jsonResponse, methodNotAllowedResponse, orchestratorUnavailableResponse } from '~/server/symphony/http'
import { presentRuntimeSnapshot } from '~/server/symphony/presenter'
import { getSymphonyService } from '~/server/symphony/service'

export const Route = createFileRoute('/api/v1/refresh')({
  server: {
    handlers: {
      POST: async () => {
        try {
          const snapshot = await getSymphonyService().refresh()
          return jsonResponse({
            queued: true,
            coalesced: false,
            requested_at: new Date().toISOString(),
            operations: ['poll', 'reconcile'],
            snapshot: presentRuntimeSnapshot(snapshot),
          }, { status: 202 })
        } catch {
          return orchestratorUnavailableResponse()
        }
      },
      ANY: ({ request }) => methodNotAllowedResponse(request, ['POST']),
    },
  },
})

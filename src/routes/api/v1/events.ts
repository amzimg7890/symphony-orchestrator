import { createFileRoute } from '@tanstack/react-router'
import { observabilityEventsResponse } from '~/server/symphony/httpServer'
import { methodNotAllowedResponse } from '~/server/symphony/http'
import { getSymphonyService } from '~/server/symphony/service'

async function getEvents(): Promise<Response> {
  return observabilityEventsResponse(getSymphonyService())
}

export const Route = createFileRoute('/api/v1/events')({
  server: {
    handlers: {
      GET: getEvents,
      HEAD: getEvents,
      ANY: ({ request }) => methodNotAllowedResponse(request, ['GET']),
    },
  },
})

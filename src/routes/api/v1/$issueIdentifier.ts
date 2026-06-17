import { createFileRoute } from '@tanstack/react-router'
import {
  currentIssueDetailPayload,
  errorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  routeNotFoundResponse,
} from '~/server/symphony/http'
import { getSymphonyService } from '~/server/symphony/service'

async function getIssueDetail({ params }: { params: { issueIdentifier: string } }): Promise<Response> {
  try {
    if (params.issueIdentifier.includes('/')) {
      return routeNotFoundResponse()
    }

    const detail = getSymphonyService().issueDetail(params.issueIdentifier)
    return jsonResponse(currentIssueDetailPayload(detail))
  } catch (error) {
    return errorResponse(error)
  }
}

export const Route = createFileRoute('/api/v1/$issueIdentifier')({
  server: {
    handlers: {
      GET: getIssueDetail,
      HEAD: getIssueDetail,
      ANY: ({ request }) => methodNotAllowedResponse(request, ['GET']),
    },
  },
})

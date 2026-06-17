import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowedResponse, routeNotFoundResponse } from '~/server/symphony/http'
import { staticAssetResponse } from '~/server/symphony/staticAssets'

function getDashboardCss(): Response {
  return staticAssetResponse('/dashboard.css') ?? routeNotFoundResponse()
}

export const Route = createFileRoute('/dashboard.css')({
  server: {
    handlers: {
      GET: getDashboardCss,
      HEAD: getDashboardCss,
      ANY: ({ request }) => methodNotAllowedResponse(request, ['GET']),
    },
  },
})

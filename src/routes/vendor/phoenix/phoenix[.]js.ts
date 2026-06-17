import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowedResponse, routeNotFoundResponse } from '~/server/symphony/http'
import { staticAssetResponse } from '~/server/symphony/staticAssets'

function getPhoenixJs(): Response {
  return staticAssetResponse('/vendor/phoenix/phoenix.js') ?? routeNotFoundResponse()
}

export const Route = createFileRoute('/vendor/phoenix/phoenix.js')({
  server: {
    handlers: {
      GET: getPhoenixJs,
      HEAD: getPhoenixJs,
      ANY: ({ request }) => methodNotAllowedResponse(request, ['GET']),
    },
  },
})

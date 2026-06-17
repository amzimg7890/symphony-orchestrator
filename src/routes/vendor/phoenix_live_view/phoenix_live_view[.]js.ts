import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowedResponse, routeNotFoundResponse } from '~/server/symphony/http'
import { staticAssetResponse } from '~/server/symphony/staticAssets'

function getPhoenixLiveViewJs(): Response {
  return staticAssetResponse('/vendor/phoenix_live_view/phoenix_live_view.js') ?? routeNotFoundResponse()
}

export const Route = createFileRoute('/vendor/phoenix_live_view/phoenix_live_view.js')({
  server: {
    handlers: {
      GET: getPhoenixLiveViewJs,
      HEAD: getPhoenixLiveViewJs,
      ANY: ({ request }) => methodNotAllowedResponse(request, ['GET']),
    },
  },
})

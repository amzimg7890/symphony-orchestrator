import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowedResponse, routeNotFoundResponse } from '~/server/symphony/http'
import { staticAssetResponse } from '~/server/symphony/staticAssets'

function getFavicon(): Response {
  return staticAssetResponse('/favicon.png') ?? routeNotFoundResponse()
}

export const Route = createFileRoute('/favicon.png')({
  server: {
    handlers: {
      GET: getFavicon,
      HEAD: getFavicon,
      ANY: ({ request }) => methodNotAllowedResponse(request, ['GET']),
    },
  },
})

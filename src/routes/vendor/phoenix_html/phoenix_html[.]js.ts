import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowedResponse, routeNotFoundResponse } from '~/server/symphony/http'
import { staticAssetResponse } from '~/server/symphony/staticAssets'

function getPhoenixHtmlJs(): Response {
  return staticAssetResponse('/vendor/phoenix_html/phoenix_html.js') ?? routeNotFoundResponse()
}

export const Route = createFileRoute('/vendor/phoenix_html/phoenix_html.js')({
  server: {
    handlers: {
      GET: getPhoenixHtmlJs,
      HEAD: getPhoenixHtmlJs,
      ANY: ({ request }) => methodNotAllowedResponse(request, ['GET']),
    },
  },
})

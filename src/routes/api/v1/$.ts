import { createFileRoute } from '@tanstack/react-router'
import { routeNotFoundResponse } from '~/server/symphony/http'

export const Route = createFileRoute('/api/v1/$')({
  server: {
    handlers: {
      GET: () => routeNotFoundResponse(),
      ANY: () => routeNotFoundResponse(),
    },
  },
})

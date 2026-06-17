export function nowIso(): string {
  return new Date().toISOString()
}

export function msUntil(dateMs: number): number {
  return Math.max(dateMs - Date.now(), 0)
}

export function secondsBetween(startIso: string, endMs = Date.now()): number {
  const start = Date.parse(startIso)
  if (Number.isNaN(start)) {
    return 0
  }

  return Math.max((endMs - start) / 1000, 0)
}

export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }

  return url.toString()
}

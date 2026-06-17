export function stripAnsiAndControlBytes(value: string): string {
  return value
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1B./g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
}

export function inlineText(value: string, options: { maxLength?: number } = {}): string {
  const text = stripAnsiAndControlBytes(value.replaceAll('\\n', ' ').replace(/[\r\n]+/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
  const maxLength = options.maxLength
  return maxLength !== undefined && text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

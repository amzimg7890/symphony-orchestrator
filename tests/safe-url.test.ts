import { describe, expect, it } from 'vitest'
import { safeHttpUrl } from '../src/lib/safeUrl'

describe('safeHttpUrl', () => {
  it('allows http and https tracker URLs', () => {
    expect(safeHttpUrl('https://linear.example/SYM-101')).toBe('https://linear.example/SYM-101')
    expect(safeHttpUrl('http://linear.example/SYM-102')).toBe('http://linear.example/SYM-102')
  })

  it('rejects blank, malformed, and non-http URLs', () => {
    expect(safeHttpUrl(null)).toBeNull()
    expect(safeHttpUrl('')).toBeNull()
    expect(safeHttpUrl('not a url')).toBeNull()
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(safeHttpUrl('file:///tmp/SYM-101')).toBeNull()
  })
})

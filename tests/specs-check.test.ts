import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { missingExportedReturnTypes, specsFindingIdentifier } from '../src/server/symphony/specsCheck'

describe('TypeScript specs check', () => {
  it('reports exported functions without explicit return types', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-specs-check-'))
    try {
      await writeFile(
        path.join(dir, 'sample.ts'),
        [
          'export function missing(value: string) { return value }',
          'export async function missingAsync() { return 1 }',
          'function internal() { return null }',
        ].join('\n'),
        'utf8',
      )

      const findings = await missingExportedReturnTypes([dir])

      expect(findings.map(specsFindingIdentifier)).toEqual([
        `${path.join(dir, 'sample.ts')}:missing`,
        `${path.join(dir, 'sample.ts')}:missingAsync`,
      ])
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('accepts explicit return types and explicit exemptions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'symphony-specs-ok-'))
    const file = path.join(dir, 'sample.ts')
    try {
      await mkdir(path.join(dir, 'nested'))
      await writeFile(
        file,
        [
          'export function ok(value: string): string { return value }',
          'export async function okAsync(): Promise<number> { return 1 }',
          'export function legacy(value: string) { return value }',
        ].join('\n'),
        'utf8',
      )
      await writeFile(path.join(dir, 'nested', 'ignored.d.ts'), 'export function ignored()\n', 'utf8')

      const findings = await missingExportedReturnTypes([dir], {
        exemptions: [`${file}:legacy`],
      })

      expect(findings).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})

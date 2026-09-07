import { expect, test } from 'bun:test'
import { applySeoHead } from '../headSurgeon'

test('head scanning keeps slice allocation linear with the document size', () => {
  const manyLt = '<0'.repeat(4_096)
  const largeTail = 'x'.repeat(16_384)
  const input = `<html><head>${manyLt}${largeTail}</head><body></body></html>`
  const originalSlice = String.prototype.slice
  let slicedCharacters = 0

  String.prototype.slice = function (start?: number, end?: number): string {
    const result = originalSlice.call(this, start, end)
    // Count only document/head-sized receivers, excluding tiny helper strings.
    if (String(this).length >= input.length - 64) slicedCharacters += result.length
    return result
  }

  let output: string
  try {
    output = applySeoHead(input, { block: '' })
  } finally {
    String.prototype.slice = originalSlice
  }

  expect(output).toContain('<!--seo:start-->\n<!--seo:end-->\n</head>')
  expect(slicedCharacters).toBeLessThan(input.length * 12)
})

/**
 * Parity tests for the prepared-extraction path (wave 3.4 perf fix):
 * `analyzePreparedContent(prepareContent(html), meta)` must be BYTE-IDENTICAL
 * to `analyzeContent({ ...meta, html })` — the prepared path only skips the
 * reparse, never changes a result. Also proves a single PreparedContent is
 * safely reusable across many passes (the panel's per-keyword loop).
 */
import { describe, expect, test } from 'bun:test'
import {
  analyzeContent,
  analyzePreparedContent,
  prepareContent,
  type AnalysisInput,
} from '../index'

const RICH_HTML = [
  '<h1>Best coffee beans</h1>',
  '<p>Coffee beans taste great and coffee beans are healthy. This guide covers coffee beans in depth.</p>',
  '<h2>Roasting coffee beans</h2>',
  '<p>Roast slowly. Then grind. Additionally, store the beans in a cool place.</p>',
  '<img src="/uploads/beans.jpg" alt="coffee beans on a table">',
  '<a href="/shop">Shop</a>',
  '<h3>Storage</h3>',
  '<p>Keep them airtight &amp; dry. However, never freeze twice.</p>',
].join('')

const META: Omit<AnalysisInput, 'html' | 'text'> = {
  title: 'Best coffee beans — roast guide',
  metaDescription:
    'Everything about coffee beans: choosing, roasting and storing them for the best cup of coffee every single morning.',
  slug: 'coffee-beans',
  url: 'https://example.test/coffee-beans',
}

describe('prepareContent / analyzePreparedContent parity', () => {
  test('identical result to the html path (single keyword)', () => {
    const old = analyzeContent({ ...META, html: RICH_HTML, focusKeywords: ['coffee beans'] })
    const prepared = analyzePreparedContent(prepareContent(RICH_HTML), {
      ...META,
      focusKeywords: ['coffee beans'],
    })
    expect(prepared).toEqual(old)
  })

  test('identical result with multiple keywords (aggregate averaging path)', () => {
    const keywords = ['coffee beans', 'roasting', 'quantum finance']
    const old = analyzeContent({ ...META, html: RICH_HTML, focusKeywords: keywords })
    const prepared = analyzePreparedContent(prepareContent(RICH_HTML), {
      ...META,
      focusKeywords: keywords,
    })
    expect(prepared).toEqual(old)
  })

  test('identical result with no keywords and no meta', () => {
    expect(analyzePreparedContent(prepareContent(RICH_HTML))).toEqual(
      analyzeContent({ html: RICH_HTML }),
    )
  })

  test('identical result for empty html', () => {
    expect(analyzePreparedContent(prepareContent(''), META)).toEqual(
      analyzeContent({ ...META, html: '' }),
    )
  })

  test('one PreparedContent reused across per-keyword passes stays pristine', () => {
    const prepared = prepareContent(RICH_HTML)
    // The panel's pattern: one extraction, N single-keyword passes.
    for (const keyword of ['coffee beans', 'roasting', 'quantum finance']) {
      const viaPrepared = analyzePreparedContent(prepared, {
        ...META,
        focusKeywords: [keyword],
      })
      const viaHtml = analyzeContent({ ...META, html: RICH_HTML, focusKeywords: [keyword] })
      expect(viaPrepared).toEqual(viaHtml)
    }
    // And a final full-list pass over the SAME prepared object still matches
    // a fresh parse — no pass mutated the shared extraction.
    const full = analyzePreparedContent(prepared, {
      ...META,
      focusKeywords: ['coffee beans', 'roasting'],
    })
    expect(full).toEqual(
      analyzeContent({ ...META, html: RICH_HTML, focusKeywords: ['coffee beans', 'roasting'] }),
    )
  })
})

import { describe, expect, test } from 'bun:test'
import { buildLlmsTxt, escapeMarkdownLabel, truncateForLlmsTxt } from '../llmsTxt'
import { SITEMAP_ENTRY_MAX_CHARS, SITEMAP_URL_BUDGET_CHARS } from '../sitemap'

describe('escapeMarkdownLabel', () => {
  test('escapes brackets and backslashes, collapses whitespace', () => {
    expect(escapeMarkdownLabel('A [B] C\\D')).toBe('A \\[B\\] C\\\\D')
    expect(escapeMarkdownLabel('  multi\n line   title ')).toBe('multi line title')
  })
})

describe('buildLlmsTxt', () => {
  const SITE = 'https://example.com'

  test('renders heading, blockquote description, and sorted page list', () => {
    const txt = buildLlmsTxt({
      siteUrl: SITE,
      siteName: 'Acme',
      description: 'Widgets  and\nthings.',
      entries: [
        { pageId: 'p2', slug: 'zebra', title: 'Zebra page' },
        { pageId: 'p1', slug: 'index', title: 'Home' },
      ],
    })
    const lines = txt.split('\n')
    expect(lines[0]).toBe('# Acme')
    expect(lines[2]).toBe('> Widgets and things.')
    expect(txt).toContain('## Pages')
    const home = txt.indexOf('- [Home](https://example.com/)')
    const zebra = txt.indexOf('- [Zebra page](https://example.com/zebra)')
    expect(home).toBeGreaterThan(-1)
    expect(zebra).toBeGreaterThan(home)
    expect(txt).toEndWith('\n')
  })

  test('falls back to the origin host as heading and slug as label', () => {
    const txt = buildLlmsTxt({
      siteUrl: SITE,
      entries: [{ pageId: 'p1', slug: 'about' }],
    })
    expect(txt.split('\n')[0]).toBe('# example.com')
    expect(txt).not.toContain('>')
    expect(txt).toContain('- [about](https://example.com/about)')
  })

  test('escapes markdown-significant title characters', () => {
    const txt = buildLlmsTxt({
      siteUrl: SITE,
      entries: [{ pageId: 'p1', slug: 'a', title: 'Weird [Title]' }],
    })
    expect(txt).toContain('- [Weird \\[Title\\]](https://example.com/a)')
  })

  test('escapes parentheses in link destinations', () => {
    const txt = buildLlmsTxt({
      siteUrl: SITE,
      entries: [{ pageId: 'p1', slug: 'foo)bar', title: 'Parens' }],
    })
    expect(txt).toContain('- [Parens](https://example.com/foo\\)bar)')
  })

  test('caps the page list with a LOUD truncation note', () => {
    const entries = []
    for (let i = 0; i < 7; i++) entries.push({ pageId: `p${i}`, slug: `page-${i}` })
    const txt = buildLlmsTxt({ siteUrl: SITE, entries, urlCap: 5 })
    expect(txt.match(/^- \[/gm)?.length).toBe(5)
    expect(txt).toContain('<!-- truncated: showing 5 of 7 pages (cap 5) -->')
  })

  test('flags a possibly-truncated storage read', () => {
    const txt = buildLlmsTxt({ siteUrl: SITE, entries: [], truncatedLoad: true })
    expect(txt).toContain('storage list cap')
  })

  // Round-5 triage E/t2-13: per-entry length caps at the emission boundary.
  test('skips pages whose slug exceeds the per-entry bound, LOUDLY', () => {
    const txt = buildLlmsTxt({
      siteUrl: SITE,
      entries: [
        { pageId: 'p1', slug: 'ok', title: 'Ok' },
        { pageId: 'p2', slug: 'x'.repeat(SITEMAP_ENTRY_MAX_CHARS + 1), title: 'Huge slug' },
      ],
    })
    expect(txt.match(/^- \[/gm)?.length).toBe(1)
    expect(txt).not.toContain('xxxxxxxxxx')
    expect(txt).toContain(
      `<!-- skipped: 1 page with a slug longer than ${SITEMAP_ENTRY_MAX_CHARS} characters -->`,
    )
  })

  test('truncates an over-long title instead of dropping the page', () => {
    const txt = buildLlmsTxt({
      siteUrl: SITE,
      entries: [{ pageId: 'p1', slug: 'ok', title: 'T'.repeat(SITEMAP_ENTRY_MAX_CHARS + 500) }],
    })
    expect(txt).toContain('](https://example.com/ok)')
    expect(txt).toContain('…')
    expect(txt).not.toContain('<!-- skipped:')
    expect(txt.length).toBeLessThan(SITEMAP_ENTRY_MAX_CHARS + 300)
  })

  test('truncates an over-long site name and description', () => {
    const txt = buildLlmsTxt({
      siteUrl: SITE,
      siteName: 'N'.repeat(50_000),
      description: 'D'.repeat(50_000),
      entries: [],
      entryMaxChars: 20,
    })
    expect(txt).toContain(`# ${'N'.repeat(20)}…`)
    expect(txt).toContain(`> ${'D'.repeat(20)}…`)
  })

  test('the bound keeps the document bounded under a pathological entry set', () => {
    const entries = []
    for (let i = 0; i < 50; i++) {
      entries.push({ pageId: `p${i}`, slug: 'z'.repeat(50_000), title: 'y'.repeat(50_000) })
    }
    const txt = buildLlmsTxt({ siteUrl: SITE, entries })
    expect(txt.length).toBeLessThan(500)
    expect(txt).toContain('<!-- skipped: 50 pages with a slug longer than 2000 characters -->')
  })

  // ── round-5 wave-2 O#4: AGGREGATE encoded-output budget ────────────────

  test('the aggregate URL budget stops the map and says so', () => {
    const entries = []
    for (let i = 0; i < 10; i++) entries.push({ pageId: `p${i}`, slug: `page-${i}` })
    // https://example.com/page-N = 30 chars → 3 fit in 95, the 4th does not.
    const txt = buildLlmsTxt({ siteUrl: SITE, entries, urlBudgetChars: 95 })
    expect(txt.match(/^- \[/gm)?.length).toBe(3)
    expect(txt).toContain('<!-- skipped: 7 pages past the 95-character total URL budget -->')
  })

  test('over-budget output is independent of storage order', () => {
    const entries = [
      { pageId: 'p4', slug: 'delta', title: 'Delta' },
      { pageId: 'p2', slug: 'bravo', title: 'Bravo' },
      { pageId: 'p3', slug: 'charlie', title: 'Charlie' },
      { pageId: 'p1', slug: 'alpha', title: 'Alpha' },
    ]

    const forward = buildLlmsTxt({ siteUrl: SITE, entries, urlBudgetChars: 52 })
    const reversed = buildLlmsTxt({
      siteUrl: SITE,
      entries: [...entries].reverse(),
      urlBudgetChars: 52,
    })

    expect(forward).toBe(reversed)
    expect(forward).toContain('- [Alpha](https://example.com/alpha)')
    expect(forward).toContain('- [Bravo](https://example.com/bravo)')
  })

  test('a document inside the budget carries no budget comment', () => {
    const txt = buildLlmsTxt({
      siteUrl: SITE,
      entries: [{ pageId: 'p1', slug: 'ok' }],
      urlBudgetChars: 95,
    })
    expect(txt).toContain('](https://example.com/ok)')
    expect(txt).not.toContain('total URL budget')
  })

  test('percent-encoding expansion cannot blow the heap: 5000 max-length CJK slugs', () => {
    const slug = '你'.repeat(SITEMAP_ENTRY_MAX_CHARS)
    const entries = []
    for (let i = 0; i < 5000; i++) entries.push({ pageId: `p${i}`, slug })
    const started = Date.now()
    const txt = buildLlmsTxt({ siteUrl: SITE, entries })
    const elapsed = Date.now() - started
    expect(txt.length).toBeLessThan(SITEMAP_URL_BUDGET_CHARS * 3)
    expect(txt).toContain('total URL budget -->')
    expect(elapsed).toBeLessThan(2000)
  })

  test('truncateForLlmsTxt leaves short text alone and marks the cut', () => {
    expect(truncateForLlmsTxt('short', 10)).toBe('short')
    expect(truncateForLlmsTxt('0123456789', 10)).toBe('0123456789')
    expect(truncateForLlmsTxt('0123456789A', 10)).toBe('0123456789…')
  })
})

import { describe, expect, test } from 'bun:test'
import { buildLlmsTxt, escapeMarkdownLabel } from '../llmsTxt'

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
})

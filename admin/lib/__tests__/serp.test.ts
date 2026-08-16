import { describe, expect, test } from 'bun:test'
import {
  SERP_DESCRIPTION_LIMIT,
  SERP_TITLE_LIMIT,
  buildSerpPreview,
  buildSerpUrlLine,
  truncateAtWordBoundary,
} from '../serp'
import type { SeoConfigData } from '../../../server/seoConfig'

describe('truncateAtWordBoundary', () => {
  test('returns short text untouched', () => {
    expect(truncateAtWordBoundary('Hello world', 60)).toEqual({
      text: 'Hello world',
      truncated: false,
    })
  })

  test('collapses whitespace before measuring', () => {
    expect(truncateAtWordBoundary('  Hello   world \n', 60)).toEqual({
      text: 'Hello world',
      truncated: false,
    })
  })

  test('text exactly at the limit is not truncated', () => {
    const text = 'x'.repeat(60)
    expect(truncateAtWordBoundary(text, 60)).toEqual({ text, truncated: false })
  })

  test('cuts on a word boundary and appends an ellipsis', () => {
    const result = truncateAtWordBoundary(
      'The quick brown fox jumps over the lazy dog again and again forever',
      30,
    )
    expect(result.truncated).toBe(true)
    expect(result.text.endsWith('…')).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(30)
    // never cuts mid-word: strip the ellipsis and the remainder must be a prefix ending at a space
    const stem = result.text.slice(0, -1)
    expect('The quick brown fox jumps over the lazy dog'.startsWith(stem)).toBe(true)
    expect(stem.includes(' ')).toBe(true)
  })

  test('a space exactly at the boundary keeps the full word before it', () => {
    // 'aaaa bbbb' with max 5: budget 4, slice(0,5)='aaaa ', lastSpace=4 → 'aaaa…'
    expect(truncateAtWordBoundary('aaaa bbbb', 5)).toEqual({ text: 'aaaa…', truncated: true })
  })

  test('hard-cuts a single over-long word', () => {
    const result = truncateAtWordBoundary('Supercalifragilisticexpialidocious', 10)
    expect(result).toEqual({ text: 'Supercali…', truncated: true })
  })

  test('strips trailing punctuation before the ellipsis', () => {
    const result = truncateAtWordBoundary('One, two, three, four, five', 15)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('One, two…')
  })

  // Unpaired-surrogate detector: a high surrogate not followed by a low
  // one, or a low surrogate not preceded by a high one.
  const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

  test('SURROGATE REGRESSION: emoji-heavy text never splits a surrogate pair', () => {
    const emoji = '🚀🎉🦄💡🌍🚀🎉🦄💡🌍🚀🎉🦄💡🌍🚀🎉🦄💡🌍'
    for (const max of [2, 3, 5, 7, 10, 15]) {
      const result = truncateAtWordBoundary(emoji, max)
      expect(result.truncated).toBe(true)
      expect(UNPAIRED_SURROGATE.test(result.text)).toBe(false)
      expect(Array.from(result.text).length).toBeLessThanOrEqual(max)
    }
  })

  test('emoji title with word boundaries cuts between words, pairs intact', () => {
    const result = truncateAtWordBoundary('🚀🚀🚀 rocket launch 🎉🎉🎉 party time', 12)
    expect(result.truncated).toBe(true)
    expect(UNPAIRED_SURROGATE.test(result.text)).toBe(false)
    expect(result.text.endsWith('…')).toBe(true)
  })

  test('limits are measured in code points, not UTF-16 units', () => {
    // 10 emoji = 10 code points but 20 UTF-16 units — fits a max of 10.
    const tenEmoji = '🚀'.repeat(10)
    expect(truncateAtWordBoundary(tenEmoji, 10)).toEqual({ text: tenEmoji, truncated: false })
  })

  test('degenerate budgets: max 0 → empty, max 1 → bare ellipsis, max 2 → one point + ellipsis', () => {
    expect(truncateAtWordBoundary('overflow', 0)).toEqual({ text: '', truncated: true })
    expect(truncateAtWordBoundary('overflow', 1)).toEqual({ text: '…', truncated: true })
    expect(truncateAtWordBoundary('overflow', 2)).toEqual({ text: 'o…', truncated: true })
    expect(truncateAtWordBoundary('🚀🎉🦄', 2)).toEqual({ text: '🚀…', truncated: true })
    // Short input is untouched even at tiny budgets.
    expect(truncateAtWordBoundary('', 0)).toEqual({ text: '', truncated: false })
    expect(truncateAtWordBoundary('a', 1)).toEqual({ text: 'a', truncated: false })
  })
})

describe('buildSerpUrlLine', () => {
  test('origin + nested slug → host › segments', () => {
    expect(buildSerpUrlLine('https://example.com', 'docs/getting-started')).toBe(
      'example.com › docs › getting-started',
    )
  })

  test('empty slug → bare host (homepage)', () => {
    expect(buildSerpUrlLine('https://example.com/', '')).toBe('example.com')
  })

  test('no configured origin → plain path', () => {
    expect(buildSerpUrlLine(undefined, 'about')).toBe('/about')
    expect(buildSerpUrlLine(undefined, '')).toBe('/')
  })

  test('invalid origin (path attached) is ignored like absent', () => {
    expect(buildSerpUrlLine('https://example.com/base', 'about')).toBe('/about')
  })
})

describe('buildSerpPreview', () => {
  const config: SeoConfigData = {
    site: {
      siteName: 'Acme',
      separator: '|',
      siteUrl: 'https://acme.test',
      titleTemplate: '%title% %sep% %site%',
      metaDescription: 'Site default description.',
    },
    tables: {
      posts: { titleTemplate: '%title% — Acme Blog' },
    },
  }

  test('per-entry title wins verbatim (never templated)', () => {
    const preview = buildSerpPreview({
      meta: { title: 'Custom SEO Title' },
      config,
      tableSlug: 'pages',
      slug: 'about',
      pageTitle: 'About Us',
      device: 'desktop',
    })
    expect(preview.title.text).toBe('Custom SEO Title')
    expect(preview.titleSource).toBe('entry')
  })

  test('falls back to the table template, then site template', () => {
    const tablePreview = buildSerpPreview({
      meta: {},
      config,
      tableSlug: 'posts',
      slug: 'hello',
      pageTitle: 'Hello Post',
      device: 'desktop',
    })
    expect(tablePreview.title.text).toBe('Hello Post — Acme Blog')
    expect(tablePreview.titleSource).toBe('template')

    const sitePreview = buildSerpPreview({
      meta: {},
      config,
      tableSlug: 'pages',
      slug: 'about',
      pageTitle: 'About Us',
      device: 'desktop',
    })
    expect(sitePreview.title.text).toBe('About Us | Acme')
    expect(sitePreview.titleSource).toBe('template')
  })

  test('no templates anywhere → host title stands, then slug', () => {
    const preview = buildSerpPreview({
      meta: {},
      config: {},
      tableSlug: 'pages',
      slug: 'about',
      pageTitle: 'About Us',
      device: 'desktop',
    })
    expect(preview.title.text).toBe('About Us')
    expect(preview.titleSource).toBe('page')

    const slugFallback = buildSerpPreview({
      meta: {},
      config: {},
      tableSlug: 'pages',
      slug: 'about',
      device: 'desktop',
    })
    expect(slugFallback.title.text).toBe('about')
  })

  test('SERVER-PARITY REGRESSION: EMPTY page title passes verbatim and the shared slug fallback applies', () => {
    // Reviewer scenario: empty title, site 'Acme', slug 'about', template
    // '%title% - %site%' → the server's mergeSeoMeta renders %title% from
    // the slug ('about - Acme'). The preview must match exactly — the
    // caller passes page.title through VERBATIM (even ''), never
    // substituting site.name for an empty-but-present title.
    const preview = buildSerpPreview({
      meta: {},
      config: { site: { siteName: 'Acme', titleTemplate: '%title% - %site%' } },
      tableSlug: 'pages',
      slug: 'about',
      pageTitle: '',
      device: 'desktop',
    })
    expect(preview.title.text).toBe('about - Acme')
    expect(preview.titleSource).toBe('template')
  })

  test('empty page title with NO template falls back to the slug (not blank)', () => {
    const preview = buildSerpPreview({
      meta: {},
      config: {},
      tableSlug: 'pages',
      slug: 'about',
      pageTitle: '',
      device: 'desktop',
    })
    expect(preview.title.text).toBe('about')
    expect(preview.titleSource).toBe('page')
  })

  test('description: entry → site default → none', () => {
    const entry = buildSerpPreview({
      meta: { metaDescription: 'Entry description.' },
      config,
      tableSlug: 'pages',
      slug: 'about',
      device: 'desktop',
    })
    expect(entry.description.text).toBe('Entry description.')
    expect(entry.descriptionSource).toBe('entry')

    const site = buildSerpPreview({
      meta: {},
      config,
      tableSlug: 'pages',
      slug: 'about',
      device: 'desktop',
    })
    expect(site.description.text).toBe('Site default description.')
    expect(site.descriptionSource).toBe('site')

    const none = buildSerpPreview({
      meta: {},
      config: {},
      tableSlug: 'pages',
      slug: 'about',
      device: 'desktop',
    })
    expect(none.description.text).toBe('')
    expect(none.descriptionSource).toBe('none')
  })

  test('device switches the description budget', () => {
    const long = 'word '.repeat(60).trim()
    const desktop = buildSerpPreview({
      meta: { metaDescription: long },
      config: {},
      tableSlug: 'pages',
      slug: 'a',
      device: 'desktop',
    })
    const mobile = buildSerpPreview({
      meta: { metaDescription: long },
      config: {},
      tableSlug: 'pages',
      slug: 'a',
      device: 'mobile',
    })
    expect(desktop.description.truncated).toBe(true)
    expect(mobile.description.truncated).toBe(true)
    expect(desktop.description.text.length).toBeLessThanOrEqual(SERP_DESCRIPTION_LIMIT.desktop)
    expect(mobile.description.text.length).toBeLessThanOrEqual(SERP_DESCRIPTION_LIMIT.mobile)
    expect(mobile.description.text.length).toBeLessThan(desktop.description.text.length)
  })

  test('long titles truncate at the title limit', () => {
    const preview = buildSerpPreview({
      meta: { title: 'word '.repeat(30).trim() },
      config: {},
      tableSlug: 'pages',
      slug: 'a',
      device: 'desktop',
    })
    expect(preview.title.truncated).toBe(true)
    expect(preview.title.text.length).toBeLessThanOrEqual(SERP_TITLE_LIMIT)
  })

  test('url line uses the configured origin', () => {
    const preview = buildSerpPreview({
      meta: {},
      config,
      tableSlug: 'pages',
      slug: 'about',
      device: 'desktop',
    })
    expect(preview.urlLine).toBe('acme.test › about')
  })
})

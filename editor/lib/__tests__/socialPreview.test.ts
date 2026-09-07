import { describe, expect, test } from 'bun:test'
import {
  FB_DESCRIPTION_LIMIT,
  FB_TITLE_LIMIT,
  X_DESCRIPTION_LIMIT,
  X_TITLE_LIMIT,
  hostFromSiteUrl,
  missingImageHint,
  resolveSocialCard,
  truncateForFacebook,
  truncateForX,
  type SocialCardInput,
} from '../socialPreview'

function input(overrides: Partial<SocialCardInput> = {}): SocialCardInput {
  return {
    title: 'Resolved Title',
    description: 'Resolved description.',
    siteUrl: 'https://example.com',
    ...overrides,
  }
}

describe('truncateForFacebook', () => {
  test('short strings pass through untouched', () => {
    expect(truncateForFacebook('Hello world', 'A short description.')).toEqual({
      title: 'Hello world',
      description: 'A short description.',
    })
  })

  test('long title truncates within the FB budget with an ellipsis', () => {
    const long = 'word '.repeat(40).trim()
    const { title } = truncateForFacebook(long, '')
    expect(title.endsWith('…')).toBe(true)
    expect(Array.from(title).length).toBeLessThanOrEqual(FB_TITLE_LIMIT)
  })

  test('long description truncates within the FB budget', () => {
    const long = 'desc '.repeat(60).trim()
    const { description } = truncateForFacebook('t', long)
    expect(description.endsWith('…')).toBe(true)
    expect(Array.from(description).length).toBeLessThanOrEqual(FB_DESCRIPTION_LIMIT)
  })

  test('collapses whitespace like the SERP preview', () => {
    expect(truncateForFacebook('  Hello \n  world ', ' a  b ')).toEqual({
      title: 'Hello world',
      description: 'a b',
    })
  })
})

describe('truncateForX', () => {
  test('X budgets are tighter for titles than Facebook', () => {
    expect(X_TITLE_LIMIT).toBeLessThan(FB_TITLE_LIMIT)
  })

  test('long values clip within the X budgets', () => {
    const long = 'word '.repeat(60).trim()
    const { title, description } = truncateForX(long, long)
    expect(title.endsWith('…')).toBe(true)
    expect(Array.from(title).length).toBeLessThanOrEqual(X_TITLE_LIMIT)
    expect(description.endsWith('…')).toBe(true)
    expect(Array.from(description).length).toBeLessThanOrEqual(X_DESCRIPTION_LIMIT)
  })

  test('empty description stays empty (no stray ellipsis)', () => {
    expect(truncateForX('Title', '')).toEqual({ title: 'Title', description: '' })
  })
})

describe('hostFromSiteUrl', () => {
  test('strips the scheme and lowercases', () => {
    expect(hostFromSiteUrl('https://Example.COM')).toBe('example.com')
  })

  test('tolerates a trailing slash and keeps a port', () => {
    expect(hostFromSiteUrl('http://example.com:8080/')).toBe('example.com:8080')
  })

  test('unconfigured or invalid origins yield an empty host', () => {
    expect(hostFromSiteUrl(undefined)).toBe('')
    expect(hostFromSiteUrl('')).toBe('')
    // Not a bare origin (path) — must not half-parse into a host.
    expect(hostFromSiteUrl('https://example.com/base')).toBe('')
    expect(hostFromSiteUrl('not a url')).toBe('')
  })
})

describe('resolveSocialCard', () => {
  test('no overrides: resolved title/description flow into both cards', () => {
    const card = resolveSocialCard(input())
    expect(card.fbTitle).toBe('Resolved Title')
    expect(card.xTitle).toBe('Resolved Title')
    expect(card.fbDescription).toBe('Resolved description.')
    expect(card.xDescription).toBe('Resolved description.')
    expect(card.host).toBe('example.com')
    expect(card.imageUrl).toBeNull()
  })

  // ── stored twitter:card decides the X layout (round-5 t4-39) ──────────

  test('no stored twitterCard keeps the large X card (publish emits no tag)', () => {
    expect(resolveSocialCard(input()).xCard).toBe('summary_large_image')
  })

  test('stored twitterCard: summary previews the SMALL X card', () => {
    expect(resolveSocialCard(input({ twitterCard: 'summary' })).xCard).toBe('summary')
  })

  test('stored twitterCard: summary_large_image previews the large X card', () => {
    expect(resolveSocialCard(input({ twitterCard: 'summary_large_image' })).xCard).toBe(
      'summary_large_image',
    )
  })

  test('twitterCard never leaks into the Facebook card or the text values', () => {
    const large = resolveSocialCard(input({ ogImage: 'https://cdn.example.com/a.png' }))
    const small = resolveSocialCard(
      input({ ogImage: 'https://cdn.example.com/a.png', twitterCard: 'summary' }),
    )
    expect(small.fbTitle).toBe(large.fbTitle)
    expect(small.fbDescription).toBe(large.fbDescription)
    expect(small.xTitle).toBe(large.xTitle)
    expect(small.xDescription).toBe(large.xDescription)
    expect(small.imageUrl).toBe(large.imageUrl)
  })

  test('og overrides take precedence over resolved values', () => {
    const card = resolveSocialCard(
      input({ ogTitle: 'OG Title', ogDescription: 'OG description.' }),
    )
    expect(card.fbTitle).toBe('OG Title')
    expect(card.xTitle).toBe('OG Title')
    expect(card.fbDescription).toBe('OG description.')
    expect(card.xDescription).toBe('OG description.')
  })

  test('EMPTY og overrides do not shadow resolved values (nonEmpty rule)', () => {
    const card = resolveSocialCard(input({ ogTitle: '', ogDescription: '' }))
    expect(card.fbTitle).toBe('Resolved Title')
    expect(card.fbDescription).toBe('Resolved description.')
  })

  test('empty resolved description stays empty end to end', () => {
    const card = resolveSocialCard(input({ description: '' }))
    expect(card.fbDescription).toBe('')
    expect(card.xDescription).toBe('')
  })

  test('absolute og:image passes through verbatim', () => {
    const card = resolveSocialCard(input({ ogImage: 'https://cdn.example.net/x.png' }))
    expect(card.imageUrl).toBe('https://cdn.example.net/x.png')
  })

  test('site-relative og:image resolves against the configured origin', () => {
    const card = resolveSocialCard(input({ ogImage: '/img/share.png' }))
    expect(card.imageUrl).toBe('https://example.com/img/share.png')
  })

  test('site-relative og:image with NO siteUrl yields null (publish parity)', () => {
    const card = resolveSocialCard(input({ ogImage: '/img/share.png', siteUrl: '' }))
    expect(card.imageUrl).toBeNull()
    expect(card.host).toBe('')
  })

  test('protocol-relative and empty og:image yield null', () => {
    expect(resolveSocialCard(input({ ogImage: '//evil.example/x.png' })).imageUrl).toBeNull()
    expect(resolveSocialCard(input({ ogImage: '' })).imageUrl).toBeNull()
    expect(resolveSocialCard(input({})).imageUrl).toBeNull()
  })

  test('siteUrl with a trailing slash still joins cleanly (single slash)', () => {
    const card = resolveSocialCard(
      input({ ogImage: '/share.png', siteUrl: 'https://example.com/' }),
    )
    expect(card.imageUrl).toBe('https://example.com/share.png')
  })

  test('long og override is truncated per platform', () => {
    const long = 'word '.repeat(50).trim()
    const card = resolveSocialCard(input({ ogTitle: long }))
    expect(Array.from(card.fbTitle).length).toBeLessThanOrEqual(FB_TITLE_LIMIT)
    expect(Array.from(card.xTitle).length).toBeLessThanOrEqual(X_TITLE_LIMIT)
    expect(card.fbTitle.endsWith('…')).toBe(true)
    expect(card.xTitle.endsWith('…')).toBe(true)
  })
})

describe('missingImageHint', () => {
  test('no stored image = no hint', () => {
    expect(missingImageHint(undefined, 'https://example.com')).toBeNull()
    expect(missingImageHint('', 'https://example.com')).toBeNull()
    expect(missingImageHint(undefined, '')).toBeNull()
  })

  test('resolvable images = no hint (the card shows them instead)', () => {
    expect(missingImageHint('https://cdn.example.net/x.png', '')).toBeNull()
    expect(missingImageHint('http://cdn.example.net/x.png', undefined)).toBeNull()
    // Site-relative WITH a valid origin resolves — nothing to hint about.
    expect(missingImageHint('/img/share.png', 'https://example.com')).toBeNull()
  })

  test('site-relative path + missing origin = the site-URL hint (a Site URL fixes it)', () => {
    expect(missingImageHint('/img/share.png', '')).toBe('needs-site-url')
    expect(missingImageHint('/img/share.png', undefined)).toBe('needs-site-url')
  })

  test('site-relative path + INVALID origin = still the site-URL hint', () => {
    // normalizeSiteOrigin rejects these exactly like an unconfigured site.
    expect(missingImageHint('/img/share.png', 'not a url')).toBe('needs-site-url')
    expect(missingImageHint('/img/share.png', 'https://example.com/base')).toBe('needs-site-url')
  })

  test('other unresolvable values = the neutral hint (a Site URL would NOT fix them)', () => {
    // Protocol-relative — rejected by publish even with a configured origin.
    expect(missingImageHint('//evil.example/x.png', 'https://example.com')).toBe('unpreviewable')
    expect(missingImageHint('//evil.example/x.png', '')).toBe('unpreviewable')
    // Dangerous or non-http schemes.
    expect(missingImageHint('javascript:alert(1)', 'https://example.com')).toBe('unpreviewable')
    expect(missingImageHint('ftp://example.com/x.png', 'https://example.com')).toBe('unpreviewable')
    // Relative without a leading slash (malformed for this contract).
    expect(missingImageHint('img/share.png', 'https://example.com')).toBe('unpreviewable')
    expect(missingImageHint('img/share.png', '')).toBe('unpreviewable')
  })
})

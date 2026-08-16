import { describe, expect, test } from 'bun:test'
import { pageUrl, prettifySegment, slugBreadcrumbs } from '../pageUrl'
import { pageUrl as sitemapPageUrl } from '../../sitemap'

const ORIGIN = 'https://example.com'

describe('pageUrl', () => {
  test('index slug maps to the site root', () => {
    expect(pageUrl(ORIGIN, 'index')).toBe('https://example.com/')
  })

  test('plain and nested slugs keep their separators', () => {
    expect(pageUrl(ORIGIN, 'about')).toBe('https://example.com/about')
    expect(pageUrl(ORIGIN, 'docs/getting-started')).toBe(
      'https://example.com/docs/getting-started',
    )
  })

  test('segments are percent-encoded defensively', () => {
    expect(pageUrl(ORIGIN, 'a b/c&d')).toBe('https://example.com/a%20b/c%26d')
  })

  test('sitemap re-export IS this helper (shared-URL unification)', () => {
    // One mapping for both consumers: identity, not just equal output.
    expect(sitemapPageUrl).toBe(pageUrl)
    for (const slug of ['index', 'about', 'docs/getting-started', 'a b']) {
      expect(sitemapPageUrl(ORIGIN, slug)).toBe(pageUrl(ORIGIN, slug))
    }
  })
})

describe('prettifySegment', () => {
  test('capitalizes and de-hyphenates', () => {
    expect(prettifySegment('case-studies')).toBe('Case Studies')
    expect(prettifySegment('getting_started')).toBe('Getting Started')
    expect(prettifySegment('about')).toBe('About')
  })

  test('falls back to the raw segment when prettifying empties it', () => {
    expect(prettifySegment('---')).toBe('---')
  })
})

describe('slugBreadcrumbs', () => {
  test('index slug yields a single unlinked crumb', () => {
    expect(slugBreadcrumbs(ORIGIN, 'index', 'Welcome')).toEqual([{ name: 'Welcome' }])
    expect(slugBreadcrumbs(ORIGIN, 'index')).toEqual([{ name: 'Home' }])
  })

  test('top-level page: Home → current (title, no url)', () => {
    expect(slugBreadcrumbs(ORIGIN, 'about', 'About Us')).toEqual([
      { name: 'Home', url: 'https://example.com/' },
      { name: 'About Us' },
    ])
  })

  test('nested slug: intermediate segments get cumulative urls', () => {
    expect(slugBreadcrumbs(ORIGIN, 'docs/guides/getting-started', 'Getting Started')).toEqual([
      { name: 'Home', url: 'https://example.com/' },
      { name: 'Docs', url: 'https://example.com/docs' },
      { name: 'Guides', url: 'https://example.com/docs/guides' },
      { name: 'Getting Started' },
    ])
  })

  test('missing title falls back to the prettified last segment', () => {
    expect(slugBreadcrumbs(ORIGIN, 'docs/api-reference')).toEqual([
      { name: 'Home', url: 'https://example.com/' },
      { name: 'Docs', url: 'https://example.com/docs' },
      { name: 'Api Reference' },
    ])
  })

  test('intermediate segments are percent-encoded in urls but readable in names', () => {
    expect(slugBreadcrumbs(ORIGIN, 'a b/leaf', 'Leaf')).toEqual([
      { name: 'Home', url: 'https://example.com/' },
      { name: 'A B', url: 'https://example.com/a%20b' },
      { name: 'Leaf' },
    ])
  })
})

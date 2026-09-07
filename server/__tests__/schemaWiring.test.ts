/**
 * Task 2.3 integration tests — schema.org core graph wiring through the
 * REAL publish pipeline (`composePublishHtml`): merge chain → head payload
 * → JSON-LD tag appended VERBATIM to the seo block → applySeoHead.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { composePublishHtml } from '../metaBlock'
import { pageUrl } from '../sitemap'
import type { SeoConfigData } from '../seoConfig'
import type { SeoMetaPayload } from '../seoMeta'
import {
  getTemplatePageInfo,
  invalidateTemplateFlagCache,
  type PagesTableLike,
} from '../templateDetect'

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>About Us</title>
</head>
<body><h1>About</h1></body>
</html>`

const CONFIG: SeoConfigData = {
  site: {
    siteName: 'Acme Widgets',
    separator: '|',
    siteUrl: 'https://acme.example',
    titleTemplate: '%title% %sep% %site%',
  },
  schema: {
    publisherKind: 'organization',
    publisherName: 'Acme Inc',
    publisherLogoUrl: '/logo.png',
    sameAs: ['https://x.com/acme'],
  },
}

const DATES = {
  datePublished: '2026-08-01T10:00:00.000Z',
  dateModified: '2026-08-10T12:30:00.000Z',
}

/** Extract the JSON-LD payload object from a composed document, or null. */
function extractGraph(html: string): Record<string, unknown> | null {
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)
  if (!m) return null
  return JSON.parse(m[1]!) as Record<string, unknown>
}

function nodes(html: string): Array<Record<string, unknown>> {
  const graph = extractGraph(html)
  if (!graph) throw new Error('expected a JSON-LD graph')
  return graph['@graph'] as Array<Record<string, unknown>>
}

function nodeOfType(html: string, type: string): Record<string, unknown> {
  const node = nodes(html).find((n) => n['@type'] === type)
  if (!node) throw new Error(`expected a ${type} node`)
  return node
}

describe('composePublishHtml — schema.org graph emission', () => {
  test('emits the full connected graph for a regular page', () => {
    const out = composePublishHtml(PAGE_HTML, {}, CONFIG, {
      tableSlug: 'pages',
      slug: 'about',
      schemaPage: DATES,
    })
    const graph = extractGraph(out)
    expect(graph?.['@context']).toBe('https://schema.org')

    const website = nodeOfType(out, 'WebSite')
    expect(website.url).toBe('https://acme.example')
    expect(website.name).toBe('Acme Widgets')
    expect(website.publisher).toEqual({ '@id': 'https://acme.example/#organization' })

    const org = nodeOfType(out, 'Organization')
    expect(org.name).toBe('Acme Inc')
    expect(org.logo).toEqual({ '@type': 'ImageObject', url: 'https://acme.example/logo.png' })
    expect(org.sameAs).toEqual(['https://x.com/acme'])

    const page = nodeOfType(out, 'WebPage')
    // Shared helper parity: the schema page URL IS the sitemap URL.
    expect(page.url).toBe(pageUrl('https://acme.example', 'about'))
    // FINAL merged title (template applied) — the same value baked into <title>.
    expect(page.name).toBe('About Us | Acme Widgets')
    expect(out).toContain('<title>About Us | Acme Widgets</title>')
    expect(page.datePublished).toBe(DATES.datePublished)
    expect(page.dateModified).toBe(DATES.dateModified)

    const breadcrumb = nodeOfType(out, 'BreadcrumbList')
    expect(breadcrumb.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://acme.example/' },
      { '@type': 'ListItem', position: 2, name: 'About Us | Acme Widgets' },
    ])
  })

  test('nested slug: breadcrumb trail with cumulative intermediate urls', () => {
    const out = composePublishHtml(PAGE_HTML, {}, CONFIG, {
      tableSlug: 'pages',
      slug: 'docs/guides/setup',
      schemaPage: {},
    })
    const breadcrumb = nodeOfType(out, 'BreadcrumbList')
    const items = breadcrumb.itemListElement as Array<Record<string, unknown>>
    expect(items.map((i) => i.name)).toEqual([
      'Home',
      'Docs',
      'Guides',
      'About Us | Acme Widgets',
    ])
    expect(items.map((i) => i.item)).toEqual([
      'https://acme.example/',
      'https://acme.example/docs',
      'https://acme.example/docs/guides',
      undefined,
    ])
    // Page URL parity for the nested slug too.
    expect(nodeOfType(out, 'WebPage').url).toBe(
      pageUrl('https://acme.example', 'docs/guides/setup'),
    )
  })

  test('per-entry schemaType overrides the WebPage node type', () => {
    const entry: SeoMetaPayload = { schemaType: 'AboutPage', metaDescription: 'About Acme.' }
    const out = composePublishHtml(PAGE_HTML, entry, CONFIG, {
      tableSlug: 'pages',
      slug: 'about',
      schemaPage: DATES,
    })
    const page = nodeOfType(out, 'AboutPage')
    expect(page.description).toBe('About Acme.')
    expect(nodes(out).some((n) => n['@type'] === 'WebPage')).toBe(false)
  })

  test('missing dates are omitted, never fabricated', () => {
    const out = composePublishHtml(PAGE_HTML, {}, CONFIG, {
      tableSlug: 'pages',
      slug: 'about',
      schemaPage: {},
    })
    const page = nodeOfType(out, 'WebPage')
    expect('datePublished' in page).toBe(false)
    expect('dateModified' in page).toBe(false)
  })

  test('double-apply is idempotent (JSON-LD included)', () => {
    const entry: SeoMetaPayload = { metaDescription: 'Meet the team.' }
    const ctx = { tableSlug: 'pages', slug: 'about', schemaPage: DATES }
    const once = composePublishHtml(PAGE_HTML, entry, CONFIG, ctx)
    const twice = composePublishHtml(once, entry, CONFIG, ctx)
    expect(twice).toBe(once)
    // Exactly one JSON-LD tag survives the re-apply.
    expect(once.split('application/ld+json').length - 1).toBe(1)
  })

  test('</script> attack via per-entry title cannot break out of the tag', () => {
    const entry: SeoMetaPayload = { title: 'Evil</script><script>alert(1)</script>' }
    const out = composePublishHtml(PAGE_HTML, entry, CONFIG, {
      tableSlug: 'pages',
      slug: 'about',
      schemaPage: DATES,
    })
    const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(out)![1]!
    // The JSON body contains no un-escaped closing script tag …
    expect(jsonLd.includes('</script>')).toBe(false)
    expect(jsonLd).toContain('<\\/script>')
    // … and still parses back to the hostile title verbatim.
    const page = (JSON.parse(jsonLd)['@graph'] as Array<Record<string, unknown>>).find(
      (n) => n['@type'] === 'WebPage',
    )!
    expect(page.name).toBe('Evil</script><script>alert(1)</script>')
  })

  test('schema disabled → no JSON-LD, rest of the head untouched', () => {
    const disabled: SeoConfigData = {
      ...CONFIG,
      schema: { ...CONFIG.schema, enabled: false },
    }
    const out = composePublishHtml(PAGE_HTML, { metaDescription: 'D' }, disabled, {
      tableSlug: 'pages',
      slug: 'about',
      schemaPage: DATES,
    })
    expect(out).not.toContain('application/ld+json')
    expect(out).toContain('<meta property="og:description" content="D">')
  })

  test('template/composed render (no schemaPage) → no JSON-LD', () => {
    const out = composePublishHtml(PAGE_HTML, {}, CONFIG, {
      tableSlug: 'pages',
      slug: 'post-template',
    })
    expect(out).not.toContain('application/ld+json')
  })

  test('no configured site origin → no JSON-LD; empty config stays a byte-identical no-op', () => {
    const noOrigin: SeoConfigData = { schema: { publisherName: 'Acme Inc' } }
    const out = composePublishHtml(PAGE_HTML, {}, noOrigin, {
      tableSlug: 'pages',
      slug: 'about',
      schemaPage: DATES,
    })
    expect(out).not.toContain('application/ld+json')
    // Nothing stored anywhere → the document passes through byte-identical.
    expect(
      composePublishHtml(PAGE_HTML, {}, {}, { tableSlug: 'pages', slug: 'about', schemaPage: DATES }),
    ).toBe(PAGE_HTML)
  })

  test('no publisher configured → graph still emits WebSite + WebPage', () => {
    const noPublisher: SeoConfigData = { site: CONFIG.site }
    const out = composePublishHtml(PAGE_HTML, {}, noPublisher, {
      tableSlug: 'pages',
      slug: 'about',
      schemaPage: DATES,
    })
    expect(nodeOfType(out, 'WebSite')['@id']).toBe('https://acme.example/#website')
    expect(nodeOfType(out, 'WebPage').isPartOf).toEqual({ '@id': 'https://acme.example/#website' })
    expect(nodes(out).some((n) => n['@type'] === 'Organization')).toBe(false)
  })

  test('index slug: root page URL and a single unlinked breadcrumb', () => {
    const out = composePublishHtml(PAGE_HTML, {}, CONFIG, {
      tableSlug: 'pages',
      slug: 'index',
      schemaPage: DATES,
    })
    expect(nodeOfType(out, 'WebPage').url).toBe(pageUrl('https://acme.example', 'index'))
    const breadcrumb = nodeOfType(out, 'BreadcrumbList')
    expect(breadcrumb.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'About Us | Acme Widgets' },
    ])
  })
})

describe('templateDetect — row timestamps for schema dates', () => {
  beforeEach(() => invalidateTemplateFlagCache())

  function tableWith(entry: Awaited<ReturnType<PagesTableLike['get']>>): PagesTableLike {
    return { get: async () => entry }
  }

  test('non-template pages surface createdAt/updatedAt from the SAME lookup', async () => {
    const info = await getTemplatePageInfo(
      tableWith({
        cells: {},
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-10T12:30:00.000Z',
      }),
      'pg1',
    )
    expect(info).toEqual({
      isTemplate: false,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-10T12:30:00.000Z',
    })
  })

  test('template pages and unreadable rows carry no dates', async () => {
    const tpl = await getTemplatePageInfo(
      tableWith({ cells: { templateEnabled: true }, createdAt: '2026-08-01' }),
      'pg2',
    )
    expect(tpl.isTemplate).toBe(true)
    expect(tpl.createdAt).toBeUndefined()
    const missing = await getTemplatePageInfo(tableWith(null), 'pg3')
    expect(missing).toEqual({ isTemplate: true })
  })

  test('malformed timestamp values are dropped (storage data posture)', async () => {
    const info = await getTemplatePageInfo(
      tableWith({ cells: {}, createdAt: '', updatedAt: undefined }),
      'pg4',
    )
    expect(info).toEqual({ isTemplate: false })
  })
})

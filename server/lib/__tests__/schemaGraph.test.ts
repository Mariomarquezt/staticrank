import { describe, expect, test } from 'bun:test'
import { buildSchemaGraph, type SchemaGraphInput } from '../schemaGraph'

function jsonFrom(output: string | undefined): { '@context': string; '@graph': Array<Record<string, any>> } {
  expect(output).toBeDefined()
  const json = output!.replace(/^<script type="application\/ld\+json">/, '').replace(/<\/script>$/, '')
  return JSON.parse(json.replace(/<\\\//g, '</').replace(/<\\!--/g, '<!--'))
}

describe('buildSchemaGraph', () => {
  test('builds the complete interconnected graph', () => {
    const input: SchemaGraphInput = {
      siteUrl: 'https://example.com/',
      siteName: 'Example',
      publisher: {
        kind: 'organization',
        name: 'Example Inc.',
        logoUrl: '/brand/logo.png',
        sameAs: ['https://social.example.com/example'],
      },
      page: {
        url: 'https://example.com/about/',
        title: 'About Example',
        description: 'A description.',
        type: 'AboutPage',
        datePublished: '2025-01-02T03:04:05Z',
        dateModified: '2025-01-03',
        imageUrl: '/images/about.jpg',
        breadcrumbs: [
          { name: 'Home', url: '/' },
          { name: 'About' },
        ],
      },
    }

    const result = buildSchemaGraph(input)
    const parsed = jsonFrom(result)
    expect(parsed['@context']).toBe('https://schema.org')
    expect(parsed['@graph']).toHaveLength(4)
    expect(parsed['@graph'][0]).toEqual({
      '@type': 'WebSite',
      '@id': 'https://example.com/#website',
      url: 'https://example.com',
      name: 'Example',
      publisher: { '@id': 'https://example.com/#organization' },
    })
    expect(parsed['@graph'][1]).toEqual({
      '@type': 'Organization',
      '@id': 'https://example.com/#organization',
      name: 'Example Inc.',
      logo: { '@type': 'ImageObject', url: 'https://example.com/brand/logo.png' },
      sameAs: ['https://social.example.com/example'],
    })
    expect(parsed['@graph'][2]).toEqual({
      '@type': 'AboutPage',
      '@id': 'https://example.com/about/#webpage',
      url: 'https://example.com/about/',
      name: 'About Example',
      description: 'A description.',
      isPartOf: { '@id': 'https://example.com/#website' },
      datePublished: '2025-01-02T03:04:05Z',
      dateModified: '2025-01-03',
      primaryImageOfPage: { '@type': 'ImageObject', url: 'https://example.com/images/about.jpg' },
      breadcrumb: { '@id': 'https://example.com/about/#breadcrumb' },
    })
    expect(parsed['@graph'][3]).toEqual({
      '@type': 'BreadcrumbList',
      '@id': 'https://example.com/about/#breadcrumb',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.com/' },
        { '@type': 'ListItem', position: 2, name: 'About' },
      ],
    })
  })

  test('supports site-only and page-only minimal graphs', () => {
    expect(jsonFrom(buildSchemaGraph({ siteUrl: 'https://example.com', page: {} }))['@graph']).toEqual([
      { '@type': 'WebSite', '@id': 'https://example.com/#website', url: 'https://example.com' },
    ])
    expect(jsonFrom(buildSchemaGraph({ page: { url: 'https://example.com/page' } }))['@graph']).toEqual([
      { '@type': 'WebPage', '@id': 'https://example.com/page/#webpage', url: 'https://example.com/page' },
    ])
  })

  test('returns undefined below the minimum usable URL', () => {
    expect(buildSchemaGraph({ page: {} })).toBeUndefined()
    expect(buildSchemaGraph({ siteUrl: 'javascript:alert(1)', page: { url: '/page' } })).toBeUndefined()
  })

  test('emits a Person publisher as a reference plus a separate node', () => {
    const graph = jsonFrom(
      buildSchemaGraph({
        siteUrl: 'https://example.com',
        publisher: { kind: 'person', name: 'Ada Lovelace' },
        page: {},
      }),
    )['@graph']
    expect(graph[0].publisher).toEqual({ '@id': 'https://example.com/#person' })
    expect(graph[1]).toEqual({ '@type': 'Person', '@id': 'https://example.com/#person', name: 'Ada Lovelace' })
  })

  test('skips empty breadcrumb entries and omits item for the current page', () => {
    const graph = jsonFrom(
      buildSchemaGraph({
        siteUrl: 'https://example.com',
        page: {
          url: 'https://example.com/current',
          breadcrumbs: [{ name: '', url: '' }, { name: 'Section', url: '/section' }, { name: 'Current' }],
        },
      }),
    )['@graph']
    expect(graph[2].itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Section', item: 'https://example.com/section' },
      { '@type': 'ListItem', position: 2, name: 'Current' },
    ])
  })

  test('escapes script and HTML-comment breakout attempts in all text values', () => {
    const output = buildSchemaGraph({
      siteUrl: 'https://example.com',
      siteName: '</script><!-- site',
      publisher: { kind: 'organization', name: '</script><!-- publisher' },
      page: {
        url: 'https://example.com/page',
        title: '</script><!-- title',
        description: '</script><!-- description',
        breadcrumbs: [{ name: '</script><!-- breadcrumb' }],
      },
    })!
    expect(output).not.toContain('</script><!--')
    expect(output).toContain('<\\/script>')
    expect(output).toContain('\\u003c!--')
    expect(jsonFrom(output)['@graph'][0].name).toBe('</script><!-- site')
    expect(jsonFrom(output)['@graph'][2].description).toBe('</script><!-- description')
  })

  test('resolves relative HTTP URLs and drops non-HTTP URLs', () => {
    const graph = jsonFrom(
      buildSchemaGraph({
        siteUrl: 'https://example.com/docs/',
        publisher: { kind: 'organization', name: 'Org', logoUrl: 'javascript:bad' },
        page: {
          url: 'guide',
          imageUrl: 'data:image/png;base64,abc',
          breadcrumbs: [
            { name: 'Docs', url: '/docs' },
            { name: 'Guide', url: 'mailto:test@example.com' },
          ],
        },
      }),
    )['@graph']
    expect(graph[1].logo).toBeUndefined()
    expect(graph[2].url).toBe('https://example.com/docs/guide')
    expect(graph[2].primaryImageOfPage).toBeUndefined()
    expect(graph[3].itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Docs', item: 'https://example.com/docs' },
      { '@type': 'ListItem', position: 2, name: 'Guide' },
    ])
  })

  test('normalizes trailing slashes only in generated identifiers', () => {
    const graph = jsonFrom(
      buildSchemaGraph({
        siteUrl: 'https://example.com/',
        page: { url: 'https://example.com/page///' },
      }),
    )['@graph']
    expect(graph[0]['@id']).toBe('https://example.com/#website')
    expect(graph[1]['@id']).toBe('https://example.com/page/#webpage')
    expect(graph[1].url).toBe('https://example.com/page///')
  })

  test('is deterministic for the same input', () => {
    const input: SchemaGraphInput = { siteUrl: 'https://example.com', page: { url: '/page', title: 'Page' } }
    expect(buildSchemaGraph(input)).toBe(buildSchemaGraph(input))
  })
})

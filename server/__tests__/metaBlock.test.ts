import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_SEPARATOR,
  buildSeoHeadPayload,
  extractTitleText,
  mergeSeoMeta,
  normalizeSiteOrigin,
  resolveAbsoluteUrl,
  resolveSourceTitle,
} from '../metaBlock'
import type { SeoMetaPayload } from '../seoMeta'

describe('resolveAbsoluteUrl', () => {
  test('absolute http(s) URLs pass through', () => {
    expect(resolveAbsoluteUrl('https://example.com/a', undefined)).toBe('https://example.com/a')
    expect(resolveAbsoluteUrl('http://example.com/a', 'https://other.com')).toBe(
      'http://example.com/a',
    )
  })

  test('relative path joins onto the site URL', () => {
    expect(resolveAbsoluteUrl('/about', 'https://example.com')).toBe('https://example.com/about')
  })

  test('a single trailing slash on the site URL is normalized before joining', () => {
    expect(resolveAbsoluteUrl('/about', 'https://example.com/')).toBe('https://example.com/about')
  })

  test('relative path without a site URL does not resolve', () => {
    expect(resolveAbsoluteUrl('/about', undefined)).toBeUndefined()
  })

  test('protocol-relative and non-rooted values never resolve', () => {
    expect(resolveAbsoluteUrl('//evil.example/x', 'https://example.com')).toBeUndefined()
    expect(resolveAbsoluteUrl('about', 'https://example.com')).toBeUndefined()
  })

  test('absent or empty value resolves to nothing', () => {
    expect(resolveAbsoluteUrl(undefined, 'https://example.com')).toBeUndefined()
    expect(resolveAbsoluteUrl('', 'https://example.com')).toBeUndefined()
  })

  test('a malformed site URL is not used as a base', () => {
    expect(resolveAbsoluteUrl('/about', 'not-a-url')).toBeUndefined()
    expect(resolveAbsoluteUrl('/about', 'https://')).toBeUndefined()
  })

  test('a stored siteUrl that is not a bare origin is never used as a base', () => {
    // Stale pre-validation records could carry these; joining would emit
    // malformed URLs (…/base?x=1/about), so they are dropped instead.
    expect(resolveAbsoluteUrl('/about', 'https://example.com/base?x=1')).toBeUndefined()
    expect(resolveAbsoluteUrl('/about', 'https://@/')).toBeUndefined()
    expect(resolveAbsoluteUrl('/about', 'https://:443/')).toBeUndefined()
    expect(resolveAbsoluteUrl('/about', 'https://example.com//')).toBeUndefined()
  })
})

describe('normalizeSiteOrigin', () => {
  test('accepts bare origins, with or without port, normalizing the trailing slash', () => {
    expect(normalizeSiteOrigin('https://example.com')).toBe('https://example.com')
    expect(normalizeSiteOrigin('https://example.com/')).toBe('https://example.com')
    expect(normalizeSiteOrigin('http://example.com:8080/')).toBe('http://example.com:8080')
    expect(normalizeSiteOrigin('https://[2001:db8::1]:8443')).toBe('https://[2001:db8::1]:8443')
  })

  test('rejects userinfo, empty host, paths, queries, fragments', () => {
    expect(normalizeSiteOrigin('https://@/')).toBeUndefined()
    expect(normalizeSiteOrigin('https://:443/')).toBeUndefined()
    expect(normalizeSiteOrigin('https://user@example.com')).toBeUndefined()
    expect(normalizeSiteOrigin('https://example.com/base?x=1')).toBeUndefined()
    expect(normalizeSiteOrigin('https://example.com/path')).toBeUndefined()
    expect(normalizeSiteOrigin('https://example.com?x=1')).toBeUndefined()
    expect(normalizeSiteOrigin('https://example.com#f')).toBeUndefined()
    expect(normalizeSiteOrigin('ftp://example.com')).toBeUndefined()
    expect(normalizeSiteOrigin('')).toBeUndefined()
    expect(normalizeSiteOrigin(undefined)).toBeUndefined()
  })
})

describe('resolveSourceTitle', () => {
  const decorate = (block: string, title = 'Decorated | Site') =>
    `<head><title>${title}</title><!--seo:start-->\n${block}\n<!--seo:end--></head><body></body>`

  test('without any stash the current title is the source', () => {
    expect(resolveSourceTitle('<head><title>Plain</title></head>')).toBe('Plain')
  })

  test('honors a stash inside the paired block when the fingerprint matches', () => {
    const html = decorate(
      '<!--seo:source-title:Original-->\n<!--seo:title-fp:Decorated | Site-->',
    )
    expect(resolveSourceTitle(html)).toBe('Original')
  })

  test('FORGERY GUARD: a look-alike comment outside the paired block is ignored', () => {
    const html =
      '<head><!--seo:source-title:EVIL--><!--seo:title-fp:Plain--><title>Plain</title></head>'
    expect(resolveSourceTitle(html)).toBe('Plain')
  })

  test('a stash without a fingerprint is not honored', () => {
    const html = decorate('<!--seo:source-title:Original-->')
    expect(resolveSourceTitle(html)).toBe('Decorated | Site')
  })

  test('STALE-STASH GUARD: an edited title beats the stash', () => {
    const html = decorate(
      '<!--seo:source-title:Original-->\n<!--seo:title-fp:Decorated | Site-->',
      'Hand-Edited Title',
    )
    expect(resolveSourceTitle(html)).toBe('Hand-Edited Title')
  })

  test('an honored empty stash means "no source title" (slug fallback)', () => {
    const html = decorate('<!--seo:source-title:-->\n<!--seo:title-fp:Decorated | Site-->')
    expect(resolveSourceTitle(html)).toBeUndefined()
  })

  test('an orphan start marker does not create a fake block', () => {
    const html =
      '<head><!--seo:start--><!--seo:source-title:EVIL--><!--seo:title-fp:Plain-->' +
      '<title>Plain</title></head>'
    expect(resolveSourceTitle(html)).toBe('Plain')
  })
})

describe('extractTitleText', () => {
  test('extracts and entity-decodes the first title', () => {
    const html = '<html><head><title>Fish &amp; Chips &#x27;n&#39; Co &lt;3</title></head><body></body></html>'
    expect(extractTitleText(html)).toBe("Fish & Chips 'n' Co <3")
  })

  test('collapses internal whitespace', () => {
    expect(extractTitleText('<head><title>  A\n  B\t C </title></head>')).toBe('A B C')
  })

  test('ignores a commented-out decoy title', () => {
    const html = '<head><!-- <title>Decoy</title> --><title>Real</title></head>'
    expect(extractTitleText(html)).toBe('Real')
  })

  test('returns undefined without a head, without a title, or when empty', () => {
    expect(extractTitleText('<body>no head</body>')).toBeUndefined()
    expect(extractTitleText('<head><meta charset="utf-8"></head>')).toBeUndefined()
    expect(extractTitleText('<head><title>   </title></head>')).toBeUndefined()
  })

  test('leaves unknown or invalid entities literal', () => {
    expect(extractTitleText('<head><title>&copy; &#xFFFFFFFF; &bogus;</title></head>')).toBe(
      '&copy; &#xFFFFFFFF; &bogus;',
    )
  })

  // Review 3.6 #2: the scan is mask-aware — script/style/noscript raw-text
  // bodies are opaque, so a <title> string inside them can never win.
  test('a <title> decoy inside a head script cannot win (mask-aware)', () => {
    expect(
      extractTitleText(
        '<head><script>const x="<title>evil</title>"</script><title>real</title></head>',
      ),
    ).toBe('real')
  })

  test('style and noscript decoys are masked too', () => {
    expect(
      extractTitleText(
        '<head><style>/* <title>css decoy</title> */</style>' +
          '<noscript><title>ns decoy</title></noscript><title>Real</title></head>',
      ),
    ).toBe('Real')
  })

  test('a script decoy with no real title yields undefined, not the decoy', () => {
    expect(
      extractTitleText('<head><script>document.title = "<title>fake</title>"</script></head>'),
    ).toBeUndefined()
  })

  test('boundary check: <titles> does not open and </titlex> does not close', () => {
    expect(extractTitleText('<head><titles>not it</titles><title>yes</title></head>')).toBe('yes')
    expect(extractTitleText('<head><title>a</titlex>b</title></head>')).toBe('a</titlex>b')
  })

  // Review 3.6 #2 parity guard: extractTitleText is shared with the free
  // filter's IndexNow payload — for benign input the mask-aware scan must
  // be BYTE-IDENTICAL to the historical comment-stripping regex reader.
  test('parity: benign fixtures match the historical regex extraction exactly', () => {
    function legacyExtract(html: string): string | undefined {
      const headClose = /<\/head\s*>/i.exec(html)
      if (!headClose) return undefined
      const head = html.slice(0, headClose.index).replace(/<!--[\s\S]*?-->/g, '')
      const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)
      if (!title) return undefined
      // decode+collapse identically to the production path: reuse the
      // production reader on a minimal document carrying the raw text.
      const text = extractTitleText(`<head><title>${title[1]!}</title></head>`)
      return text
    }
    const fixtures = [
      '<html><head><title>Fish &amp; Chips &#x27;n&#39; Co &lt;3</title></head><body></body></html>',
      '<head><title>  A\n  B\t C </title></head>',
      '<head><!-- <title>Decoy</title> --><title>Real</title></head>',
      '<body>no head</body>',
      '<head><meta charset="utf-8"></head>',
      '<head><title>   </title></head>',
      '<head><title>&copy; &#xFFFFFFFF; &bogus;</title></head>',
      '<HEAD><TITLE>Upper Case</TITLE></HEAD>',
      '<head><meta name="x" content="a > b"><title>After Meta</title></head>',
      '<head><title data-x="1">Attributed</title></head>',
      '<head><title>First</title><title>Second</title></head>',
      '<head><link rel="icon" href="/f.ico"><title>With Link</title></head>',
      '<html><head>\n  <title>\n    Multi\n    Line\n  </title>\n</head><body></body></html>',
    ]
    for (const html of fixtures) {
      expect(extractTitleText(html)).toBe(legacyExtract(html)!)
    }
  })
})

describe('mergeSeoMeta', () => {
  const ctx = { tableSlug: 'pages', slug: 'about', pageTitle: 'About Us' }

  test('everything empty merges to an empty payload', () => {
    expect(mergeSeoMeta({}, {}, ctx)).toEqual({})
  })

  test('per-entry title wins verbatim over any template', () => {
    const merged = mergeSeoMeta(
      { title: 'Custom SEO Title' },
      {
        site: { siteName: 'Acme', titleTemplate: '%title% %sep% %site%' },
        tables: { pages: { titleTemplate: '%title% | %site%' } },
      },
      ctx,
    )
    expect(merged.title).toBe('Custom SEO Title')
  })

  test('table template beats site template; %title% comes from the page title', () => {
    const merged = mergeSeoMeta(
      {},
      {
        site: { siteName: 'Acme', separator: '|', titleTemplate: 'SITE %title%' },
        tables: { pages: { titleTemplate: '%title% %sep% %site%' } },
      },
      ctx,
    )
    expect(merged.title).toBe('About Us | Acme')
  })

  test('site template applies when the table has none', () => {
    const merged = mergeSeoMeta(
      {},
      { site: { siteName: 'Acme', titleTemplate: '%title% %sep% %site%' } },
      ctx,
    )
    expect(merged.title).toBe(`About Us ${DEFAULT_SEPARATOR} Acme`)
  })

  test('%title% falls back to the slug when the page has no title text', () => {
    const merged = mergeSeoMeta(
      {},
      { site: { titleTemplate: '%title%' } },
      { tableSlug: 'pages', slug: 'about' },
    )
    expect(merged.title).toBe('about')
  })

  test('%slug% is available and empty variables collapse the separator', () => {
    const merged = mergeSeoMeta(
      {},
      { site: { separator: '·', titleTemplate: '%slug% · %site%' } },
      { tableSlug: 'pages', slug: 'about' },
    )
    // %site% is empty → the trailing separator collapses away.
    expect(merged.title).toBe('about')
  })

  test('a template rendering to nothing yields no title', () => {
    const merged = mergeSeoMeta({}, { site: { titleTemplate: '%site%' } }, ctx)
    expect(merged.title).toBeUndefined()
  })

  test('description: per-entry beats the site default; default fills the gap', () => {
    const config = { site: { metaDescription: 'Site default.' } }
    expect(mergeSeoMeta({ metaDescription: 'Mine.' }, config, ctx).metaDescription).toBe('Mine.')
    expect(mergeSeoMeta({}, config, ctx).metaDescription).toBe('Site default.')
  })

  test('canonical, robots, OG, twitter come from the entry only', () => {
    const entry: SeoMetaPayload = {
      canonical: '/about',
      robots: { noindex: true },
      ogTitle: 'OG',
      ogDescription: 'OG desc',
      ogImage: '/og.png',
      twitterCard: 'summary',
    }
    const merged = mergeSeoMeta(entry, { site: { siteName: 'Acme' } }, ctx)
    expect(merged.canonical).toBe('/about')
    expect(merged.robots).toEqual({ noindex: true })
    expect(merged.ogTitle).toBe('OG')
    expect(merged.ogDescription).toBe('OG desc')
    expect(merged.ogImage).toBe('/og.png')
    expect(merged.twitterCard).toBe('summary')
  })
})

describe('buildSeoHeadPayload', () => {
  test('empty merged meta produces an all-undefined payload (no-op contract)', () => {
    const payload = buildSeoHeadPayload({}, {})
    expect(payload.title).toBeUndefined()
    expect(payload.metaDescription).toBeUndefined()
    expect(payload.block).toBeUndefined()
  })

  test('title and description pass as plain text (applySeoHead escapes them)', () => {
    const payload = buildSeoHeadPayload(
      { title: 'A & B <C>', metaDescription: 'D "E"' },
      {},
    )
    expect(payload.title).toBe('A & B <C>')
    expect(payload.metaDescription).toBe('D "E"')
  })

  test('canonical emitted only when resolved to an absolute URL', () => {
    const absolute = buildSeoHeadPayload({ canonical: 'https://example.com/x' }, {})
    expect(absolute.block).toBe('<link rel="canonical" href="https://example.com/x">')

    const joined = buildSeoHeadPayload({ canonical: '/x' }, { siteUrl: 'https://example.com' })
    expect(joined.block).toBe('<link rel="canonical" href="https://example.com/x">')

    const unresolved = buildSeoHeadPayload({ canonical: '/x' }, {})
    expect(unresolved.block).toBeUndefined()
  })

  test('canonical URL is attribute-escaped', () => {
    const payload = buildSeoHeadPayload(
      { canonical: 'https://example.com/x?a=1&b="2"' },
      {},
    )
    expect(payload.block).toBe(
      '<link rel="canonical" href="https://example.com/x?a=1&amp;b=&quot;2&quot;">',
    )
  })

  test('robots: only true flags emit; false/absent emit nothing', () => {
    expect(buildSeoHeadPayload({ robots: { noindex: true, nofollow: true } }, {}).block).toBe(
      '<meta name="robots" content="noindex, nofollow">',
    )
    expect(buildSeoHeadPayload({ robots: { nofollow: true } }, {}).block).toBe(
      '<meta name="robots" content="nofollow">',
    )
    expect(buildSeoHeadPayload({ robots: { noindex: false, nofollow: false } }, {}).block)
      .toBeUndefined()
    expect(buildSeoHeadPayload({ robots: {} }, {}).block).toBeUndefined()
  })

  test('OG tags fall back to title/description; og:image has no fallback', () => {
    const payload = buildSeoHeadPayload(
      { title: 'Page Title', metaDescription: 'Page desc.' },
      {},
    )
    expect(payload.block).toBe(
      '<meta property="og:title" content="Page Title">\n' +
        '<meta property="og:description" content="Page desc.">',
    )
  })

  test('explicit OG fields beat the fallbacks', () => {
    const payload = buildSeoHeadPayload(
      {
        title: 'Page Title',
        metaDescription: 'Page desc.',
        ogTitle: 'OG Title',
        ogDescription: 'OG desc.',
        ogImage: 'https://example.com/og.png',
      },
      {},
    )
    expect(payload.block).toBe(
      '<meta property="og:title" content="OG Title">\n' +
        '<meta property="og:description" content="OG desc.">\n' +
        '<meta property="og:image" content="https://example.com/og.png">',
    )
  })

  test('relative og:image resolves against the site URL or is dropped', () => {
    expect(
      buildSeoHeadPayload({ ogImage: '/og.png' }, { siteUrl: 'https://example.com' }).block,
    ).toBe('<meta property="og:image" content="https://example.com/og.png">')
    expect(buildSeoHeadPayload({ ogImage: '/og.png' }, {}).block).toBeUndefined()
  })

  test('OG values are attribute-escaped', () => {
    const payload = buildSeoHeadPayload({ ogTitle: 'A "quoted" <title> & more' }, {})
    expect(payload.block).toBe(
      '<meta property="og:title" content="A &quot;quoted&quot; &lt;title&gt; &amp; more">',
    )
  })

  test('twitter:card brings twitter:title/description via the OG fallbacks', () => {
    const payload = buildSeoHeadPayload(
      { title: 'T', metaDescription: 'D', twitterCard: 'summary_large_image' },
      {},
    )
    expect(payload.block).toBe(
      '<meta property="og:title" content="T">\n' +
        '<meta property="og:description" content="D">\n' +
        '<meta name="twitter:card" content="summary_large_image">\n' +
        '<meta name="twitter:title" content="T">\n' +
        '<meta name="twitter:description" content="D">',
    )
  })

  test('twitter:card alone emits only the card tag', () => {
    expect(buildSeoHeadPayload({ twitterCard: 'summary' }, {}).block).toBe(
      '<meta name="twitter:card" content="summary">',
    )
  })

  test('no twitter tags without a stored card type', () => {
    const payload = buildSeoHeadPayload({ title: 'T' }, {})
    expect(payload.block).not.toContain('twitter:')
  })

  test('never emits an empty-content tag', () => {
    const payload = buildSeoHeadPayload(
      { title: '', metaDescription: '', ogTitle: '', ogDescription: '', ogImage: '' },
      {},
    )
    expect(payload.title).toBeUndefined()
    expect(payload.metaDescription).toBeUndefined()
    expect(payload.block).toBeUndefined()
  })
})

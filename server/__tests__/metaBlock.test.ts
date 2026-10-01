import { describe, expect, test } from 'bun:test'
import { applySeoHead } from '../lib/headSurgeon'
import {
  DEFAULT_SEPARATOR,
  buildSeoHeadPayload,
  composePublishHtml,
  extractTitleText,
  mergeSeoMeta,
  normalizeSiteOrigin,
  resolveAbsoluteUrl,
  resolveCanonical,
  resolveSourceTitle,
  selfCanonicalUrl,
  TITLE_TEXT_MAX,
} from '../metaBlock'
import type { SeoConfigData } from '../seoConfig'
import type { SeoMetaPayload } from '../seoMeta'
import { SITEMAP_ENTRY_MAX_CHARS, buildSitemapXml } from '../sitemap'

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

  // round-5 item 4: the stash reader must mask exactly like headSurgeon's
  // block remover, or a marker pair that is only TEXT inside a head script
  // wins over the plugin's real (trailing) block.
  test('FORGERY GUARD: a marker pair inside a head <script> is not a block', () => {
    const forged =
      '<script>var s = "<!--seo:start--><!--seo:source-title:EVIL-->' +
      '<!--seo:title-fp:Plain--><!--seo:end-->"</script>'
    const html = `<head>${forged}<title>Plain</title></head><body></body>`
    expect(resolveSourceTitle(html)).toBe('Plain')
  })

  test('FORGERY GUARD: a forged pair inside a script loses to the real block', () => {
    const forged =
      '<script>var s = "<!--seo:start--><!--seo:source-title:EVIL-->' +
      '<!--seo:title-fp:Decorated | Site--><!--seo:end-->"</script>'
    const html =
      `<head>${forged}<title>Decorated | Site</title><!--seo:start-->\n` +
      '<!--seo:source-title:Original-->\n<!--seo:title-fp:Decorated | Site-->\n' +
      '<!--seo:end--></head><body></body>'
    expect(resolveSourceTitle(html)).toBe('Original')
  })

  test('FORGERY GUARD: a marker pair nested inside an ordinary comment is inert', () => {
    const html =
      '<head><!-- <!--seo:start--><!--seo:source-title:EVIL-->' +
      '<!--seo:title-fp:Plain--><!--seo:end--> --><title>Plain</title></head>'
    expect(resolveSourceTitle(html)).toBe('Plain')
  })

  test('the real block is still read when a script sits before it', () => {
    const html =
      '<head><script>var s = "harmless"</script><title>Decorated | Site</title>' +
      '<!--seo:start-->\n<!--seo:source-title:Original-->\n' +
      '<!--seo:title-fp:Decorated | Site-->\n<!--seo:end--></head><body></body>'
    expect(resolveSourceTitle(html)).toBe('Original')
  })

  // glmflash-09: fingerprint must be clamped like extractTitleText, or long
  // decorated titles false-stale the stash on every republish.
  test('fingerprint clamp: honors stash when decorated title exceeds TITLE_TEXT_MAX', () => {
    const decorated = 'd'.repeat(TITLE_TEXT_MAX + 50)
    const html =
      `<head><title>${decorated}</title><!--seo:start-->\n` +
      '<!--seo:source-title:Original-->\n' +
      `<!--seo:title-fp:${decorated}-->\n` +
      '<!--seo:end--></head><body></body>'
    expect(resolveSourceTitle(html)).toBe('Original')
  })

  test('fingerprint clamp: an edit within the clamp window still stale-stashes', () => {
    const decorated = 'd'.repeat(TITLE_TEXT_MAX + 50)
    const html =
      `<head><title>${decorated}</title><!--seo:start-->\n` +
      '<!--seo:source-title:Original-->\n' +
      `<!--seo:title-fp:${decorated}-->\n` +
      '<!--seo:end--></head><body></body>'
    const edited = html.replace(
      `<title>${decorated}</title>`,
      '<title>Hand-Edited Title</title>',
    )
    expect(resolveSourceTitle(edited)).toBe('Hand-Edited Title')
  })

  // The documented deliberate choice, asserted nowhere else: two titles that
  // differ ONLY after code point TITLE_TEXT_MAX are UNCHANGED as far as the
  // plugin can tell. extractTitleText clamps the live title on read, so
  // anything past code point 512 is unobservable — storing or comparing more
  // would make the check unfalsifiable, and titles that far past the clamp
  // collapse onto one fingerprint BY DESIGN (see titleFingerprintText).
  //
  // Both pairs are anchored on a base of exactly TITLE_TEXT_MAX code points
  // and first differ exactly one code point on either side of the clamp, so
  // neither can pass by accident of padding:
  //   - differsAt513: first difference at code point 513 → past the clamp →
  //     the two collapse onto one fingerprint → UNCHANGED, stash honoured.
  //   - differsAt512: first difference at code point 512 → inside the clamp →
  //     the fingerprints differ → STALE, the edit is detected.
  // extractTitleText applies the same clamp the fingerprint does, so the two
  // expectations on it are a direct reading of where that boundary sits.
  test('titles differing only after code point TITLE_TEXT_MAX are UNCHANGED', () => {
    const base = 'd'.repeat(TITLE_TEXT_MAX)
    const differsAt513 = base + 'E'
    const differsAt512 = 'd'.repeat(TITLE_TEXT_MAX - 1) + 'X'

    const html =
      `<head><title>${base}</title><!--seo:start-->\n` +
      '<!--seo:source-title:Original-->\n' +
      `<!--seo:title-fp:${base}-->\n` +
      '<!--seo:end--></head><body></body>'
    const replaceTitle = (title: string) => html.replace(`<title>${base}</title>`, title)

    // The clamp boundary sits exactly where claimed.
    const read = (t: string) => extractTitleText(`<head><title>${t}</title></head>`)
    expect(read(differsAt513)).toBe(base)
    expect(read(differsAt512)).not.toBe(base)

    // Code point 513 is the first difference and is unobservable: stash wins.
    const editedLate = replaceTitle(`<title>${differsAt513}</title>`)
    expect(editedLate).not.toBe(html)
    expect(resolveSourceTitle(editedLate)).toBe('Original')

    // Code point 512 is the first difference and is observable: stale.
    const editedEarly = replaceTitle(`<title>${differsAt512}</title>`)
    expect(editedEarly).not.toBe(html)
    expect(resolveSourceTitle(editedEarly)).toBe(differsAt512)
  })

  // The rest of the glmflash-09 collision contract, locked in so a future
  // change that flips it to detect-the-difference fails loudly instead of
  // passing silently.
  //
  // NOTE ON WHAT THESE PROVE. These are CHARACTERIZATION tests: they pin
  // deliberate behaviour that holds both before and after eecc597, so they do
  // NOT fail on the pre-fix code and are not evidence for the defect. The
  // discriminating tests for the fix itself live in the
  // 'composePublishHtml — title fingerprint clamp (glmflash-09)' describe
  // below, which does fail when the fix is reverted. Two of the five
  // behaviours are already covered above and are not duplicated here:
  // 'differ only after code point 512 → honoured' and 'differ at code point
  // 512 → stale' are both asserted in the test immediately preceding this.
  describe('the collision contract, end to end', () => {
    const base = 'd'.repeat(TITLE_TEXT_MAX)
    const decorated = (title: string) =>
      `<head><title>${title}</title><!--seo:start-->\n` +
      '<!--seo:source-title:Original-->\n' +
      `<!--seo:title-fp:${base}-->\n` +
      '<!--seo:end--></head><body></body>'

    test('an edit at code point 1 is detected — the earliest observable position', () => {
      // Differs from `base` at the very first code point and nowhere else, so
      // this cannot pass by way of a length difference.
      const differsAt1 = 'X' + 'd'.repeat(TITLE_TEXT_MAX - 1)
      expect(differsAt1).toHaveLength(base.length)
      expect(differsAt1.slice(1)).toBe(base.slice(1))
      expect(resolveSourceTitle(decorated(differsAt1))).toBe(differsAt1)
    })

    test('a wholesale replacement of the live title is detected', () => {
      expect(resolveSourceTitle(decorated('A Completely Different Title'))).toBe(
        'A Completely Different Title',
      )
    })

    test('REMOVING the live title is detected, and the source resolves to undefined', () => {
      // The stash is not honoured (there is no title to fingerprint against),
      // and there is no live title to fall back to either, so the caller gets
      // undefined and applies its own slug fallback rather than reviving a
      // stale stashed title.
      const removed = decorated(base).replace(`<title>${base}</title>`, '')
      expect(removed).not.toContain('<title>')
      expect(resolveSourceTitle(removed)).toBeUndefined()
    })

    test('an EMPTIED live title is detected the same way', () => {
      const emptied = decorated(base).replace(`<title>${base}</title>`, '<title></title>')
      expect(resolveSourceTitle(emptied)).toBeUndefined()
    })

    test('the unedited title still honours the stash — the control', () => {
      // Without this the four assertions above would also pass if
      // resolveSourceTitle had simply stopped honouring the stash entirely.
      expect(resolveSourceTitle(decorated(base))).toBe('Original')
    })
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

  // round-5 item 5: the document title is the one unbounded input to the head
  // pipeline (%title%, the source-title stash, the schema graph, audit facts).
  test('clamps a pathological title to TITLE_TEXT_MAX code points', () => {
    const huge = 'a'.repeat(10_000)
    const out = extractTitleText(`<head><title>${huge}</title></head>`)
    expect(out).toBeDefined()
    expect([...(out as string)].length).toBe(TITLE_TEXT_MAX)
  })

  test('clamping never splits a surrogate pair', () => {
    const out = extractTitleText(
      `<head><title>${'😀'.repeat(TITLE_TEXT_MAX + 10)}</title></head>`,
    ) as string
    expect([...out].length).toBe(TITLE_TEXT_MAX)
    expect([...out].every((ch) => ch === '😀')).toBe(true)
  })

  test('boundary check: <titles> does not open and </titlex> does not close', () => {
    expect(extractTitleText('<head><titles>not it</titles><title>yes</title></head>')).toBe('yes')
    expect(extractTitleText('<head><title>a</titlex>b</title></head>')).toBe('a</titlex>b')
  })

  test('abrupt comments `<!-->` / `<!--->` do not hide the real <title> (G1)', () => {
    expect(extractTitleText('<head><!--><title>Real Title</title></head>')).toBe('Real Title')
    expect(extractTitleText('<head><!---><title>Real Title</title></head>')).toBe('Real Title')
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

  // A resolved canonical always brings og:url (same URL) + og:type.
  const CANONICAL_X = [
    '<link rel="canonical" href="https://example.com/x">',
    '<meta property="og:url" content="https://example.com/x">',
    '<meta property="og:type" content="website">',
  ].join('\n')

  test('canonical emitted only when resolved to an absolute URL', () => {
    const absolute = buildSeoHeadPayload({ canonical: 'https://example.com/x' }, {})
    expect(absolute.block).toBe(CANONICAL_X)

    const joined = buildSeoHeadPayload({ canonical: '/x' }, { siteUrl: 'https://example.com' })
    expect(joined.block).toBe(CANONICAL_X)

    const unresolved = buildSeoHeadPayload({ canonical: '/x' }, {})
    expect(unresolved.block).toBeUndefined()
  })

  test('canonical URL is attribute-escaped (og:url too)', () => {
    const payload = buildSeoHeadPayload(
      { canonical: 'https://example.com/x?a=1&b="2"' },
      {},
    )
    expect(payload.block).toBe(
      [
        '<link rel="canonical" href="https://example.com/x?a=1&amp;b=&quot;2&quot;">',
        '<meta property="og:url" content="https://example.com/x?a=1&amp;b=&quot;2&quot;">',
        '<meta property="og:type" content="website">',
      ].join('\n'),
    )
  })

  test('default canonical: no stored canonical + a self URL → the page\'s own URL', () => {
    const payload = buildSeoHeadPayload(
      {},
      { siteUrl: 'https://example.com', selfUrl: 'https://example.com/x' },
    )
    expect(payload.block).toBe(CANONICAL_X)
  })

  test('default canonical: a stored canonical wins over the self URL', () => {
    const payload = buildSeoHeadPayload(
      { canonical: 'https://other.example/y' },
      { siteUrl: 'https://example.com', selfUrl: 'https://example.com/x' },
    )
    expect(payload.block).toBe(
      [
        '<link rel="canonical" href="https://other.example/y">',
        '<meta property="og:url" content="https://other.example/y">',
        '<meta property="og:type" content="website">',
      ].join('\n'),
    )
  })

  test('default canonical: never on a noindex page; a stored one still emits beside noindex', () => {
    const ctx = { siteUrl: 'https://example.com', selfUrl: 'https://example.com/x' }
    expect(buildSeoHeadPayload({ robots: { noindex: true } }, ctx).block).toBe(
      '<meta name="robots" content="noindex">',
    )
    // nofollow alone does not suppress it — the page is still indexable.
    expect(buildSeoHeadPayload({ robots: { nofollow: true } }, ctx).block).toBe(
      [
        '<link rel="canonical" href="https://example.com/x">',
        '<meta name="robots" content="nofollow">',
        '<meta property="og:url" content="https://example.com/x">',
        '<meta property="og:type" content="website">',
      ].join('\n'),
    )
    expect(
      buildSeoHeadPayload({ canonical: '/x', robots: { noindex: true } }, ctx).block,
    ).toBe(
      [
        '<link rel="canonical" href="https://example.com/x">',
        '<meta name="robots" content="noindex">',
        '<meta property="og:url" content="https://example.com/x">',
        '<meta property="og:type" content="website">',
      ].join('\n'),
    )
  })

  test('no canonical resolves → no og:url and no og:type', () => {
    const payload = buildSeoHeadPayload({ title: 'T' }, { siteUrl: 'https://example.com' })
    expect(payload.block).toBe('<meta property="og:title" content="T">')
  })

  test('og:site_name only when a site name is configured, attribute-escaped', () => {
    expect(buildSeoHeadPayload({}, { siteName: 'A & "B"' }).block).toBe(
      '<meta property="og:site_name" content="A &amp; &quot;B&quot;">',
    )
    expect(buildSeoHeadPayload({}, { siteName: '' }).block).toBeUndefined()
    expect(buildSeoHeadPayload({}, {}).block).toBeUndefined()
  })

  test('OG tag order: title, description, image, url, type, site_name', () => {
    const payload = buildSeoHeadPayload(
      { title: 'T', metaDescription: 'D', ogImage: '/i.png' },
      { siteUrl: 'https://example.com', selfUrl: 'https://example.com/x', siteName: 'Site' },
    )
    expect(payload.block).toBe(
      [
        '<link rel="canonical" href="https://example.com/x">',
        '<meta property="og:title" content="T">',
        '<meta property="og:description" content="D">',
        '<meta property="og:image" content="https://example.com/i.png">',
        '<meta property="og:url" content="https://example.com/x">',
        '<meta property="og:type" content="website">',
        '<meta property="og:site_name" content="Site">',
      ].join('\n'),
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

describe('selfCanonicalUrl', () => {
  test('homepage form and trailing-slash behaviour match pageUrl', () => {
    expect(selfCanonicalUrl('https://example.com', 'index')).toBe('https://example.com/')
    expect(selfCanonicalUrl('https://example.com/', 'about')).toBe('https://example.com/about')
    expect(selfCanonicalUrl('https://example.com', 'blog/my post')).toBe(
      'https://example.com/blog/my%20post',
    )
  })

  test('never guesses an origin', () => {
    expect(selfCanonicalUrl(undefined, 'about')).toBeUndefined()
    expect(selfCanonicalUrl('', 'about')).toBeUndefined()
    expect(selfCanonicalUrl('https://example.com/base', 'about')).toBeUndefined()
    expect(selfCanonicalUrl('not a url', 'about')).toBeUndefined()
  })

  test('no URL for an empty slug or one the sitemap refuses to list', () => {
    expect(selfCanonicalUrl('https://example.com', '')).toBeUndefined()
    const atCap = 'a'.repeat(SITEMAP_ENTRY_MAX_CHARS)
    expect(selfCanonicalUrl('https://example.com', atCap)).toBe(`https://example.com/${atCap}`)
    expect(selfCanonicalUrl('https://example.com', `${atCap}a`)).toBeUndefined()
  })

  test('agrees with the sitemap <loc> for the same slugs', () => {
    const slugs = ['index', 'about', 'docs/getting started', 'café']
    const xml = buildSitemapXml(
      slugs.map((slug, i) => ({ pageId: `p${i}`, slug })),
      'https://example.com',
    )
    for (const slug of slugs) {
      const url = selfCanonicalUrl('https://example.com', slug)!
      expect(xml).toContain(`<loc>${url}</loc>`)
    }
  })
})

describe('resolveCanonical', () => {
  const ctx = { siteUrl: 'https://example.com', selfUrl: 'https://example.com/x' }

  test('stored canonical wins and reports source "entry"', () => {
    expect(resolveCanonical({ canonical: '/y' }, ctx)).toEqual({
      url: 'https://example.com/y',
      source: 'entry',
    })
  })

  test('nothing stored → the self URL, source "self"', () => {
    expect(resolveCanonical({}, ctx)).toEqual({ url: 'https://example.com/x', source: 'self' })
  })

  test('a stored canonical that cannot resolve is not replaced by the self URL', () => {
    expect(resolveCanonical({ canonical: 'not-rooted' }, ctx)).toBeUndefined()
  })

  test('noindex suppresses only the default', () => {
    expect(resolveCanonical({ robots: { noindex: true } }, ctx)).toBeUndefined()
    expect(resolveCanonical({ canonical: '/y', robots: { noindex: true } }, ctx)?.source).toBe(
      'entry',
    )
  })

  test('no self URL (template render / no origin) → nothing', () => {
    expect(resolveCanonical({}, { siteUrl: 'https://example.com' })).toBeUndefined()
    expect(resolveCanonical({}, {})).toBeUndefined()
  })
})

describe('composePublishHtml — default self-referencing canonical', () => {
  const HTML = '<html><head><title>About</title></head><body><p>x</p></body></html>'
  const SITE: SeoConfigData = { site: { siteUrl: 'https://example.com' } }

  test('regular page + site URL + nothing stored → canonical, og:url, og:type', () => {
    const out = composePublishHtml(HTML, {}, SITE, {
      tableSlug: 'pages',
      slug: 'about',
      regularPage: true,
    })
    expect(out).toContain('<link rel="canonical" href="https://example.com/about">')
    expect(out).toContain('<meta property="og:url" content="https://example.com/about">')
    expect(out).toContain('<meta property="og:type" content="website">')
    expect(out).not.toContain('og:site_name')
  })

  test('the homepage canonical is the site root with a trailing slash', () => {
    const out = composePublishHtml(HTML, {}, SITE, {
      tableSlug: 'pages',
      slug: 'index',
      regularPage: true,
    })
    expect(out).toContain('<link rel="canonical" href="https://example.com/">')
    expect(out).toContain('<meta property="og:url" content="https://example.com/">')
  })

  test('canonical, og:url and the schema.org WebPage url are the same URL', () => {
    const out = composePublishHtml(HTML, {}, SITE, {
      tableSlug: 'pages',
      slug: 'docs/getting started',
      regularPage: true,
      schemaPage: {},
    })
    const url = 'https://example.com/docs/getting%20started'
    expect(out).toContain(`<link rel="canonical" href="${url}">`)
    expect(out).toContain(`<meta property="og:url" content="${url}">`)
    expect(out).toContain(`"url":"${url}"`)
  })

  test('no site URL → byte-identical passthrough (never guess an origin)', () => {
    const out = composePublishHtml(HTML, {}, {}, {
      tableSlug: 'pages',
      slug: 'about',
      regularPage: true,
    })
    expect(out).toBe(HTML)
  })

  test('template / data-row / notFound renders (regularPage unset) get no default', () => {
    for (const regularPage of [undefined, false]) {
      const out = composePublishHtml(HTML, {}, SITE, {
        tableSlug: 'posts',
        slug: 'post-template',
        regularPage,
      })
      expect(out).toBe(HTML)
    }
  })

  test('a noindex page gets no default canonical and no og:url', () => {
    const out = composePublishHtml(HTML, { robots: { noindex: true } }, SITE, {
      tableSlug: 'pages',
      slug: 'about',
      regularPage: true,
    })
    expect(out).toContain('<meta name="robots" content="noindex">')
    expect(out).not.toContain('rel="canonical"')
    expect(out).not.toContain('og:url')
    expect(out).not.toContain('og:type')
  })

  test('a stored canonical still wins, and still emits on a noindex page', () => {
    const out = composePublishHtml(
      HTML,
      { canonical: 'https://other.example/a', robots: { noindex: true } },
      SITE,
      { tableSlug: 'pages', slug: 'about', regularPage: true },
    )
    expect(out).toContain('<link rel="canonical" href="https://other.example/a">')
    expect(out).toContain('<meta property="og:url" content="https://other.example/a">')
    expect(out).not.toContain('https://example.com/about')
  })

  test('og:site_name rides on every render kind once a site name is configured', () => {
    const named: SeoConfigData = { site: { siteName: 'Acme & Co' } }
    const out = composePublishHtml(HTML, {}, named, { tableSlug: 'posts', slug: 'post-template' })
    expect(out).toContain('<meta property="og:site_name" content="Acme &amp; Co">')
    expect(out).not.toContain('rel="canonical"')
  })

  test('a canonical the page author already put in the head is not doubled', () => {
    const authored = HTML.replace(
      '</title>',
      '</title><link rel="canonical" href="https://example.com/authored">',
    )
    const out = composePublishHtml(authored, {}, SITE, {
      tableSlug: 'pages',
      slug: 'about',
      regularPage: true,
    })
    expect(out).toBe(authored)
    // A STORED canonical is the operator's explicit call and still emits.
    const stored = composePublishHtml(authored, { canonical: '/x' }, SITE, {
      tableSlug: 'pages',
      slug: 'about',
      regularPage: true,
    })
    expect(stored).toContain('<link rel="canonical" href="https://example.com/x">')
  })

  test('idempotent: re-filtering its own output changes nothing', () => {
    const ctx = { tableSlug: 'pages', slug: 'about', regularPage: true }
    const once = composePublishHtml(HTML, {}, SITE, ctx)
    const twice = composePublishHtml(once, {}, SITE, ctx)
    expect(twice).toBe(once)
    expect(twice.match(/rel="canonical"/g)?.length).toBe(1)
    expect(twice.match(/og:url/g)?.length).toBe(1)
  })
})

describe('composePublishHtml — title fingerprint clamp (glmflash-09)', () => {
  // NO GUARD TEST ON `TITLE_TEXT_MAX === RENDERED_TEMPLATE_MAX`, DELIBERATELY.
  //
  // It is tempting: the two constants are independent 512s, `renderTemplate`
  // clamps its output with one and the fingerprint with the other, so the
  // byte-identity contract looks like it depends on them staying equal. It does
  // not. After eecc597 the writer (`buildSeoHeadPayload`) and the reader
  // (`resolveSourceTitle`) BOTH run the same source string through
  // `titleFingerprintText`, which clamps with `TITLE_TEXT_MAX` alone — so the
  // two sides agree at any length and `RENDERED_TEMPLATE_MAX` never enters the
  // comparison. Probed directly against the real functions:
  //
  //     decorated len=  512  stash honored=true
  //     decorated len=  513  stash honored=true
  //     decorated len=  700  stash honored=true
  //     decorated len= 1024  stash honored=true
  //     decorated len= 5512  stash honored=true
  //
  // Raising `RENDERED_TEMPLATE_MAX` would therefore NOT break byte-identity,
  // and a guard asserting equality would fail on that harmless change while
  // protecting nothing. A guard that fires on a safe edit and does not cover
  // the defect it names is worse than no guard: the next reader either deletes
  // it without knowing what they lost, or trusts it. The real contract is
  // "writer and reader clamp the same way", and that is what the two tests
  // below pin — both of them fail when either half of eecc597 is reverted
  // (measured: 0 pass / 2 fail).
  // Replaces "title longer than TITLE_TEXT_MAX republishes byte-identically",
  // which passed on the buggy code and so proved nothing: its template is
  // '%title%' over a source that extractTitleText had ALREADY clamped, so the
  // decorated title was exactly TITLE_TEXT_MAX code points and no clamp
  // asymmetry could arise. An over-long stored fingerprint is unreachable
  // through today's writer: buildSeoHeadPayload runs the title through
  // titleFingerprintText before emitting it, and that clamps to
  // TITLE_TEXT_MAX whether the title came out of renderTemplate or straight
  // from a per-entry override. So this test has to construct its document by
  // hand — content decorated before the clamp existed, or by any writer that
  // skips it — which is exactly the published-document population the
  // read-side half of the fix exists to round-trip. It asserts the
  // end-to-end consequence: the stash is honoured and %title% is NOT
  // re-derived from the clamped decorated title.
  test('an over-long stored fingerprint does not false-stale the stash', () => {
    const decorated = 'd'.repeat(TITLE_TEXT_MAX + 50)
    const once =
      `<html><head><title>${decorated}</title><!--seo:start-->\n` +
      '<!--seo:source-title:Original-->\n' +
      `<!--seo:title-fp:${decorated}-->\n` +
      '<!--seo:end--></head><body></body></html>'
    const config = { site: { siteName: 'Site', titleTemplate: '%title% | %site%' } }
    const ctx = { tableSlug: 'pages', slug: 'page' }

    const republished = composePublishHtml(once, {}, config, ctx)
    // %title% resolved from the STASH. On the buggy code the over-long
    // fingerprint read as stale, the clamped decorated title became the
    // source, and this rendered a truncated 'ddd… |' title instead.
    expect(republished).toContain('<title>Original | Site</title>')
    expect(republished).toContain('<!--seo:source-title:Original-->')
    // That first republish normalises the over-long fingerprint down to the
    // clamp; from then on the byte-identical republish contract holds again.
    expect(composePublishHtml(republished, {}, config, ctx)).toBe(republished)
  })

  test('buildSeoHeadPayload clamps title-fp to TITLE_TEXT_MAX code points', () => {
    const longDecorated = 'x'.repeat(TITLE_TEXT_MAX + 100)
    const payload = buildSeoHeadPayload({ title: longDecorated }, { sourceTitle: 'orig' })
    const fp = payload.block!.match(/<!--seo:title-fp:([^>]+)-->/)![1]!
    expect([...fp].length).toBe(TITLE_TEXT_MAX)
  })
})

// Not glmflash-09 evidence, and deliberately not filed under it: this passes
// on the pre-fix code too, because the hand edit changes the title inside the
// clamp window, where the buggy and fixed readers agree. It stays as
// stale-edit coverage — an out-of-band title edit must re-template from the
// NEW title — but it proves nothing about the fingerprint clamp.
describe('composePublishHtml — hand-edited title re-templates', () => {
  test('hand-edited title on long-title decorated HTML re-templates from the NEW title', () => {
    const longDecorated = 'a'.repeat(TITLE_TEXT_MAX + 50)
    const base = '<html><head><title>orig</title></head><body></body></html>'
    const once = applySeoHead(
      base,
      buildSeoHeadPayload({ title: longDecorated }, { sourceTitle: 'orig' }),
    )
    const edited = once.replace(/<title>[^<]*<\/title>/, '<title>Fresh Hand-Written Title</title>')
    expect(edited).not.toBe(once)
    const config = { site: { siteName: 'Site', titleTemplate: '%title% | %site%' } }
    const ctx = { tableSlug: 'pages', slug: 'page' }
    const refiltered = composePublishHtml(edited, {}, config, ctx)
    expect(refiltered).toContain('<title>Fresh Hand-Written Title | Site</title>')
    expect(refiltered).toContain('<!--seo:source-title:Fresh Hand-Written Title-->')
  })
})

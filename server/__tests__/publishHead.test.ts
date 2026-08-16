/**
 * Integration-style test for task 1.3: composes the exact pipeline the
 * publish.html filter runs — existing-<title> extraction → merge chain
 * (per-entry override → table template via renderTemplate → site
 * defaults) → buildSeoHeadPayload → applySeoHead — over a realistic
 * host-shaped published page.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { composePublishHtml } from '../metaBlock'
import type { SeoConfigData } from '../seoConfig'
import type { SeoMetaPayload } from '../seoMeta'
import {
  getTemplatePageInfo,
  invalidateTemplateFlagCache,
  type PagesTableLike,
} from '../templateDetect'

/**
 * Head shape mirrors what the pinned host bakes (publisher render.ts:
 * charset/viewport, escaped <title>, optional site-wide description,
 * favicon, css links) plus a body with decoy tags.
 */
const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>About Us &amp; Team</title>
  <meta name="description" content="Old site-wide description">
  <link rel="icon" href="/favicon.svg">
  <link rel="stylesheet" href="/_instatic/css/site-abc123.css">
  <script>const decoy = '<title>not a title</title>'</script>
</head>
<body>
  <h1>About Us</h1>
  <p>A body mentioning <meta name="description" content="decoy"> as text.</p>
</body>
</html>`

/** The same composition server/index.ts runs inside the filter. */
function runFilter(
  html: string,
  entry: SeoMetaPayload,
  config: SeoConfigData,
  ctx: { pageId: string; slug: string },
): string {
  return composePublishHtml(html, entry, config, { tableSlug: 'pages', slug: ctx.slug })
}

const CONFIG: SeoConfigData = {
  site: {
    siteName: 'Acme Widgets',
    separator: '|',
    siteUrl: 'https://acme.example',
    titleTemplate: '%title% %sep% %site%',
    metaDescription: 'Acme Widgets — quality widgets since 1999.',
  },
  tables: { pages: { titleTemplate: '%title% %sep% %site%' } },
}

const ENTRY: SeoMetaPayload = {
  metaDescription: 'Meet the Acme team.',
  canonical: '/about',
  robots: { nofollow: true },
  ogImage: '/uploads/team.jpg',
  twitterCard: 'summary_large_image',
}

const CTX = { pageId: 'pg_abc123', slug: 'about' }

describe('publish.html pipeline composition', () => {
  test('bakes the full merged head for an overridden entry', () => {
    const out = runFilter(PAGE_HTML, ENTRY, CONFIG, CTX)

    // Title: no per-entry title → table template rendered with the
    // existing (entity-decoded) <title> text; re-escaped on write.
    expect(out).toContain('<title>About Us &amp; Team | Acme Widgets</title>')
    // Description: per-entry override replaces the host's baked meta.
    expect(out).toContain('<meta name="description" content="Meet the Acme team.">')
    expect(out).not.toContain('Old site-wide description')
    // Block tags, inside the marker block, before </head>.
    expect(out).toContain('<!--seo:start-->')
    expect(out).toContain('<link rel="canonical" href="https://acme.example/about">')
    expect(out).toContain('<meta name="robots" content="nofollow">')
    expect(out).toContain('<meta property="og:title" content="About Us &amp; Team | Acme Widgets">')
    expect(out).toContain('<meta property="og:description" content="Meet the Acme team.">')
    expect(out).toContain('<meta property="og:image" content="https://acme.example/uploads/team.jpg">')
    expect(out).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(out).toContain('<meta name="twitter:title" content="About Us &amp; Team | Acme Widgets">')
    expect(out).toContain('<meta name="twitter:description" content="Meet the Acme team.">')
    const headEnd = out.indexOf('</head>')
    expect(out.indexOf('<!--seo:end-->')).toBeLessThan(headEnd)
    // Body decoys untouched.
    expect(out).toContain(`<script>const decoy = '<title>not a title</title>'</script>`)
    expect(out).toContain('content="decoy"> as text.')
  })

  test('double-apply is idempotent (no duplicate tags on re-publish)', () => {
    const once = runFilter(PAGE_HTML, ENTRY, CONFIG, CTX)
    const twice = runFilter(once, ENTRY, CONFIG, CTX)
    expect(twice).toBe(once)
    expect(twice.match(/rel="canonical"/g)?.length).toBe(1)
    expect(twice.match(/og:title/g)?.length).toBe(1)
    expect(twice.match(/<!--seo:start-->/g)?.length).toBe(1)
  })

  test('re-apply after a template change re-renders from the ORIGINAL title', () => {
    const once = runFilter(PAGE_HTML, ENTRY, CONFIG, CTX)
    // The templated title has replaced <title>; the stash comment keeps the
    // pre-template source available for the next run.
    expect(once).toContain('<!--seo:source-title:About Us &amp; Team-->')
    const changedConfig: SeoConfigData = {
      ...CONFIG,
      site: { ...CONFIG.site, separator: '·' },
      tables: { pages: { titleTemplate: '%title% %sep% %site%' } },
    }
    const twice = runFilter(once, ENTRY, changedConfig, CTX)
    expect(twice).toContain('<title>About Us &amp; Team · Acme Widgets</title>')
    expect(twice).not.toContain('| Acme Widgets ·')
  })

  test('re-apply with CHANGED meta replaces rather than accumulates', () => {
    const once = runFilter(PAGE_HTML, ENTRY, CONFIG, CTX)
    const changed = runFilter(
      once,
      { ...ENTRY, canonical: 'https://acme.example/about-us', robots: { noindex: true } },
      CONFIG,
      CTX,
    )
    expect(changed).toContain('<link rel="canonical" href="https://acme.example/about-us">')
    expect(changed).not.toContain('href="https://acme.example/about">')
    expect(changed).toContain('<meta name="robots" content="noindex">')
    expect(changed.match(/rel="canonical"/g)?.length).toBe(1)
  })

  test('defaults-only entry still gets template title + site description', () => {
    const out = runFilter(PAGE_HTML, {}, CONFIG, CTX)
    expect(out).toContain('<title>About Us &amp; Team | Acme Widgets</title>')
    expect(out).toContain(
      '<meta name="description" content="Acme Widgets — quality widgets since 1999.">',
    )
    // No entry data → no canonical/robots/twitter; OG rides the fallbacks.
    expect(out).not.toContain('rel="canonical"')
    expect(out).not.toContain('name="robots"')
    expect(out).not.toContain('twitter:')
    expect(out).toContain('<meta property="og:title" content="About Us &amp; Team | Acme Widgets">')
  })

  test('no meta, no templates, no config → byte-identical pass-through', () => {
    expect(runFilter(PAGE_HTML, {}, {}, CTX)).toBe(PAGE_HTML)
  })

  test('page without a <title> gets one via the block, %title% falls back to slug', () => {
    const bare = '<html><head><meta charset="utf-8"></head><body></body></html>'
    const out = runFilter(bare, {}, CONFIG, CTX)
    expect(out).toContain('<title>about | Acme Widgets</title>')
    expect(out).toContain('<!--seo:start-->')
  })

  test('hand-edited title on decorated HTML re-templates from the NEW title', () => {
    const once = runFilter(PAGE_HTML, ENTRY, CONFIG, CTX)
    const edited = once.replace(
      '<title>About Us &amp; Team | Acme Widgets</title>',
      '<title>Fresh Hand-Written Title</title>',
    )
    expect(edited).not.toBe(once)
    const refiltered = runFilter(edited, ENTRY, CONFIG, CTX)
    // The stale stash must lose to the out-of-band edit.
    expect(refiltered).toContain('<title>Fresh Hand-Written Title | Acme Widgets</title>')
    expect(refiltered).not.toContain('About Us &amp; Team | Acme Widgets | Acme Widgets')
    expect(refiltered).toContain('<!--seo:source-title:Fresh Hand-Written Title-->')
  })

  test('a user-authored stash look-alike outside our block cannot poison %title%', () => {
    const poisoned = PAGE_HTML.replace(
      '<meta charset="utf-8">',
      '<meta charset="utf-8">\n  <!--seo:source-title:EVIL-->' +
        '<!--seo:title-fp:About Us &amp; Team-->',
    )
    const out = runFilter(poisoned, ENTRY, CONFIG, CTX)
    expect(out).toContain('<title>About Us &amp; Team | Acme Widgets</title>')
    expect(out).not.toContain('EVIL | Acme Widgets')
  })

  test('hostile stored values cannot break out of the head tags', () => {
    const out = runFilter(
      PAGE_HTML,
      {
        title: '</title><script>alert(1)</script>',
        metaDescription: '"><script>x</script>',
        ogTitle: '"/><script>y</script>',
        twitterCard: 'summary',
      },
      {},
      CTX,
    )
    expect(out).not.toContain('<script>alert(1)</script>')
    expect(out).not.toContain('<script>x</script>')
    expect(out).not.toContain('<script>y</script>')
    expect(out).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>')
  })
})

// ---------------------------------------------------------------------------
// BLOCKER regression — template-page meta must never leak onto row renders
// ---------------------------------------------------------------------------

describe('template-page detection in the filter pipeline', () => {
  beforeEach(() => {
    invalidateTemplateFlagCache()
  })

  /** Mirrors the glue server/index.ts runs inside the filter. */
  async function runFilterWithDetection(
    html: string,
    pagesTable: PagesTableLike,
    storedMetaByKey: Record<string, SeoMetaPayload>,
    config: SeoConfigData,
    ctx: { pageId: string; slug: string },
  ): Promise<string> {
    const tpl = await getTemplatePageInfo(pagesTable, ctx.pageId)
    const entry = tpl.isTemplate ? {} : (storedMetaByKey[`pages:${ctx.pageId}`] ?? {})
    return composePublishHtml(html, entry, config, {
      tableSlug: tpl.targetTableSlug ?? 'pages',
      slug: ctx.slug,
    })
  }

  // A data-row document rendered THROUGH the template page 'tpl1': the
  // context carries the template's pageId/slug, the <title> is the row's.
  const ROW_HTML = `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>First Post</title>
</head>
<body><article>Post body</article></body></html>`

  const pagesTable: PagesTableLike = {
    async get(id: string) {
      if (id === 'tpl1') {
        return {
          cells: {
            templateEnabled: true,
            templateTarget: { kind: 'postTypes', tableSlugs: ['posts'] },
          },
        }
      }
      if (id === 'pg1') return { cells: { title: 'About Us' } }
      return null
    },
  }

  // Meta stored on the TEMPLATE page itself — the leak scenario.
  const stored: Record<string, SeoMetaPayload> = {
    'pages:tpl1': {
      canonical: 'https://acme.example/entry-template',
      ogImage: '/template.png',
      robots: { noindex: true },
    },
    'pages:pg1': { canonical: '/about' },
  }

  const config: SeoConfigData = {
    site: { siteName: 'Acme', siteUrl: 'https://acme.example' },
    tables: { posts: { titleTemplate: '%title% %sep% Blog' }, pages: { titleTemplate: '%title%' } },
  }

  test('BLOCKER: template-page stored meta is skipped for composed row renders', async () => {
    const out = await runFilterWithDetection(ROW_HTML, pagesTable, stored, config, {
      pageId: 'tpl1',
      slug: 'entry-template',
    })
    // The template page's canonical/robots/og:image must NOT be stamped
    // onto the row document.
    expect(out).not.toContain('rel="canonical"')
    expect(out).not.toContain('name="robots"')
    expect(out).not.toContain('template.png')
    // Template/site tiers still apply — and via the TARGET table (posts),
    // not the pages table.
    expect(out).toContain('<title>First Post - Blog</title>')
  })

  test('regular pages keep their per-entry tier', async () => {
    const out = await runFilterWithDetection(PAGE_HTML, pagesTable, stored, config, {
      pageId: 'pg1',
      slug: 'about',
    })
    expect(out).toContain('<link rel="canonical" href="https://acme.example/about">')
  })

  test('an unreadable pages row is treated as a template (fail-safe: no per-entry meta)', async () => {
    const out = await runFilterWithDetection(ROW_HTML, pagesTable, stored, config, {
      pageId: 'vanished',
      slug: 'whatever',
    })
    expect(out).not.toContain('rel="canonical"')
  })
})

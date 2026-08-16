/**
 * Task 2.4 — publish-path extensions through the REAL composition
 * pipeline (`composePublishHtml`): verification meta emission, the
 * analytics config tag riding the seo block verbatim, idempotency of the
 * extended block, and the sitemap/image-audit + template plumbing that
 * feeds the stash.
 */

import { describe, expect, test } from 'bun:test'
import { buildVerificationTags, composePublishHtml } from '../metaBlock'
import { buildAnalyticsConfigTag } from '../analytics'
import { auditImages } from '../lib/imageAudit'
import { planSitemapWrite, deserializeSitemapRecord, serializeSitemapEntry } from '../sitemap'
import {
  getTemplatePageInfo,
  invalidateTemplateFlagCache,
  type PagesTableLike,
} from '../templateDetect'
import type { SeoConfigData } from '../seoConfig'

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>About Us</title>
</head>
<body><h1>About</h1></body>
</html>`

const VERIFY_CONFIG: SeoConfigData = {
  verification: { google: 'G-TOK', bing: 'B-TOK', pinterest: 'P-TOK' },
}

describe('buildVerificationTags', () => {
  test('emits one meta per configured service, in fixed order', () => {
    expect(buildVerificationTags(VERIFY_CONFIG)).toEqual([
      '<meta name="google-site-verification" content="G-TOK">',
      '<meta name="msvalidate.01" content="B-TOK">',
      '<meta name="p:domain_verify" content="P-TOK">',
    ])
    expect(buildVerificationTags({})).toEqual([])
    expect(buildVerificationTags({ verification: { bing: 'ONLY' } })).toEqual([
      '<meta name="msvalidate.01" content="ONLY">',
    ])
  })
})

describe('composePublishHtml — 2.4 block extensions', () => {
  test('verification metas bake inside the seo block on every render', () => {
    const out = composePublishHtml(PAGE_HTML, {}, VERIFY_CONFIG, {
      tableSlug: 'pages',
      slug: 'about',
    })
    const block = /<!--seo:start-->([\s\S]*?)<!--seo:end-->/.exec(out)
    expect(block).not.toBeNull()
    expect(block![1]).toContain('google-site-verification')
    expect(block![1]).toContain('msvalidate.01')
    expect(block![1]).toContain('p:domain_verify')
  })

  test('analytics tag is appended verbatim and re-compose is idempotent', () => {
    const { tag } = buildAnalyticsConfigTag({
      endpoint: '/admin/api/cms/plugins/monkeywebs.seo/runtime/beacon',
      siteId: 'site-1',
      enabled: true,
    })
    const ctx = { tableSlug: 'pages', slug: 'about', analyticsTag: tag }
    const once = composePublishHtml(PAGE_HTML, {}, VERIFY_CONFIG, ctx)
    expect(once).toContain(tag)
    expect(once.split('window.__mwSeoAnalytics').length).toBe(2)
    const twice = composePublishHtml(once, {}, VERIFY_CONFIG, ctx)
    expect(twice).toBe(once)
  })

  test('no analytics tag when the caller omits it (disabled/blocked)', () => {
    const out = composePublishHtml(PAGE_HTML, {}, VERIFY_CONFIG, {
      tableSlug: 'pages',
      slug: 'about',
    })
    expect(out).not.toContain('__mwSeoAnalytics')
  })

  test('nothing configured → byte-identical passthrough still holds', () => {
    expect(composePublishHtml(PAGE_HTML, {}, {}, { tableSlug: 'pages', slug: 'about' })).toBe(
      PAGE_HTML,
    )
  })
})

describe('sitemap image-audit fields (task 2.4)', () => {
  const baseStash = { slug: 'about', title: 'About', noindex: false, fp: 'aaaa' }

  test('serialize/deserialize round-trips the counts', () => {
    const data = serializeSitemapEntry({
      pageId: 'p1',
      slug: 'about',
      imgTotal: 3,
      imgFindings: 2,
    })
    const entry = deserializeSitemapRecord(data)
    expect(entry?.imgTotal).toBe(3)
    expect(entry?.imgFindings).toBe(2)
    // Malformed counts are dropped, never propagated.
    const messy = deserializeSitemapRecord({
      key: 'page:p1',
      pageId: 'p1',
      slug: 'about',
      imgTotal: -1,
      imgFindings: 'x',
    })
    expect(messy?.imgTotal).toBeUndefined()
    expect(messy?.imgFindings).toBeUndefined()
  })

  test('content change carries the counts and queues IndexNow', () => {
    const plan = planSitemapWrite(
      { pageId: 'p1', slug: 'about', fp: 'old' },
      'p1',
      { ...baseStash, imgTotal: 4, imgFindings: 1 },
      '2026-08-14T12:00:00Z',
    )
    expect(plan.action).toBe('write')
    if (plan.action !== 'write') return
    expect(plan.submit).toBe(true)
    expect(plan.data.imgTotal).toBe(4)
    expect(plan.data.imgFindings).toBe(1)
    expect(plan.data.lastmod).toBe('2026-08-14T12:00:00Z')
  })

  test('count-only backfill writes WITHOUT lastmod bump or IndexNow ping', () => {
    const plan = planSitemapWrite(
      { pageId: 'p1', slug: 'about', title: 'About', fp: 'aaaa', lastmod: '2026-08-01T00:00:00Z' },
      'p1',
      { ...baseStash, imgTotal: 2, imgFindings: 0 },
      '2026-08-14T12:00:00Z',
    )
    expect(plan.action).toBe('write')
    if (plan.action !== 'write') return
    expect(plan.submit).toBe(false)
    expect(plan.data.pending).toBe(false)
    expect(plan.data.lastmod).toBe('2026-08-01T00:00:00Z')
    expect(plan.data.imgTotal).toBe(2)
  })

  test('a stash WITHOUT image fields preserves stored counts (review B2#8)', () => {
    // Content unchanged: no write — the missing stash fields do NOT read
    // as a change against the stored counts.
    const unchanged = planSitemapWrite(
      { pageId: 'p1', slug: 'about', title: 'About', fp: 'aaaa', imgTotal: 5, imgFindings: 2 },
      'p1',
      baseStash, // no imgTotal/imgFindings
      '2026-08-14T12:00:00Z',
    )
    expect(unchanged).toEqual({ action: 'none' })
    // Content changed: the write CARRIES the stored counts forward
    // instead of omitting (wiping) them.
    const changed = planSitemapWrite(
      { pageId: 'p1', slug: 'about', title: 'About', fp: 'OLD', imgTotal: 5, imgFindings: 2 },
      'p1',
      baseStash,
      '2026-08-14T12:00:00Z',
    )
    expect(changed.action).toBe('write')
    if (changed.action !== 'write') return
    expect(changed.data.imgTotal).toBe(5)
    expect(changed.data.imgFindings).toBe(2)
  })

  test('identical counts + content → no write at all', () => {
    const plan = planSitemapWrite(
      { pageId: 'p1', slug: 'about', title: 'About', fp: 'aaaa', imgTotal: 2, imgFindings: 0 },
      'p1',
      { ...baseStash, imgTotal: 2, imgFindings: 0 },
      '2026-08-14T12:00:00Z',
    )
    expect(plan).toEqual({ action: 'none' })
  })

  test('auditImages counts feed the stash shape (composed-page smoke)', () => {
    const html = '<html><body><img src="/a.png"><img src="/b.png" alt="B" width="10" height="10"></body></html>'
    const audit = auditImages(html)
    expect(audit.totalImages).toBe(2)
    // img a: missing-alt + missing-dimensions = 2 findings.
    expect(audit.findings.length).toBe(2)
  })
})

describe('templateDetect — notFound classification (task 2.4)', () => {
  function tableWith(cells: Record<string, unknown>): PagesTableLike {
    return { get: () => Promise.resolve({ cells }) }
  }

  test('notFound template pages classify isTemplate + isNotFound', async () => {
    invalidateTemplateFlagCache()
    const info = await getTemplatePageInfo(
      tableWith({ templateEnabled: true, templateTarget: { kind: 'notFound' } }),
      'nf-page',
    )
    expect(info.isTemplate).toBe(true)
    expect(info.isNotFound).toBe(true)
  })

  test('other templates and regular pages are NOT flagged notFound', async () => {
    invalidateTemplateFlagCache()
    const everywhere = await getTemplatePageInfo(
      tableWith({ templateEnabled: true, templateTarget: { kind: 'everywhere' } }),
      'tpl-page',
    )
    expect(everywhere.isTemplate).toBe(true)
    expect(everywhere.isNotFound).toBeUndefined()

    invalidateTemplateFlagCache()
    const regular = await getTemplatePageInfo(tableWith({}), 'reg-page')
    expect(regular.isTemplate).toBe(false)
    expect(regular.isNotFound).toBeUndefined()
  })

  test('postTypes templates keep their target-table redirect', async () => {
    invalidateTemplateFlagCache()
    const info = await getTemplatePageInfo(
      tableWith({ templateEnabled: true, templateTarget: { kind: 'postTypes', tableSlugs: ['posts'] } }),
      'entry-tpl',
    )
    expect(info.isTemplate).toBe(true)
    expect(info.targetTableSlug).toBe('posts')
    expect(info.isNotFound).toBeUndefined()
  })
})

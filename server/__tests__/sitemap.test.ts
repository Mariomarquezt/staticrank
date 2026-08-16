import { beforeEach, describe, expect, test } from 'bun:test'
import {
  SITEMAP_LIST_PAGE_SIZE,
  SITEMAP_URL_CAP,
  buildSitemapXml,
  contentFingerprint,
  deserializeSitemapRecord,
  entriesFromRecords,
  escapeXml,
  invalidateSitemapCache,
  isValidLastmod,
  listSitemapRecordsForKey,
  loadSitemapEntries,
  normalizeForFingerprint,
  pageUrl,
  planSitemapWrite,
  serializeSitemapEntry,
  shouldPruneRecord,
  sitemapPageKey,
  type PageStash,
  type SitemapCollectionLike,
  type SitemapEntry,
  type SitemapRecordLike,
} from '../sitemap'

beforeEach(() => {
  invalidateSitemapCache()
})

// ---------------------------------------------------------------------------
// escapeXml + pageUrl
// ---------------------------------------------------------------------------

describe('escapeXml', () => {
  test('escapes all five XML-significant characters', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f')
  })

  test('ampersand first — no double escaping', () => {
    expect(escapeXml('&lt;')).toBe('&amp;lt;')
  })

  test('passes plain text through', () => {
    expect(escapeXml('hello-world_123')).toBe('hello-world_123')
  })
})

describe('pageUrl', () => {
  test('index slug maps to the origin root', () => {
    expect(pageUrl('https://example.com', 'index')).toBe('https://example.com/')
  })

  test('regular slug appends as a path', () => {
    expect(pageUrl('https://example.com', 'about')).toBe('https://example.com/about')
  })

  test('percent-encodes odd characters but keeps segment separators', () => {
    expect(pageUrl('https://example.com', 'a b/c')).toBe('https://example.com/a%20b/c')
  })
})

// ---------------------------------------------------------------------------
// contentFingerprint
// ---------------------------------------------------------------------------

describe('contentFingerprint', () => {
  test('is stable for identical input', () => {
    expect(contentFingerprint('<html>x</html>')).toBe(contentFingerprint('<html>x</html>'))
  })

  test('differs for different input', () => {
    expect(contentFingerprint('a')).not.toBe(contentFingerprint('b'))
  })

  test('is 8 lowercase hex chars, even for empty input', () => {
    expect(contentFingerprint('')).toMatch(/^[0-9a-f]{8}$/)
    expect(contentFingerprint('some longer document body')).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('normalizeForFingerprint (review #3 — publish-version volatility)', () => {
  test('a version-only change fingerprints IDENTICALLY', () => {
    const v1 =
      '<html><head><link href="/_instatic/css/a.css?v=41" rel="stylesheet">' +
      '<script src="/_instatic/assets/x/mod.js?v=41" defer></script></head>' +
      '<body><instatic-hole data-instatic-version="41"></instatic-hole>Hello</body></html>'
    const v2 = v1.replace(/41/g, '42')
    expect(contentFingerprint(normalizeForFingerprint(v1))).toBe(
      contentFingerprint(normalizeForFingerprint(v2)),
    )
  })

  test('a real content change still fingerprints differently', () => {
    const a = '<body><script src="/m.js?v=1"></script>Hello</body>'
    const b = '<body><script src="/m.js?v=2"></script>Goodbye</body>'
    expect(contentFingerprint(normalizeForFingerprint(a))).not.toBe(
      contentFingerprint(normalizeForFingerprint(b)),
    )
  })

  test('strips ?v= from src/href values and data-instatic-version attrs only', () => {
    const html =
      '<a href="/page?v=3">x</a><img src="/i.png?v=9&x=1"><div data-instatic-version="7">t</div>' +
      '<p>literal ?v=5 text stays</p>'
    const normalized = normalizeForFingerprint(html)
    expect(normalized).toContain('<a href="/page">')
    expect(normalized).toContain('<img src="/i.png">')
    expect(normalized).toContain('<div>t</div>')
    expect(normalized).toContain('literal ?v=5 text stays')
  })
})

describe('isValidLastmod (review #12 — W3C datetime at the emission boundary)', () => {
  test('accepts date and datetime forms', () => {
    expect(isValidLastmod('2026-08-14')).toBe(true)
    expect(isValidLastmod('2026-08-14T12:00:00.000Z')).toBe(true)
    expect(isValidLastmod('2026-08-14T12:00+02:00')).toBe(true)
  })

  test('rejects garbage', () => {
    expect(isValidLastmod('yesterday')).toBe(false)
    expect(isValidLastmod('2026-8-4')).toBe(false)
    expect(isValidLastmod('2026-08-14T12:00:00.000Z<script>')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Record (de)serialization
// ---------------------------------------------------------------------------

describe('serialize/deserialize sitemap records', () => {
  test('round-trips a full entry', () => {
    const entry: SitemapEntry = {
      pageId: 'p1',
      slug: 'about',
      title: 'About us',
      lastmod: '2026-08-14T00:00:00.000Z',
      fp: 'deadbeef',
      pending: true,
    }
    expect(deserializeSitemapRecord(serializeSitemapEntry(entry))).toEqual(entry)
  })

  test('round-trips a minimal entry (pending false drops)', () => {
    const entry: SitemapEntry = { pageId: 'p1', slug: 'index' }
    const data = serializeSitemapEntry(entry)
    expect(data.pending).toBe(false)
    expect(deserializeSitemapRecord(data)).toEqual({ pageId: 'p1', slug: 'index' })
  })

  test('rejects missing/mismatched key, missing pageId or slug, wrong types', () => {
    expect(deserializeSitemapRecord({})).toBeUndefined()
    expect(deserializeSitemapRecord({ key: 'page:p1', pageId: 'p1' })).toBeUndefined()
    expect(deserializeSitemapRecord({ key: 'page:OTHER', pageId: 'p1', slug: 'a' })).toBeUndefined()
    expect(deserializeSitemapRecord({ key: 'page:p1', pageId: 'p1', slug: 42 })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// planSitemapWrite
// ---------------------------------------------------------------------------

const NOW = '2026-08-14T12:00:00.000Z'

function stash(overrides: Partial<PageStash> = {}): PageStash {
  return { slug: 'about', title: 'About', noindex: false, fp: 'aaaa1111', ...overrides }
}

describe('planSitemapWrite', () => {
  test('new page → write + submit, pending, lastmod = now', () => {
    const plan = planSitemapWrite(undefined, 'p1', stash(), NOW)
    expect(plan.action).toBe('write')
    if (plan.action === 'write') {
      expect(plan.submit).toBe(true)
      expect(plan.data).toEqual({
        key: sitemapPageKey('p1'),
        pageId: 'p1',
        slug: 'about',
        title: 'About',
        lastmod: NOW,
        fp: 'aaaa1111',
        pending: true,
      })
    }
  })

  test('unchanged page → none (live renders never write)', () => {
    const existing: SitemapEntry = { pageId: 'p1', slug: 'about', title: 'About', fp: 'aaaa1111' }
    expect(planSitemapWrite(existing, 'p1', stash(), NOW)).toEqual({ action: 'none' })
  })

  test('slug, title, or fingerprint change each trigger a write', () => {
    const existing: SitemapEntry = { pageId: 'p1', slug: 'about', title: 'About', fp: 'aaaa1111' }
    expect(planSitemapWrite(existing, 'p1', stash({ slug: 'about-us' }), NOW).action).toBe('write')
    expect(planSitemapWrite(existing, 'p1', stash({ title: 'New' }), NOW).action).toBe('write')
    expect(planSitemapWrite(existing, 'p1', stash({ fp: 'bbbb2222' }), NOW).action).toBe('write')
  })

  test('noindex ALWAYS plans a delete — even with no/malformed existing entry (review #11)', () => {
    const existing: SitemapEntry = { pageId: 'p1', slug: 'about' }
    expect(planSitemapWrite(existing, 'p1', stash({ noindex: true }), NOW)).toEqual({
      action: 'delete',
    })
    // `existing` undefined also covers "newest record failed to parse" —
    // the handler deletes all stored records for the key and no-ops when
    // nothing is stored.
    expect(planSitemapWrite(undefined, 'p1', stash({ noindex: true }), NOW)).toEqual({
      action: 'delete',
    })
  })

  test('missing title on both sides compares equal', () => {
    const existing: SitemapEntry = { pageId: 'p1', slug: 'about', fp: 'aaaa1111' }
    expect(planSitemapWrite(existing, 'p1', stash({ title: undefined }), NOW)).toEqual({
      action: 'none',
    })
  })
})

// ---------------------------------------------------------------------------
// buildSitemapXml
// ---------------------------------------------------------------------------

describe('buildSitemapXml', () => {
  const SITE = 'https://example.com'

  test('renders a sorted urlset with lastmod when known', () => {
    const xml = buildSitemapXml(
      [
        { pageId: 'p2', slug: 'zebra' },
        { pageId: 'p1', slug: 'index', lastmod: '2026-08-14T00:00:00.000Z' },
      ],
      SITE,
    )
    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    const root = xml.indexOf('https://example.com/</loc>')
    const zebra = xml.indexOf('https://example.com/zebra</loc>')
    expect(root).toBeGreaterThan(-1)
    expect(zebra).toBeGreaterThan(root)
    expect(xml).toContain('<lastmod>2026-08-14T00:00:00.000Z</lastmod>')
    expect(xml).toEndWith('</urlset>')
    expect(xml).not.toContain('truncated')
  })

  test('XML-escapes URLs', () => {
    const xml = buildSitemapXml([{ pageId: 'p1', slug: "a&b'c" }], SITE)
    expect(xml).toContain('<loc>https://example.com/a%26b\'c</loc>'.replace("'", '&apos;'))
    expect(xml).not.toContain('a&b')
  })

  test('caps URLs with a LOUD truncation comment', () => {
    const entries: SitemapEntry[] = []
    for (let i = 0; i < 7; i++) entries.push({ pageId: `p${i}`, slug: `page-${i}` })
    const xml = buildSitemapXml(entries, SITE, { urlCap: 5 })
    expect(xml).toContain('<!-- truncated: showing 5 of 7 URLs (cap 5) -->')
    expect(xml.match(/<url>/g)?.length).toBe(5)
  })

  test('default cap is SITEMAP_URL_CAP and untruncated output has no comment', () => {
    const xml = buildSitemapXml([{ pageId: 'p1', slug: 'a' }], SITE)
    expect(SITEMAP_URL_CAP).toBe(5000)
    expect(xml).not.toContain('<!--')
  })

  test('flags a possibly-truncated storage read', () => {
    const xml = buildSitemapXml([], SITE, { truncatedLoad: true })
    expect(xml).toContain('storage list cap')
  })

  test('suppresses lastmod when the stored value is not W3C datetime (review #12)', () => {
    const xml = buildSitemapXml(
      [{ pageId: 'p1', slug: 'a', lastmod: 'not-a-date' }],
      SITE,
    )
    expect(xml).not.toContain('<lastmod>')
  })
})

// ---------------------------------------------------------------------------
// entriesFromRecords + loadSitemapEntries (mock collection)
// ---------------------------------------------------------------------------

function record(id: string, data: Record<string, unknown>): SitemapRecordLike {
  return { id, data }
}

class MockCollection implements SitemapCollectionLike {
  records: SitemapRecordLike[] = []
  listCalls: Array<{ filter?: Record<string, unknown>; limit?: number; offset?: number }> = []
  deleted: string[] = []

  async list(options: { filter?: Record<string, unknown>; limit?: number; offset?: number } = {}) {
    this.listCalls.push(options)
    let matched = this.records
    const filter = options.filter
    if (filter !== undefined) {
      matched = matched.filter((r) =>
        Object.entries(filter).every(([field, value]) => r.data[field] === value),
      )
    }
    const offset = options.offset ?? 0
    const limit = options.limit ?? 50
    return { records: matched.slice(offset, offset + limit) }
  }

  async create(data: Record<string, unknown>) {
    const r = record(`r${this.records.length}`, data)
    this.records.unshift(r) // newest first, like created_at desc
    return r
  }

  async update(recordId: string, data: Record<string, unknown>) {
    const r = this.records.find((x) => x.id === recordId)
    if (r) r.data = data
    return r ?? null
  }

  async delete(recordId: string) {
    this.deleted.push(recordId)
    this.records = this.records.filter((x) => x.id !== recordId)
    return true
  }
}

describe('entriesFromRecords', () => {
  test('newest-wins per key, malformed records skipped', () => {
    const entries = entriesFromRecords([
      record('new', { key: 'page:p1', pageId: 'p1', slug: 'new-slug' }),
      record('bad', { key: 'page:zzz', pageId: 'p1', slug: 'x' }),
      record('old', { key: 'page:p1', pageId: 'p1', slug: 'old-slug' }),
      record('other', { key: 'page:p2', pageId: 'p2', slug: 'index' }),
    ])
    expect(entries).toEqual([
      { pageId: 'p1', slug: 'new-slug' },
      { pageId: 'p2', slug: 'index' },
    ])
  })
})

describe('loadSitemapEntries', () => {
  test('single page load, memoized within the TTL', async () => {
    const col = new MockCollection()
    await col.create({ key: 'page:p1', pageId: 'p1', slug: 'a' })
    const first = await loadSitemapEntries(col, 1000)
    expect(first.entries).toHaveLength(1)
    expect(first.truncated).toBe(false)
    await col.create({ key: 'page:p2', pageId: 'p2', slug: 'b' })
    const cached = await loadSitemapEntries(col, 2000)
    expect(cached.entries).toHaveLength(1) // still the cached load
    invalidateSitemapCache()
    const fresh = await loadSitemapEntries(col, 3000)
    expect(fresh.entries).toHaveLength(2)
  })

  test('pages through the host list cap and flags exhaustion', async () => {
    const col = new MockCollection()
    for (let i = 0; i < SITEMAP_LIST_PAGE_SIZE * 5; i++) {
      col.records.push(record(`r${i}`, { key: `page:p${i}`, pageId: `p${i}`, slug: `s${i}` }))
    }
    const load = await loadSitemapEntries(col, 1000)
    expect(load.entries).toHaveLength(SITEMAP_URL_CAP)
    expect(load.truncated).toBe(true)
    expect(col.listCalls.length).toBe(5)
    expect(col.listCalls[1]).toEqual({ limit: SITEMAP_LIST_PAGE_SIZE, offset: SITEMAP_LIST_PAGE_SIZE })
  })

  test('short page ends the sweep without the truncation flag', async () => {
    const col = new MockCollection()
    for (let i = 0; i < SITEMAP_LIST_PAGE_SIZE + 3; i++) {
      col.records.push(record(`r${i}`, { key: `page:p${i}`, pageId: `p${i}`, slug: `s${i}` }))
    }
    const load = await loadSitemapEntries(col, 1000)
    expect(load.entries).toHaveLength(SITEMAP_LIST_PAGE_SIZE + 3)
    expect(load.truncated).toBe(false)
  })
})

describe('listSitemapRecordsForKey', () => {
  test('filters by key', async () => {
    const col = new MockCollection()
    await col.create({ key: 'page:p1', pageId: 'p1', slug: 'a' })
    await col.create({ key: 'page:p2', pageId: 'p2', slug: 'b' })
    const records = await listSitemapRecordsForKey(col, 'page:p1')
    expect(records).toHaveLength(1)
    expect(records[0]!.data.pageId).toBe('p1')
  })
})

// ---------------------------------------------------------------------------
// shouldPruneRecord (cursor-paged reconcile — review #2/#5)
// ---------------------------------------------------------------------------

describe('shouldPruneRecord', () => {
  const live = record('live', { key: 'page:p1', pageId: 'p1', slug: 'a' })

  test('keeps a record whose page exists, is published, and is not a template', () => {
    expect(shouldPruneRecord(live, { status: 'published', cells: {} })).toBe(false)
  })

  test('REGRESSION (blocker #2): a published→draft revert is pruned', () => {
    expect(shouldPruneRecord(live, { status: 'draft', cells: {} })).toBe(true)
    expect(shouldPruneRecord(live, { status: 'scheduled', cells: {} })).toBe(true)
  })

  test('prunes deleted pages, templates, and malformed records', () => {
    expect(shouldPruneRecord(live, null)).toBe(true)
    expect(
      shouldPruneRecord(live, { status: 'published', cells: { templateEnabled: true } }),
    ).toBe(true)
    expect(
      shouldPruneRecord(record('junk', { key: 'nonsense' }), { status: 'published', cells: {} }),
    ).toBe(true)
  })

  test('REGRESSION (blocker #2, end to end): reconciling a drafted page drops it from sitemap output', async () => {
    const col = new MockCollection()
    await col.create({ key: 'page:keep', pageId: 'keep', slug: 'stays' })
    await col.create({ key: 'page:drafted', pageId: 'drafted', slug: 'reverted' })

    // Simulate the tick: verdict per record against the pages table.
    const pageStatus: Record<string, string> = { keep: 'published', drafted: 'draft' }
    for (const rec of [...col.records]) {
      const pageId = rec.data.pageId as string
      const page = { status: pageStatus[pageId]!, cells: {} }
      if (shouldPruneRecord(rec, page)) await col.delete(rec.id)
    }

    invalidateSitemapCache()
    const load = await loadSitemapEntries(col, 1)
    const xml = buildSitemapXml(load.entries, 'https://example.com')
    expect(xml).toContain('https://example.com/stays')
    expect(xml).not.toContain('reverted')
    expect(load.entries.map((e) => e.slug)).toEqual(['stays'])
  })
})

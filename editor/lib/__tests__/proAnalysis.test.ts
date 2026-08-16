import { describe, expect, test } from 'bun:test'
import { analyzeContent, prepareContent } from '../../../server/lib/analysis'
import { FOCUS_KEYWORDS_MAX } from '../../../server/seoMeta'
import { buildAnalysisView } from '../../../admin/lib/analysisView'
import {
  KEYWORD_CAP,
  LICENSE_ROUTE,
  analysisDisplayForTier,
  buildKeywordViews,
  canAddKeyword,
  createLicenseRefetchGate,
  proUnlockedFromResponse,
  scoredKeywordsForTier,
  type TierTaggedAnalysis,
} from '../proAnalysis'

const RICH_HTML = [
  '<h1>Best coffee beans</h1>',
  '<p>Coffee beans taste great and coffee beans are healthy. This guide covers coffee beans in depth.</p>',
  '<h2>Roasting coffee beans</h2>',
  '<p>Roast slowly. Then grind. Additionally, store the beans in a cool place.</p>',
  '<img src="/uploads/beans.jpg" alt="coffee beans on a table">',
  '<a href="/shop">Shop</a>',
].join('')

const META = {
  title: 'Best coffee beans — roast guide',
  metaDescription:
    'Everything about coffee beans: choosing, roasting and storing them for the best cup of coffee every single morning.',
  slug: 'coffee-beans',
  url: 'https://example.test/coffee-beans',
}

/** One extraction, shared by every keyword pass — the panel's pattern. */
const RICH_PREPARED = prepareContent(RICH_HTML)

describe('license state (proUnlockedFromResponse)', () => {
  test('route constant is the shared /license contract', () => {
    expect(LICENSE_ROUTE).toBe('/license')
  })

  test('non-OK response (free build 404) reads as locked', () => {
    expect(proUnlockedFromResponse(false, { license: { status: 'active', unlocked: true } })).toBe(
      false,
    )
  })

  test('malformed bodies read as locked, never unlocked', () => {
    expect(proUnlockedFromResponse(true, null)).toBe(false)
    expect(proUnlockedFromResponse(true, 'nope')).toBe(false)
    expect(proUnlockedFromResponse(true, {})).toBe(false)
    expect(proUnlockedFromResponse(true, { license: null })).toBe(false)
    expect(proUnlockedFromResponse(true, { license: { status: 'weird', unlocked: true } })).toBe(
      false,
    )
  })

  test('server-computed unlocked boolean is read as-is', () => {
    expect(proUnlockedFromResponse(true, { license: { status: 'active', unlocked: true } })).toBe(
      true,
    )
    expect(proUnlockedFromResponse(true, { license: { status: 'active', unlocked: false } })).toBe(
      false,
    )
    // Status alone never unlocks — only the server's boolean does.
    expect(proUnlockedFromResponse(true, { license: { status: 'active' } })).toBe(false)
  })
})

describe('scoredKeywordsForTier', () => {
  test('locked = the free slot-0 slice, unchanged semantics', () => {
    expect(scoredKeywordsForTier(['coffee beans', 'roasting'], false)).toEqual(['coffee beans'])
    expect(scoredKeywordsForTier([' padded ', 'extra'], false)).toEqual(['padded'])
    // Empty primary scores nothing even when Pro extras are stored.
    expect(scoredKeywordsForTier(['', 'extra'], false)).toEqual([])
    expect(scoredKeywordsForTier([], false)).toEqual([])
  })

  test('unlocked = full server-contract-normalized list', () => {
    expect(scoredKeywordsForTier(['coffee beans', ' roasting ', ''], true)).toEqual([
      'coffee beans',
      'roasting',
    ])
    // Dedupe mirrors the server (NFC + lowercase, first original kept).
    expect(scoredKeywordsForTier(['Coffee', 'coffee', 'tea'], true)).toEqual(['Coffee', 'tea'])
    expect(scoredKeywordsForTier([], true)).toEqual([])
  })
})

describe('canAddKeyword', () => {
  test('cap is the server stored cap', () => {
    expect(KEYWORD_CAP).toBe(FOCUS_KEYWORDS_MAX)
  })

  test('locked never adds; unlocked adds up to the cap', () => {
    expect(canAddKeyword(1, false)).toBe(false)
    expect(canAddKeyword(0, false)).toBe(false)
    expect(canAddKeyword(1, true)).toBe(true)
    expect(canAddKeyword(KEYWORD_CAP - 1, true)).toBe(true)
    expect(canAddKeyword(KEYWORD_CAP, true)).toBe(false)
    expect(canAddKeyword(KEYWORD_CAP + 1, true)).toBe(false)
  })
})

describe('buildKeywordViews', () => {
  test('one view per keyword, stored order, full keyword-check itemization', () => {
    const views = buildKeywordViews({
      ...META,
      prepared: RICH_PREPARED,
      source: 'tree',
      keywords: ['coffee beans', 'quantum finance'],
    })
    expect(views.map((v) => v.keyword)).toEqual(['coffee beans', 'quantum finance'])
    // Every keyword gets the same per-check itemization slot 0 gets today
    // (7 keyword checks at this pin).
    const aggregate = buildAnalysisView({
      result: analyzeContent({ ...META, html: RICH_HTML, focusKeywords: ['coffee beans'] }),
      imageAudit: null,
      source: 'tree',
      keywordCount: 1,
    })
    const aggregateKeywordGroup = aggregate.groups.find((g) => g.id === 'keyword')
    expect(aggregateKeywordGroup).toBeDefined()
    for (const view of views) {
      expect(view.rows.length).toBe(aggregateKeywordGroup!.rows.length)
    }
    // A matching keyword outscores a keyword absent from the page.
    expect(views[0].score).toBeGreaterThan(views[1].score)
    expect(views[0].max).toBeGreaterThan(0)
  })

  test('single-keyword view is exactly the slot-0 keyword group (parity)', () => {
    const [view] = buildKeywordViews({
      ...META,
      prepared: RICH_PREPARED,
      source: 'tree',
      keywords: ['coffee beans'],
    })
    const aggregate = buildAnalysisView({
      result: analyzeContent({ ...META, html: RICH_HTML, focusKeywords: ['coffee beans'] }),
      imageAudit: null,
      source: 'tree',
      keywordCount: 1,
    })
    const group = aggregate.groups.find((g) => g.id === 'keyword')!
    expect(view.rows).toEqual(group.rows)
    expect(view.score).toBe(group.score)
    expect(view.max).toBe(group.max)
  })

  test('tree source na-remarks the alt-dependent check and excludes its points', () => {
    const tree = buildKeywordViews({
      ...META,
      prepared: RICH_PREPARED,
      source: 'tree',
      keywords: ['coffee beans'],
    })[0]
    const altRow = tree.rows.find((r) => r.id === 'keyword-in-image-alt')
    expect(altRow).toBeDefined()
    expect(altRow!.status).toBe('na')
    expect(altRow!.glyph).toBe('–')

    // Non-tree source keeps the engine's own verdict (the alt IS readable):
    // same HTML, alt contains the keyword → scored, and max grows by it.
    const published = buildKeywordViews({
      ...META,
      prepared: RICH_PREPARED,
      source: 'none',
      keywords: ['coffee beans'],
    })[0]
    const publishedAltRow = published.rows.find((r) => r.id === 'keyword-in-image-alt')
    expect(publishedAltRow!.status).not.toBe('na')
    expect(published.max).toBeGreaterThan(tree.max)
  })

  test('no-content mode still itemizes the content-independent checks', () => {
    const [view] = buildKeywordViews({
      ...META,
      prepared: undefined,
      source: 'none',
      keywords: ['coffee beans'],
    })
    expect(view.rows.length).toBeGreaterThan(0)
    const titleRow = view.rows.find((r) => r.id === 'keyword-in-title')
    expect(titleRow).toBeDefined()
    expect(titleRow!.status).not.toBe('na')
  })

  test('empty keyword list yields no views', () => {
    expect(
      buildKeywordViews({ ...META, prepared: RICH_PREPARED, source: 'tree', keywords: [] }),
    ).toEqual([])
  })

  test('prepared path matches the html path exactly (no reparse drift)', () => {
    // buildKeywordViews used to call analyzeContent({ html }) per keyword;
    // the shared-extraction path must produce the identical views.
    const views = buildKeywordViews({
      ...META,
      prepared: RICH_PREPARED,
      source: 'tree',
      keywords: ['coffee beans', 'quantum finance'],
    })
    for (const [i, keyword] of ['coffee beans', 'quantum finance'].entries()) {
      const aggregate = buildAnalysisView({
        result: analyzeContent({ ...META, html: RICH_HTML, focusKeywords: [keyword] }),
        imageAudit: null,
        source: 'tree',
        keywordCount: 1,
      })
      const group = aggregate.groups.find((g) => g.id === 'keyword')!
      expect(views[i].rows).toEqual(group.rows)
      expect(views[i].score).toBe(group.score)
      expect(views[i].max).toBe(group.max)
    }
  })
})

describe('analysisDisplayForTier (license-downgrade suppression)', () => {
  const view = buildAnalysisView({
    result: analyzeContent({ ...META, html: RICH_HTML, focusKeywords: ['coffee beans'] }),
    imageAudit: null,
    source: 'tree',
    keywordCount: 1,
  })
  const keywordViews = buildKeywordViews({
    ...META,
    prepared: RICH_PREPARED,
    source: 'tree',
    keywords: ['coffee beans', 'roasting'],
  })
  const proState: TierTaggedAnalysis = { proUnlocked: true, view, keywordViews }
  const freeState: TierTaggedAnalysis = { proUnlocked: false, view, keywordViews: null }

  test('matching tiers pass everything through', () => {
    expect(analysisDisplayForTier(proState, true)).toEqual({
      view,
      keywordViews,
      proUnlocked: true,
    })
    expect(analysisDisplayForTier(freeState, false)).toEqual({
      view,
      keywordViews: null,
      proUnlocked: false,
    })
  })

  test('downgrade (computed Pro, now locked) suppresses instantly', () => {
    const display = analysisDisplayForTier(proState, false)
    // Aggregate stays visible in the LOCKED presentation; per-keyword hides.
    expect(display.view).toBe(view)
    expect(display.keywordViews).toBeNull()
    expect(display.proUnlocked).toBe(false)
  })

  test('upgrade (computed locked, now Pro) keeps locked presentation until recompute', () => {
    const display = analysisDisplayForTier(freeState, true)
    expect(display.view).toBe(view)
    expect(display.keywordViews).toBeNull()
    // Never claim Pro over free-computed numbers.
    expect(display.proUnlocked).toBe(false)
  })

  test('null state renders nothing regardless of tier', () => {
    expect(analysisDisplayForTier(null, true)).toEqual({
      view: null,
      keywordViews: null,
      proUnlocked: true,
    })
    expect(analysisDisplayForTier(null, false)).toEqual({
      view: null,
      keywordViews: null,
      proUnlocked: false,
    })
  })
})

describe('createLicenseRefetchGate', () => {
  test('concurrent callers share the in-flight promise (single fetch)', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = createLicenseRefetchGate(5000, () => 0)
    const fetcher = () => {
      calls += 1
      return new Promise<void>((resolve) => {
        release = resolve
      })
    }
    const first = gate(fetcher)
    const second = gate(fetcher)
    const third = gate(fetcher)
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(calls).toBe(1)
    release!()
    await first
  })

  test('minimum interval throttles settled refetches, measured from start', async () => {
    let t = 0
    let calls = 0
    const gate = createLicenseRefetchGate(5000, () => t)
    const fetcher = async () => {
      calls += 1
    }
    await gate(fetcher) // first call always runs
    t = 3000
    await gate(fetcher) // inside the window — no-op
    expect(calls).toBe(1)
    t = 5000
    await gate(fetcher) // window elapsed — runs
    expect(calls).toBe(2)
    t = 7000
    await gate(fetcher) // inside the NEW window — no-op
    expect(calls).toBe(2)
  })

  test('a rejected refetch clears the in-flight slot for the next attempt', async () => {
    let t = 0
    const gate = createLicenseRefetchGate(1000, () => t)
    await expect(gate(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    t = 2000
    let ran = false
    await gate(async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  test('an in-flight fetch outlasting the interval is still shared, then a new one runs', async () => {
    let t = 0
    let calls = 0
    let release: (() => void) | undefined
    const gate = createLicenseRefetchGate(1000, () => t)
    const slow = () => {
      calls += 1
      return new Promise<void>((resolve) => {
        release = resolve
      })
    }
    const first = gate(slow)
    t = 5000 // interval long gone, but the fetch is still in flight
    expect(gate(slow)).toBe(first)
    expect(calls).toBe(1)
    release!()
    await first
    await gate(async () => {
      calls += 1
    })
    expect(calls).toBe(2)
  })
})

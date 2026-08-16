import { describe, expect, test } from 'bun:test'
import { analyzeContent, type AnalysisResult } from '../../../server/lib/analysis'
import { auditImages } from '../../../server/lib/imageAudit'
import {
  MAX_IMAGE_FINDINGS_SHOWN,
  buildSkippedNote,
  NOTE_NO_CONTENT,
  NOTE_NO_KEYWORD,
  NOTE_TREE_IMAGE_LIMITS,
  SCORE_GOOD_MIN,
  SCORE_OK_MIN,
  buildAnalysisView,
  formatImageFinding,
  formatStatsLine,
  scoreTone,
  shortenSrc,
} from '../analysisView'

const RICH_HTML = [
  '<h1>Best coffee beans</h1>',
  '<p>Coffee beans taste great and coffee beans are healthy. This guide covers coffee beans in depth.</p>',
  '<h2>Roasting coffee beans</h2>',
  '<p>Roast slowly. Then grind. Additionally, store the beans in a cool place.</p>',
  '<img src="/uploads/beans.jpg">',
  '<a href="/shop">Shop</a>',
  '<a href="https://elsewhere.test/x">More</a>',
].join('')

function analyze(html?: string): AnalysisResult {
  return analyzeContent({
    html,
    title: 'Best coffee beans — roast guide',
    metaDescription:
      'Everything about coffee beans: choosing, roasting and storing them for the best cup of coffee every single morning.',
    slug: 'coffee-beans',
    url: 'https://example.test/coffee-beans',
    focusKeywords: ['coffee beans'],
  })
}

describe('scoreTone thresholds (documented: good ≥ 80, ok 50–79, bad < 50)', () => {
  test('boundaries', () => {
    expect(scoreTone(SCORE_GOOD_MIN)).toBe('good')
    expect(scoreTone(SCORE_GOOD_MIN - 1)).toBe('ok')
    expect(scoreTone(SCORE_OK_MIN)).toBe('ok')
    expect(scoreTone(SCORE_OK_MIN - 1)).toBe('bad')
    expect(scoreTone(100)).toBe('good')
    expect(scoreTone(0)).toBe('bad')
  })
})

describe('buildAnalysisView', () => {
  test('groups follow the engine order with labels and per-check rows', () => {
    const result = analyze(RICH_HTML)
    const view = buildAnalysisView({
      result,
      imageAudit: auditImages(RICH_HTML),
      source: 'tree',
      keywordCount: 1,
    })
    expect(view.groups.map((g) => g.id)).toEqual([
      'keyword',
      'title',
      'description',
      'content',
      'readability',
    ])
    const title = view.groups.find((g) => g.id === 'title')
    expect(title?.label).toBe('SEO title')
    expect(title?.rows.map((r) => r.id)).toEqual(['title-exists', 'title-length'])
    for (const row of view.groups.flatMap((g) => g.rows)) {
      expect(row.glyph.length).toBeGreaterThan(0)
      expect(row.detail.length).toBeGreaterThan(0)
    }
  })

  test('tree source re-marks keyword-in-image-alt as na and recomputes the score', () => {
    const result = analyze(RICH_HTML)
    // The serialized tree has images without alt → the engine scores the
    // alt check 'bad' 0/2. The view must exclude it instead (unknowable).
    const engineAlt = result.checks.find((c) => c.id === 'keyword-in-image-alt')
    expect(engineAlt?.status).toBe('bad')

    const view = buildAnalysisView({ result, imageAudit: null, source: 'tree', keywordCount: 1 })
    const altRow = view.groups
      .find((g) => g.id === 'keyword')
      ?.rows.find((r) => r.id === 'keyword-in-image-alt')
    expect(altRow?.status).toBe('na')

    // Score recomputed with the check's max excluded from available points.
    let earned = 0
    let available = 0
    for (const check of result.checks) {
      if (check.status === 'na' || check.id === 'keyword-in-image-alt') continue
      earned += check.score
      available += check.max
    }
    expect(view.score).toBe(Math.round((100 * earned) / available))
    // Keyword group max shrinks by the excluded check's 2 points.
    const keywordGroup = view.groups.find((g) => g.id === 'keyword')
    expect(keywordGroup?.max).toBe(result.groups.keyword.max - 2)
  })

  test('published/none sources keep the engine scoring untouched', () => {
    const result = analyze(undefined)
    const view = buildAnalysisView({ result, imageAudit: null, source: 'none', keywordCount: 1 })
    expect(view.score).toBe(result.score)
    expect(view.notes).toEqual([NOTE_NO_CONTENT])
  })

  test('zero keywords adds the keyword note', () => {
    const result = analyzeContent({ html: RICH_HTML, title: 'T' })
    const view = buildAnalysisView({
      result,
      imageAudit: auditImages(RICH_HTML),
      source: 'tree',
      keywordCount: 0,
    })
    expect(view.notes).toEqual([NOTE_NO_KEYWORD])
  })

  test('stats line', () => {
    const result = analyze(RICH_HTML)
    expect(formatStatsLine(result.stats)).toBe(
      `${result.stats.wordCount} words · 2 headings · 1 image · 2 links`,
    )
  })
})

describe('image warnings', () => {
  test('tree source suppresses alt/dimension findings (unknowable) with a note', () => {
    const audit = auditImages('<img src="/a.jpg"><img src="/b.jpg">')
    expect(audit.findings.some((f) => f.code === 'missing-alt')).toBe(true)
    const result = analyze(RICH_HTML)
    const view = buildAnalysisView({ result, imageAudit: audit, source: 'tree', keywordCount: 1 })
    expect(view.imageWarnings).toEqual({
      totalImages: 2,
      shown: [],
      moreCount: 0,
      note: NOTE_TREE_IMAGE_LIMITS,
    })
  })

  test('tree source suppresses even huge-inline-image (data: URLs cannot publish — sanitizer)', () => {
    const huge = `<img src="data:image/png;base64,${'A'.repeat(70000)}">`
    const audit = auditImages(huge)
    expect(audit.findings.some((f) => f.code === 'huge-inline-image')).toBe(true)
    const view = buildAnalysisView({
      result: analyze(RICH_HTML),
      imageAudit: audit,
      source: 'tree',
      keywordCount: 1,
    })
    expect(view.imageWarnings?.shown).toEqual([])
    expect(view.imageWarnings?.moreCount).toBe(0)
    // Non-tree sources still report it (published HTML could carry it via
    // hand-injected markup — audited as-is there).
    const published = buildAnalysisView({
      result: analyze(RICH_HTML),
      imageAudit: audit,
      source: 'none',
      keywordCount: 1,
    })
    expect(published.imageWarnings?.shown.some((l) => l.includes('Very large inline'))).toBe(true)
  })

  test('skipped-sections note appears for partial tree serialization', () => {
    const result = analyze(RICH_HTML)
    const one = buildAnalysisView({
      result,
      imageAudit: null,
      source: 'tree',
      keywordCount: 1,
      skippedCount: 1,
    })
    expect(one.notes).toEqual([buildSkippedNote(1)])
    expect(buildSkippedNote(1)).toBe(
      '1 section lives inside visual components, loops, or unsupported blocks and is not analyzed.',
    )
    expect(buildSkippedNote(3)).toBe(
      '3 sections live inside visual components, loops, or unsupported blocks and are not analyzed.',
    )
    // Complete tree / non-tree sources: no skipped note.
    const complete = buildAnalysisView({
      result,
      imageAudit: null,
      source: 'tree',
      keywordCount: 1,
      skippedCount: 0,
    })
    expect(complete.notes).toEqual([])
    const none = buildAnalysisView({
      result: analyze(undefined),
      imageAudit: null,
      source: 'none',
      keywordCount: 1,
      skippedCount: 2,
    })
    expect(none.notes).toEqual([NOTE_NO_CONTENT])
  })

  test('caps at MAX_IMAGE_FINDINGS_SHOWN with an "and N more" count (non-tree source)', () => {
    const audit = auditImages(
      ['a', 'b', 'c', 'd', 'e'].map((n) => `<img src="/${n}.jpg" alt="">`).join(''),
    )
    const view = buildAnalysisView({
      result: analyze(RICH_HTML),
      imageAudit: audit,
      source: 'none',
      keywordCount: 1,
    })
    expect(view.imageWarnings?.shown.length).toBe(MAX_IMAGE_FINDINGS_SHOWN)
    // 5 images × (empty-alt + missing-dimensions) = 10 findings, 3 shown.
    expect(view.imageWarnings?.moreCount).toBe(7)
  })

  test('no audit → no warnings block', () => {
    const view = buildAnalysisView({
      result: analyze(undefined),
      imageAudit: null,
      source: 'none',
      keywordCount: 1,
    })
    expect(view.imageWarnings).toBe(null)
  })

  test('finding formatting shortens srcs', () => {
    expect(shortenSrc('/uploads/2026/a-very-nice-photo.jpg?v=3')).toBe('a-very-nice-photo.jpg')
    expect(shortenSrc('')).toBe('(no src)')
    expect(shortenSrc(`data:image/png;base64,${'A'.repeat(200)}`)).toBe('inline data: image')
    expect(
      formatImageFinding({ code: 'missing-alt', src: '/x/y.png', index: 0 }),
    ).toBe('Missing alt text — y.png')
  })
})

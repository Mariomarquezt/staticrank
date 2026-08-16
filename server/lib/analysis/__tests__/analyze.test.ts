import { describe, expect, test } from 'bun:test'
import { analyzeContent, extractTextFromHtml, type AnalysisResult } from '../index'

const KEYWORD_CHECK_IDS = [
  'keyword-in-title',
  'keyword-in-description',
  'keyword-in-slug',
  'keyword-in-first-paragraph',
  'keyword-density',
  'keyword-in-heading',
  'keyword-in-image-alt',
]

const ALL_GROUPS = ['keyword', 'title', 'description', 'content', 'readability']

function assertScoringInvariants(res: AnalysisResult): void {
  let earned = 0
  let available = 0
  const groupEarned: Record<string, number> = {}
  const groupMax: Record<string, number> = {}
  for (const c of res.checks) {
    expect(ALL_GROUPS).toContain(c.group)
    expect(c.score).toBeGreaterThanOrEqual(0)
    expect(c.score).toBeLessThanOrEqual(c.max)
    if (c.status === 'na') {
      expect(c.score).toBe(0)
      continue
    }
    earned += c.score
    available += c.max
    groupEarned[c.group] = (groupEarned[c.group] ?? 0) + c.score
    groupMax[c.group] = (groupMax[c.group] ?? 0) + c.max
  }
  expect(res.score).toBe(available === 0 ? 0 : Math.round((100 * earned) / available))
  for (const g of ALL_GROUPS) {
    expect(res.groups[g]).toBeDefined()
    expect(res.groups[g].max).toBe(groupMax[g] ?? 0)
    expect(res.groups[g].score).toBeCloseTo(groupEarned[g] ?? 0, 2)
  }
}

describe('analyzeContent — zero keywords', () => {
  test('keyword group is entirely na and excluded from scoring', () => {
    const res = analyzeContent({
      html: '<h2>Hello</h2><p>Some decent text here today.</p>',
      title: 'A Reasonable Title Of Decent Length Here',
      metaDescription: 'd'.repeat(130),
    })
    for (const id of KEYWORD_CHECK_IDS) {
      const check = res.checks.find((c) => c.id === id)
      expect(check).toBeDefined()
      expect(check?.status).toBe('na')
    }
    expect(res.groups.keyword).toEqual({ score: 0, max: 0 })
    expect(res.score).toBeGreaterThan(0) // the rest still scores
    assertScoringInvariants(res)
  })
})

describe('analyzeContent — scoring math', () => {
  test('rich input satisfies the scoring invariants', () => {
    const body = 'The best coffee is made here and we like it because it is fresh. '.repeat(30)
    const res = analyzeContent({
      html: `<p>${body}</p><h2>Best coffee brewing</h2><p>${body}</p><img src="a.jpg" alt="best coffee cup"><p><a href="/related">more</a> and <a href="https://origin.example/source">source</a></p>`,
      title: 'Best Coffee: A Practical Brewing Guide',
      metaDescription: `${'How to brew the best coffee at home. '.repeat(4)}`,
      slug: 'best-coffee-guide',
      url: 'https://mysite.com/best-coffee-guide',
      focusKeywords: ['best coffee'],
    })
    assertScoringInvariants(res)
    expect(res.score).toBeGreaterThan(70)
  })

  test('multi-keyword input satisfies the invariants (fractional keyword scores)', () => {
    const res = analyzeContent({
      html: `<p>${'coffee time is good and the tea is fine because we say so. '.repeat(20)}</p>`,
      title: 'Coffee and Tea',
      focusKeywords: ['coffee', 'tea', 'zebra'],
    })
    assertScoringInvariants(res)
  })

  test('empty input scores 0 but is not all-na (existence checks still fail)', () => {
    const res = analyzeContent({})
    expect(res.score).toBe(0)
    expect(res.checks.some((c) => c.status === 'bad')).toBe(true)
    assertScoringInvariants(res)
  })

  test('check ids are unique', () => {
    const res = analyzeContent({ html: '<p>hi</p>', focusKeywords: ['hi'] })
    const ids = res.checks.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('analyzeContent — stats', () => {
  test('counts words, sentences, paragraphs, headings, images, links', () => {
    const res = analyzeContent({
      html: '<h2>Head</h2><p>One two three. Four five.</p><p>Six seven.</p><img src="x" alt=""><a href="/y">link</a>',
    })
    expect(res.stats.wordCount).toBe(9) // head + 7 body words + link
    expect(res.stats.sentenceCount).toBe(5) // "Head" block + 3 punctuated + trailing "link" block
    expect(res.stats.paragraphCount).toBe(3) // two <p> + trailing "link" text
    expect(res.stats.headingCount).toBe(1)
    expect(res.stats.imageCount).toBe(1)
    expect(res.stats.linkCount).toBe(1)
    expect(res.stats.isEnglish).toBe(true) // under 10 words → assumed English
  })

  test('text-only input reports zero images/links and na for html-only checks', () => {
    const res = analyzeContent({ text: 'Hello there.\n\nSecond paragraph here.' })
    expect(res.stats.paragraphCount).toBe(2)
    expect(res.stats.imageCount).toBe(0)
    expect(res.stats.linkCount).toBe(0)
    for (const id of ['content-has-h2', 'content-images', 'content-internal-link', 'content-external-link']) {
      expect(res.checks.find((c) => c.id === id)?.status).toBe('na')
    }
  })
})

describe('performance sanity (~200KB document)', () => {
  test('analyzeContent handles a 200KB page quickly', () => {
    let html = ''
    for (let i = 0; i < 400; i += 1) {
      if (i % 10 === 0) html += `<h2>Section ${i} about coffee</h2>`
      html += `<p>${'The quick brown fox jumps over the lazy dog and it is seen well. '.repeat(8)}coffee time</p>`
    }
    expect(html.length).toBeGreaterThan(190_000)
    const t0 = Date.now()
    const res = analyzeContent({
      html,
      title: 'Coffee Performance Fixture',
      metaDescription: 'm'.repeat(140),
      slug: 'coffee-performance',
      url: 'https://example.com/coffee-performance',
      focusKeywords: ['coffee', 'lazy dog'],
    })
    const elapsed = Date.now() - t0
    expect(res.stats.wordCount).toBeGreaterThan(40_000)
    assertScoringInvariants(res)
    expect(elapsed).toBeLessThan(3000)
  })

  test('extractTextFromHtml on the same scale stays linear-ish', () => {
    const chunk = '<div><p>alpha <b>beta</b> gamma &amp; delta</p><!-- c --><script>1<2</script></div>'
    const html = chunk.repeat(2500) // ~212KB
    const t0 = Date.now()
    const text = extractTextFromHtml(html)
    expect(text).toContain('alpha beta gamma & delta')
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})

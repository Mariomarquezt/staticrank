import { describe, expect, test } from 'bun:test'
import { analyzeContent, type AnalysisInput, type CheckResult } from '../index'

function run(input: AnalysisInput): (id: string) => CheckResult {
  const res = analyzeContent(input)
  const map = new Map(res.checks.map((c) => [c.id, c]))
  return (id: string) => {
    const c = map.get(id)
    if (c === undefined) throw new Error(`missing check ${id}`)
    return c
  }
}

/** n words of neutral filler. */
const lorem = (n: number): string => 'lorem '.repeat(n).trim()

describe('keyword-in-title', () => {
  test('front-loaded keyword is good', () => {
    const c = run({ title: 'Best Coffee Beans for Espresso', text: 'x', focusKeywords: ['best coffee'] })
    expect(c('keyword-in-title').status).toBe('good')
    expect(c('keyword-in-title').score).toBe(4)
  })

  test('keyword late in the title is ok with reduced score', () => {
    const c = run({ title: 'The Ultimate Guide to Best Coffee', text: 'x', focusKeywords: ['best coffee'] })
    expect(c('keyword-in-title').status).toBe('ok')
    expect(c('keyword-in-title').score).toBe(3)
  })

  test('absent keyword is bad; missing title is na', () => {
    expect(run({ title: 'Tea Time', text: 'x', focusKeywords: ['coffee'] })('keyword-in-title').status).toBe('bad')
    expect(run({ text: 'x', focusKeywords: ['coffee'] })('keyword-in-title').status).toBe('na')
  })

  test('whitespace-only targets are na, consistent with existence checks (finding 11)', () => {
    const c = run({ title: '   ', metaDescription: ' \t ', slug: '  ', text: 'x', focusKeywords: ['coffee'] })
    expect(c('keyword-in-title').status).toBe('na')
    expect(c('keyword-in-description').status).toBe('na')
    expect(c('keyword-in-slug').status).toBe('na')
    expect(c('title-exists').status).toBe('bad')
    expect(c('description-exists').status).toBe('bad')
  })
})

describe('keyword-in-description / slug / first paragraph', () => {
  test('description good/bad/na', () => {
    expect(
      run({ metaDescription: 'Great coffee here.', text: 'x', focusKeywords: ['coffee'] })('keyword-in-description').status,
    ).toBe('good')
    expect(
      run({ metaDescription: 'Great tea here.', text: 'x', focusKeywords: ['coffee'] })('keyword-in-description').status,
    ).toBe('bad')
    expect(run({ text: 'x', focusKeywords: ['coffee'] })('keyword-in-description').status).toBe('na')
  })

  test('slug matches hyphenated tokens', () => {
    expect(run({ slug: 'best-coffee-beans', text: 'x', focusKeywords: ['Best Coffee'] })('keyword-in-slug').status).toBe('good')
    expect(run({ slug: 'tea-time', text: 'x', focusKeywords: ['coffee'] })('keyword-in-slug').status).toBe('bad')
    expect(run({ text: 'x', focusKeywords: ['coffee'] })('keyword-in-slug').status).toBe('na')
  })

  test('first paragraph good/bad; na without content', () => {
    const html = '<p>We love coffee a lot.</p><p>Second.</p>'
    expect(run({ html, focusKeywords: ['coffee'] })('keyword-in-first-paragraph').status).toBe('good')
    const html2 = '<p>We love tea.</p><p>coffee later</p>'
    expect(run({ html: html2, focusKeywords: ['coffee'] })('keyword-in-first-paragraph').status).toBe('bad')
    expect(run({ focusKeywords: ['coffee'] })('keyword-in-first-paragraph').status).toBe('na')
  })

  test('phrase split by an inline tag still matches in content', () => {
    const html = `<p>Try the best <b>coffee</b> beans today. ${lorem(50)}</p>`
    expect(run({ html, focusKeywords: ['best coffee beans'] })('keyword-in-first-paragraph').status).toBe('good')
  })
})

describe('keyword-density (0.5–2.5% good; >0–0.5% / 2.5–3% ok; 0% bad; >3% stuffing bad)', () => {
  const withDensity = (occurrences: number, filler: number): ((id: string) => CheckResult) =>
    run({ text: `${'coffee '.repeat(occurrences)}${lorem(filler)}`, focusKeywords: ['coffee'] })

  test('~1% is good', () => {
    const c = withDensity(2, 200)('keyword-density') // 2/202 ≈ 0.99%
    expect(c.status).toBe('good')
    expect(c.score).toBe(5)
  })

  test('under 0.5% is ok', () => {
    expect(withDensity(1, 250)('keyword-density').status).toBe('ok') // 1/251 ≈ 0.4%
  })

  test('between 2.5% and 3% is ok', () => {
    expect(withDensity(3, 97)('keyword-density').status).toBe('ok') // 3/100 = 3%
  })

  test('over 3% is stuffing → bad', () => {
    const c = withDensity(5, 95)('keyword-density') // 5/100 = 5%
    expect(c.status).toBe('bad')
    expect(c.detail).toContain('stuffing')
  })

  test('zero occurrences is bad', () => {
    expect(run({ text: lorem(100), focusKeywords: ['coffee'] })('keyword-density').status).toBe('bad')
  })

  test('no content at all is na', () => {
    expect(run({ focusKeywords: ['coffee'] })('keyword-density').status).toBe('na')
  })

  test('phrases never match across block boundaries (finding 1)', () => {
    // "best" ends one paragraph, "coffee" starts the next — no phantom match.
    const html = `<p>${lorem(30)} best</p><p>coffee ${lorem(30)}</p>`
    expect(run({ html, focusKeywords: ['best coffee'] })('keyword-density').status).toBe('bad')
    // …and a <br> is a boundary too.
    const brHtml = `<p>${lorem(30)} best<br>coffee ${lorem(30)}</p>`
    expect(run({ html: brHtml, focusKeywords: ['best coffee'] })('keyword-density').status).toBe('bad')
    // Control: the same phrase inside one block still counts.
    const okHtml = `<p>${lorem(30)} best coffee ${lorem(30)}</p>`
    expect(run({ html: okHtml, focusKeywords: ['best coffee'] })('keyword-density').status).not.toBe('bad')
  })

  test('keywords are truncated to 20 tokens for matching (finding 3)', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `k${i}`).join(' ')
    const thirty = Array.from({ length: 30 }, (_, i) => `k${i}`).join(' ')
    // Content contains only the first 20 tokens; the 30-token keyword still
    // matches because it is truncated to the cap.
    const c = run({ text: `${twenty} ${lorem(180)}`, focusKeywords: [thirty] })('keyword-density')
    expect(['good', 'ok']).toContain(c.status)
  })
})

describe('keyword-in-heading / image alt', () => {
  test('keyword in an h2 is good; wrong keyword bad; no headings na', () => {
    const html = '<h2>Coffee brewing basics</h2><p>Body text.</p>'
    expect(run({ html, focusKeywords: ['coffee'] })('keyword-in-heading').status).toBe('good')
    expect(run({ html, focusKeywords: ['zebra'] })('keyword-in-heading').status).toBe('bad')
    expect(run({ html: '<p>No headings.</p>', focusKeywords: ['coffee'] })('keyword-in-heading').status).toBe('na')
  })

  test('h1 and h5 do not count as subheadings', () => {
    const html = '<h1>Coffee</h1><h5>Coffee</h5><p>Body.</p>'
    expect(run({ html, focusKeywords: ['coffee'] })('keyword-in-heading').status).toBe('na')
  })

  test('alt text good/bad/na', () => {
    const good = '<img alt="fresh coffee cup"><p>Body.</p>'
    const bad = '<img alt="a teapot"><p>Body.</p>'
    const none = '<p>Body.</p>'
    expect(run({ html: good, focusKeywords: ['coffee'] })('keyword-in-image-alt').status).toBe('good')
    expect(run({ html: bad, focusKeywords: ['coffee'] })('keyword-in-image-alt').status).toBe('bad')
    expect(run({ html: none, focusKeywords: ['coffee'] })('keyword-in-image-alt').status).toBe('na')
  })
})

describe('multi-keyword aggregation', () => {
  test('half the keywords hitting → ok with averaged score', () => {
    const c = run({
      title: 'Coffee Guide',
      text: 'x',
      focusKeywords: ['coffee', 'zebra'],
    })('keyword-in-title')
    expect(c.status).toBe('ok') // 4/8 earned
    expect(c.score).toBe(2) // mean of 4 and 0
    expect(c.detail).toContain('coffee')
    expect(c.detail).toContain('zebra')
  })

  test('blank keywords are ignored', () => {
    const c = run({ title: 'Coffee Guide', text: 'x', focusKeywords: ['  ', 'coffee'] })('keyword-in-title')
    expect(c.status).toBe('good')
  })
})

describe('title checks', () => {
  test('missing title: exists bad, length na', () => {
    const c = run({ text: 'x' })
    expect(c('title-exists').status).toBe('bad')
    expect(c('title-length').status).toBe('na')
  })

  test('length 30–60 good; short ok; long ok', () => {
    expect(run({ title: 'x'.repeat(45), text: 'x' })('title-length').status).toBe('good')
    expect(run({ title: 'x'.repeat(20), text: 'x' })('title-length').status).toBe('ok')
    expect(run({ title: 'x'.repeat(70), text: 'x' })('title-length').status).toBe('ok')
    expect(run({ title: 'x'.repeat(30), text: 'x' })('title-length').status).toBe('good')
    expect(run({ title: 'x'.repeat(60), text: 'x' })('title-length').status).toBe('good')
  })

  test('length counts code points, not UTF-16 units', () => {
    // 31 rocket emoji = 62 UTF-16 units but 31 code points → good.
    expect(run({ title: '🚀'.repeat(31), text: 'x' })('title-length').status).toBe('good')
    expect(run({ title: '🚀'.repeat(29), text: 'x' })('title-length').status).toBe('ok')
  })
})

describe('description checks', () => {
  test('missing: exists bad, length na', () => {
    const c = run({ text: 'x' })
    expect(c('description-exists').status).toBe('bad')
    expect(c('description-length').status).toBe('na')
  })

  test('120–160 good; 70–119 ok; >160 ok; <70 bad', () => {
    expect(run({ metaDescription: 'x'.repeat(140), text: 'x' })('description-length').status).toBe('good')
    expect(run({ metaDescription: 'x'.repeat(100), text: 'x' })('description-length').status).toBe('ok')
    expect(run({ metaDescription: 'x'.repeat(170), text: 'x' })('description-length').status).toBe('ok')
    expect(run({ metaDescription: 'x'.repeat(50), text: 'x' })('description-length').status).toBe('bad')
  })
})

describe('content checks', () => {
  test('large paragraph and subheading lists do not overflow Math.max spread', () => {
    const html = `${'<h2>Section</h2><p>x</p>'.repeat(10_000)}`
    expect(() => run({ html })).not.toThrow()
  })

  test('word count thresholds (300 good / 150 ok / under 150 bad)', () => {
    expect(run({ text: lorem(320) })('content-word-count').status).toBe('good')
    expect(run({ text: lorem(200) })('content-word-count').status).toBe('ok')
    expect(run({ text: lorem(100) })('content-word-count').status).toBe('bad')
  })

  test('empty <h2></h2> counts structurally but not for keyword matching (nit 12)', () => {
    const c = run({ html: '<h2></h2><p>text here</p>', focusKeywords: ['text'] })
    expect(c('content-has-h2').status).toBe('good')
    expect(c('keyword-in-heading').status).toBe('na') // no heading TEXT exists
  })

  test('h2 and image presence; na without HTML', () => {
    const withBoth = run({ html: '<h2>S</h2><p>t</p><img src="x" alt="">' })
    expect(withBoth('content-has-h2').status).toBe('good')
    expect(withBoth('content-images').status).toBe('good')
    const withNeither = run({ html: '<p>t</p>' })
    expect(withNeither('content-has-h2').status).toBe('bad')
    expect(withNeither('content-images').status).toBe('bad')
    const textOnly = run({ text: 'hello' })
    expect(textOnly('content-has-h2').status).toBe('na')
    expect(textOnly('content-images').status).toBe('na')
  })

  test('internal + external links classified against input.url', () => {
    const html = '<p><a href="/about">in</a> <a href="https://other.com/x">out</a></p>'
    const c = run({ html, url: 'https://example.com/post' })
    expect(c('content-internal-link').status).toBe('good')
    expect(c('content-external-link').status).toBe('good')
  })

  test('same-host absolute link is internal (www and port ignored)', () => {
    const html = '<p><a href="https://www.example.com:443/faq">faq</a></p>'
    const c = run({ html, url: 'https://example.com/post' })
    expect(c('content-internal-link').status).toBe('good')
    expect(c('content-external-link').status).toBe('bad')
  })

  test('trailing-dot hosts normalize to the same host (finding 8)', () => {
    const c = run({ html: '<p><a href="https://example.com./faq">faq</a></p>', url: 'https://example.com/post' })
    expect(c('content-internal-link').status).toBe('good')
    const c2 = run({ html: '<p><a href="//example.com./faq">faq</a></p>', url: 'https://example.com./post' })
    expect(c2('content-internal-link').status).toBe('good')
  })

  test('absolute links without input.url are unclassifiable → na', () => {
    const c = run({ html: '<p><a href="https://somewhere.com/">x</a></p>' })
    expect(c('content-internal-link').status).toBe('na')
    expect(c('content-external-link').status).toBe('na')
  })

  test('relative link counts as internal even without input.url', () => {
    const c = run({ html: '<p><a href="/about">x</a></p>' })
    expect(c('content-internal-link').status).toBe('good')
    expect(c('content-external-link').status).toBe('bad')
  })

  test('mailto/tel/fragment links are ignored entirely', () => {
    const html = '<p><a href="mailto:a@b.c">m</a><a href="tel:+1">t</a><a href="#top">f</a></p>'
    const c = run({ html, url: 'https://example.com/' })
    expect(c('content-internal-link').status).toBe('bad')
    expect(c('content-external-link').status).toBe('bad')
  })

  test('subheading distribution: >300-word stretch bad, spread good, short text na', () => {
    const bad = run({ html: `<p>${lorem(350)}</p><h2>H</h2><p>${lorem(60)}</p>` })
    expect(bad('content-subheading-distribution').status).toBe('bad')
    const good = run({ html: `<p>${lorem(200)}</p><h2>H</h2><p>${lorem(150)}</p>` })
    expect(good('content-subheading-distribution').status).toBe('good')
    const short = run({ html: `<p>${lorem(250)}</p>` })
    expect(short('content-subheading-distribution').status).toBe('na')
    expect(run({ text: lorem(400) })('content-subheading-distribution').status).toBe('na')
  })
})

describe('readability checks', () => {
  const shortSentences = 'The sun is out and we are glad because the day is warm. '.repeat(20)

  test('short sentences are good; one enormous sentence is bad', () => {
    expect(run({ text: shortSentences })('readability-sentence-length').status).toBe('good')
    const monster = `${'the and is to of a in that it was '.repeat(4)}end.`
    expect(run({ text: monster })('readability-sentence-length').status).toBe('bad')
  })

  test('paragraph length: 150 good / 200 ok / more bad', () => {
    expect(run({ text: `${lorem(140)}\n\n${lorem(20)}` })('readability-paragraph-length').status).toBe('good')
    expect(run({ text: lorem(180) })('readability-paragraph-length').status).toBe('ok')
    expect(run({ text: lorem(240) })('readability-paragraph-length').status).toBe('bad')
  })

  test('passive voice: all-active good, all-passive bad', () => {
    expect(run({ text: shortSentences })('readability-passive-voice').status).toBe('good')
    const passive = 'The house was painted by them and the fence was broken by the wind. '.repeat(10)
    expect(run({ text: passive })('readability-passive-voice').status).toBe('bad')
  })

  test('transition words: rich good, absent bad', () => {
    expect(run({ text: shortSentences })('readability-transition-words').status).toBe('good') // "because"
    const flat = 'The cat sat on the mat. The dog sat on the rug. '.repeat(10)
    expect(run({ text: flat })('readability-transition-words').status).toBe('bad')
  })

  test('non-English text → passive and transition checks na, structural checks still run', () => {
    const polish =
      'Szybki brązowy lis przeskakuje nad leniwym psem oraz biegnie przez ciemny las każdego wieczoru bardzo szybko. '.repeat(6)
    const c = run({ text: polish })
    expect(c('readability-passive-voice').status).toBe('na')
    expect(c('readability-transition-words').status).toBe('na')
    expect(c('readability-sentence-length').status).not.toBe('na')
    expect(c('readability-paragraph-length').status).not.toBe('na')
  })

  test('empty content → sentence/paragraph/passive/transition all na', () => {
    const c = run({})
    expect(c('readability-sentence-length').status).toBe('na')
    expect(c('readability-paragraph-length').status).toBe('na')
    expect(c('readability-passive-voice').status).toBe('na')
    expect(c('readability-transition-words').status).toBe('na')
  })
})

// ---------------------------------------------------------------------------
// Round-5 triage fixes
// ---------------------------------------------------------------------------

describe('round-5 item 21: existence and length measure the SAME value', () => {
  test('leading/trailing whitespace no longer inflates the title length', () => {
    // 11 visible characters padded to 31: used to score the 30–60 sweet spot.
    const padded = `${' '.repeat(20)}Hello World`
    const c = run({ title: padded, text: 'x' })
    expect(c('title-exists').status).toBe('good')
    expect(c('title-length').status).toBe('ok')
    expect(c('title-length').detail).toContain('11')
  })

  test('internal whitespace runs are collapsed before measuring', () => {
    const c = run({ title: `Hello${' '.repeat(40)}World`, text: 'x' })
    expect(c('title-length').detail).toContain('11')
  })

  test('a zero-width-only title does not exist', () => {
    const c = run({ title: '​​﻿', text: 'x' })
    expect(c('title-exists').status).toBe('bad')
    expect(c('title-length').status).toBe('na')
  })

  test('zero-width padding does not inflate the description length', () => {
    const desc = 'x'.repeat(50) + '​'.repeat(100)
    const c = run({ metaDescription: desc, text: 'x' })
    expect(c('description-length').status).toBe('bad') // 50 visible, not 150
    expect(c('description-length').detail).toContain('50')
  })

  test('ordinary values are measured exactly as before', () => {
    expect(run({ title: 'x'.repeat(45), text: 'x' })('title-length').status).toBe('good')
    expect(run({ metaDescription: 'x'.repeat(140), text: 'x' })('description-length').status).toBe('good')
  })
})

describe('round-5 item 22: CJK segmentation', () => {
  // ~720 Han characters with no spaces: ONE token to a [\p{L}\p{N}]+ scanner.
  const cjkRun = '内容营销策略指南每日更新'.repeat(60)

  test('an unspaced CJK run is not one word', () => {
    const c = run({ text: cjkRun })
    expect(c('content-word-count').status).toBe('good')
    expect(c('content-word-count').detail).not.toContain('1 words')
  })

  test('a short CJK text is still reported as thin', () => {
    const c = run({ text: '内容营销' })
    expect(c('content-word-count').status).toBe('bad')
  })

  test('。 terminates a sentence, so length is measured per sentence', () => {
    // One 400-character "sentence" to lang.ts; 34 real sentences here.
    const prose = '内容营销策略指南每日更新。'.repeat(34)
    const c = run({ text: prose })
    expect(c('readability-sentence-length').status).toBe('good')
    // Without the split this is a single ~200-word sentence → 'bad'.
    const unsplit = run({ text: '内容营销策略指南每日更新'.repeat(34) })
    expect(unsplit('readability-sentence-length').status).toBe('bad')
  })

  test('English measurement is untouched', () => {
    expect(run({ text: lorem(400) })('content-word-count').detail).toContain('400 words')
    expect(run({ text: lorem(200) })('content-word-count').status).toBe('ok')
    expect(run({ text: lorem(100) })('content-word-count').status).toBe('bad')
  })
})

describe('round-5 item 23: backslash terminates the URL authority', () => {
  test('`\\` in the authority is not part of the host (browsers treat it as /)', () => {
    const html = '<p><a href="https://evil.example\\@owner.example/x">x</a></p>'
    const c = run({ html, url: 'https://owner.example/post' })
    expect(c('content-external-link').status).toBe('good')
    expect(c('content-internal-link').status).toBe('bad')
  })

  test('a genuine same-host link still counts as internal', () => {
    const c = run({ html: '<p><a href="https://owner.example/x">x</a></p>', url: 'https://owner.example/post' })
    expect(c('content-internal-link').status).toBe('good')
  })
})

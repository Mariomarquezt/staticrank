import { describe, expect, test } from 'bun:test'
import { decodeEntities, extractTextFromHtml, parseHtml } from '../extract'

describe('extractTextFromHtml', () => {
  test('strips simple tags and joins blocks with newlines', () => {
    expect(extractTextFromHtml('<p>Hello</p><p>World</p>')).toBe('Hello\nWorld')
  })

  test('empty input → empty output', () => {
    expect(extractTextFromHtml('')).toBe('')
    expect(extractTextFromHtml('   \n  ')).toBe('')
  })

  test('inline tags insert no boundary (word split by <b> survives)', () => {
    expect(extractTextFromHtml('<p>key<b>word</b></p>')).toBe('keyword')
    expect(extractTextFromHtml('<p>best <b>coffee</b> beans</p>')).toBe('best coffee beans')
  })

  test('<br> is a word boundary within a block', () => {
    expect(extractTextFromHtml('<p>hello<br>world</p>')).toBe('hello\nworld')
    expect(extractTextFromHtml('line one<br/>line two')).toBe('line one\nline two')
  })

  test('block tags separate words even without whitespace', () => {
    expect(extractTextFromHtml('<ul><li>one</li><li>two</li></ul>')).toBe('one\ntwo')
    expect(extractTextFromHtml('<table><tr><td>a</td><td>b</td></tr></table>')).toBe('a\nb')
  })

  test('script bodies are masked, including markup inside them', () => {
    // A script renders NOTHING, so it is not a block boundary: the text on
    // either side belongs to the same rendered block (round-5 item 26 — this
    // used to flush and yield 'a\nb').
    const html = '<div>a<script>if(1<2){document.write("<b>never</b>")}</script>b</div>'
    expect(extractTextFromHtml(html)).toBe('ab')
  })

  test('a masked element that renders nothing does not split a word (round-5 item 26)', () => {
    expect(extractTextFromHtml('<p>key<script></script>word</p>')).toBe('keyword')
    expect(extractTextFromHtml('<p>key<style>.a{}</style>word</p>')).toBe('keyword')
    // …but masked elements that OCCUPY LAYOUT stay word boundaries.
    expect(extractTextFromHtml('<p>a<svg><text>q</text></svg>b</p>')).toBe('a b')
    expect(extractTextFromHtml('<p>a<iframe src="x"></iframe>b</p>')).toBe('a b')
  })

  test('style and noscript are masked; unterminated script swallows to EOF', () => {
    expect(extractTextFromHtml('<p>x</p><style>.a{color:red}</style><noscript>no</noscript><p>y</p>')).toBe('x\ny')
    expect(extractTextFromHtml('<p>x</p><script>var a=1;')).toBe('x')
  })

  test('comments are removed without becoming a word boundary', () => {
    expect(extractTextFromHtml('a<!-- <p>hidden</p> -->b')).toBe('ab')
    expect(extractTextFromHtml('a<!-- never closed')).toBe('a')
  })

  test('doctype and processing instructions are skipped', () => {
    expect(extractTextFromHtml('<!doctype html><p>hi</p>')).toBe('hi')
  })

  test('decodes basic entities', () => {
    expect(extractTextFromHtml('<p>Fish &amp; Chips &#8212; it&#x2019;s &quot;fine&quot;</p>')).toBe(
      'Fish & Chips — it’s "fine"',
    )
  })

  test('unknown entities and bare ampersands stay verbatim', () => {
    expect(extractTextFromHtml('<p>&foo; AT&T a & b</p>')).toBe('&foo; AT&T a & b')
  })

  test('quote-aware attributes: > inside quoted alt does not end the tag', () => {
    expect(extractTextFromHtml('<p>x</p><img alt="a > b" src="i.png"><p>y</p>')).toBe('x\ny')
  })

  test('collapses whitespace runs inside a block', () => {
    expect(extractTextFromHtml('<p>a \n\t  b</p>')).toBe('a b')
  })

  test('stray < is kept as text', () => {
    expect(extractTextFromHtml('<p>1 < 2 and 3 > 2</p>')).toBe('1 < 2 and 3 > 2')
  })

  test('</scriptx> does not close a script region (finding 4)', () => {
    expect(extractTextFromHtml('<script>a</scriptx>b</script>c')).toBe('c')
    expect(extractTextFromHtml('<style>.a{}</styled>x</style>y')).toBe('y')
    expect(extractTextFromHtml('<script>a</script >b')).toBe('b')
  })

  test('nested <template> is masked to the MATCHING close (finding 5)', () => {
    expect(extractTextFromHtml('<template>a<template>b</template>c</template>d')).toBe('d')
    expect(extractTextFromHtml('<svg><text>x</text><svg></svg><text>y</text></svg>z')).toBe('z')
  })

  test('selfClosing is honoured only for foreign content (round-5 item 25)', () => {
    // svg is foreign content: `<svg/>` really is an empty element.
    expect(extractTextFromHtml('<svg/>hello')).toBe('hello')
    // HTML raw-text/RCDATA elements are NOT self-closing — the parser ignores
    // the slash, so the body still belongs to the element (same rule as
    // imageAudit.ts). `<script/>hidden</script>` must hide `hidden`.
    expect(extractTextFromHtml('<script/>hidden</script>shown')).toBe('shown')
    expect(extractTextFromHtml('<template/>hidden</template>shown')).toBe('shown')
    expect(extractTextFromHtml('<textarea/>hidden</textarea>shown')).toBe('shown')
  })

  test('comments inside a <template> are comments, not tags (round-5 item 24)', () => {
    expect(extractTextFromHtml('<template><!-- <template> --></template><p>visible</p>')).toBe(
      'visible',
    )
    // …and the close tag inside a comment does not end the region early.
    expect(extractTextFromHtml('<template>a<!-- </template> -->b</template><p>visible</p>')).toBe(
      'visible',
    )
    // Real nesting is still depth-tracked.
    expect(extractTextFromHtml('<svg><!-- <svg> --><text>x</text></svg>after')).toBe('after')
  })

  test('abrupt comments `<!-->` / `<!--->` end immediately (round-5 item 14)', () => {
    expect(extractTextFromHtml('<!--><p>visible</p>')).toBe('visible')
    expect(extractTextFromHtml('<!---><p>visible</p>')).toBe('visible')
    // A normal empty comment still behaves.
    expect(extractTextFromHtml('<!----><p>visible</p>')).toBe('visible')
    // A genuinely unterminated comment still masks to EOF.
    expect(extractTextFromHtml('a<!-- never closed <p>x</p>')).toBe('a')
  })

  test('a tag name must start with a LETTER (round-5 item 27)', () => {
    expect(extractTextFromHtml('<p>I <3 SEO and math</p>')).toBe('I <3 SEO and math')
    expect(extractTextFromHtml('<p>2 <1 is false</p>')).toBe('2 <1 is false')
    // Real tags are unaffected, including namespaced and digit-suffixed names.
    expect(extractTextFromHtml('<h2>Head</h2><svg:rect></svg:rect><p>Body</p>')).toBe('Head\nBody')
  })

  test('entity lookup reads OWN properties only (round-5 item 28)', () => {
    expect(decodeEntities('&toString;')).toBe('&toString;')
    expect(decodeEntities('&__proto__;')).toBe('&__proto__;')
    expect(decodeEntities('&constructor;')).toBe('&constructor;')
    expect(extractTextFromHtml('<p>a &toString; b</p>')).toBe('a &toString; b')
    // Real named entities still decode.
    expect(decodeEntities('&amp;&nbsp;&copy;')).toBe('& ©')
  })

  test('an unclosed heading does not swallow later paragraphs (round-5 item 29)', () => {
    const doc = parseHtml('<h2>Title<p>First para</p><p>Second para</p>')
    expect(doc.headings).toEqual([{ level: 2, text: 'Title' }])
    expect(doc.paragraphs).toEqual(['First para', 'Second para'])
    // Well-formed headings are unchanged.
    const ok = parseHtml('<h2>Title</h2><p>Body</p>')
    expect(ok.headings).toEqual([{ level: 2, text: 'Title' }])
    expect(ok.paragraphs).toEqual(['Body'])
  })

  test('CDATA is one opaque masked region through ]]> (finding 6)', () => {
    expect(extractTextFromHtml('a<![CDATA[ <p>hidden</p> > still hidden ]]>b')).toBe('ab')
    expect(extractTextFromHtml('a<![CDATA[ never closed')).toBe('a')
  })

  test('<img> and other replaced elements are word boundaries (finding 9)', () => {
    expect(extractTextFromHtml('<p>a<img src="x">b</p>')).toBe('a b')
    expect(extractTextFromHtml('<p>a<input>b<embed>c</p>')).toBe('a b c')
  })
})

describe('decodeEntities', () => {
  test('NUL, surrogate-range and out-of-range references decode to U+FFFD (finding 10)', () => {
    expect(decodeEntities('&#0;')).toBe('�')
    expect(decodeEntities('&#xD800; &#x110000;')).toBe('� �')
  })

  test('adversarial ampersand run decodes in linear time (finding 2)', () => {
    const input = '&'.repeat(200_000) + ';'
    const t0 = Date.now()
    const out = decodeEntities(input)
    const elapsed = Date.now() - t0
    expect(out).toBe(input) // nothing decodable, everything preserved
    expect(elapsed).toBeLessThan(1000)
  })

  test('astral code points decode via fromCodePoint', () => {
    expect(decodeEntities('&#x1F600;')).toBe('😀')
  })
})

describe('parseHtml options (additive — review 3.6 #4)', () => {
  const html =
    '<h1>Title</h1><p>Text with <a href="/a">one</a> and <a href="/b">two</a> links.</p>' +
    '<img src="x.png"><h2>Sub</h2><p>More.</p>'

  test('collectLinks: false skips only the link list — everything else identical', () => {
    const full = parseHtml(html)
    const noLinks = parseHtml(html, { collectLinks: false })
    expect(noLinks.links).toEqual([])
    expect(full.links.length).toBe(2)
    expect({ ...noLinks, links: full.links }).toEqual(full)
  })

  test('default and explicit collectLinks: true are byte-identical (parity)', () => {
    expect(parseHtml(html, { collectLinks: true })).toEqual(parseHtml(html))
    expect(parseHtml(html, {})).toEqual(parseHtml(html))
  })
})

describe('parseHtml structure', () => {
  const html = [
    '<h1>Main <em>Title</em></h1>',
    '<p>First paragraph with <a href="/about">a link</a>.</p>',
    '<h2>Sub&amp;head</h2>',
    '<p>Second paragraph.</p>',
    '<img src="a.png" alt="Coffee cup">',
    '<img src="b.png" alt="">',
    '<img src="c.png">',
    '<h5>Minor</h5>',
    '<p>Third.</p>',
    '<a href="https://other.example/x">out</a>',
  ].join('\n')

  const doc = parseHtml(html)

  test('headings with levels and inline-tag flattening', () => {
    expect(doc.headings).toEqual([
      { level: 1, text: 'Main Title' },
      { level: 2, text: 'Sub&head' },
      { level: 5, text: 'Minor' },
    ])
  })

  test('paragraphs exclude headings', () => {
    expect(doc.paragraphs).toEqual([
      'First paragraph with a link.',
      'Second paragraph.',
      'Third.',
      'out',
    ])
  })

  test('image alts: value, empty string, and null for missing', () => {
    expect(doc.imageAlts).toEqual(['Coffee cup', '', null])
  })

  test('links collect hrefs', () => {
    expect(doc.links.map((l) => l.href)).toEqual(['/about', 'https://other.example/x'])
  })

  test('segments split at h2–h4 but not h1/h5', () => {
    expect(doc.segmentTexts.length).toBe(2)
    expect(doc.segmentTexts[0]).toContain('First paragraph')
    expect(doc.segmentTexts[1]).toContain('Second paragraph')
    expect(doc.segmentTexts[1]).toContain('Third.')
  })

  test('unclosed heading at EOF is still captured', () => {
    const d = parseHtml('<h2>Dangling')
    expect(d.headings).toEqual([{ level: 2, text: 'Dangling' }])
  })

  test('h2Count counts elements including empty ones; headings only text (nit 12)', () => {
    const d = parseHtml('<h2></h2><h2>Real</h2><p>x</p>')
    expect(d.h2Count).toBe(2)
    expect(d.headings).toEqual([{ level: 2, text: 'Real' }])
  })

  test('href entities are decoded and empty hrefs skipped', () => {
    const d = parseHtml('<a href="/a?x=1&amp;y=2">l</a><a href="">e</a><a>none</a>')
    expect(d.links.map((l) => l.href)).toEqual(['/a?x=1&y=2'])
  })
})

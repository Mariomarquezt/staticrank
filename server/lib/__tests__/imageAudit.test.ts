import { describe, expect, test } from 'bun:test'
import {
  auditImages,
  IMAGE_FINDING_SRC_MAX,
  IMAGE_FINDINGS_MAX,
  IMAGE_RECORDS_MAX,
  IMAGE_STACK_MAX,
} from '../imageAudit'

function codes(html: string): string[] {
  return auditImages(html).findings.map((finding) => finding.code)
}

describe('auditImages', () => {
  test('reports missing alt and accepts a meaningful alt', () => {
    expect(codes('<img src="hero.jpg" width="10" height="10">')).toContain('missing-alt')
    expect(codes('<img src="hero.jpg" alt="A mountain at sunrise" width="10" height="10">')).not.toContain('missing-alt')
  })

  test('reports empty alt except for decorative images', () => {
    expect(codes('<img src="divider.svg" alt="" width="10" height="10">')).toContain('empty-alt')
    expect(codes('<img src="divider.svg" alt="" role="presentation" width="10" height="10">')).not.toContain('empty-alt')
    expect(codes('<img src="divider.svg" alt="" aria-hidden="true" width="10" height="10">')).not.toContain('empty-alt')
  })

  test('detects generic and filename-ish alt text', () => {
    expect(codes('<img alt="Photo" width="1" height="1">')).toContain('generic-alt')
    expect(codes('<img alt="screenshot-42" width="1" height="1">')).toContain('generic-alt')
    expect(codes('<img alt="Photo of the product" width="1" height="1">')).not.toContain('generic-alt')
  })

  test('checks dimensions, with a picture source sibling exemption', () => {
    expect(codes('<img alt="hero" width="640">')).toContain('missing-dimensions')
    expect(codes('<img alt="hero" height="480">')).toContain('missing-dimensions')
    expect(codes('<img alt="hero" width="640" height="480">')).not.toContain('missing-dimensions')
    expect(codes('<picture><source srcset="hero.webp"><img alt="hero"></picture>')).not.toContain('missing-dimensions')
    expect(codes('<picture><img alt="hero"><source srcset="hero.webp"></picture>')).not.toContain('missing-dimensions')
  })

  test('detects oversized data URIs and accepts a URI at the limit', () => {
    const tooLarge = `data:image/png;base64,${'a'.repeat(65514)}`
    const atLimit = `data:image/png;base64,${'a'.repeat(65513)}`
    expect(tooLarge.length).toBeGreaterThan(65535)
    expect(atLimit.length).toBeLessThanOrEqual(65535)
    expect(codes(`<img src="${tooLarge}" alt="hero" width="1" height="1">`)).toContain('huge-inline-image')
    expect(codes(`<img src="${atLimit}" alt="hero" width="1" height="1">`)).not.toContain('huge-inline-image')
  })

  test('counts alt length in Unicode code points', () => {
    const emojis125 = '😀'.repeat(125)
    const emojis126 = '😀'.repeat(126)
    expect(codes(`<img alt="${emojis125}" width="1" height="1">`)).not.toContain('alt-too-long')
    expect(codes(`<img alt="${emojis126}" width="1" height="1">`)).toContain('alt-too-long')
  })

  test('parses quoted greater-than signs and unquoted attributes', () => {
    const quoted = auditImages(`<img height="10" alt="A > B" src="hero.jpg" width="20">`)
    expect(quoted.totalImages).toBe(1)
    expect(quoted.findings).toEqual([])
    const unquoted = auditImages('<img src=hero.jpg alt=Hero width=20 height=10>')
    expect(unquoted.totalImages).toBe(1)
    expect(unquoted.findings).toEqual([])
  })

  test('an apostrophe in an unquoted value does not swallow later markup', () => {
    const result = auditImages(
      `<img src=hero's.jpg alt=Hero width=20 height=10><img src=next.jpg alt=Next width=20 height=10>`,
    )
    expect(result.totalImages).toBe(2)
    expect(result.findings).toEqual([])
  })

  test('ignores images in comments and skipped elements', () => {
    const html = `<!-- <img src="comment.jpg"> --><script><img src="script.jpg"></script><style><img src="style.jpg"></style><noscript><img src="noscript.jpg"></noscript><template><img src="template.jpg"></template><img src="real.jpg" alt="real" width="1" height="1">`
    const result = auditImages(html)
    expect(result.totalImages).toBe(1)
    expect(result.findings).toEqual([])
  })

  test('raw elements are not self-closing and RCDATA text is skipped', () => {
    const html =
      '<script src=x.js /><img src="inside-script.jpg"></script>' +
      '<textarea><img src="inside-textarea.jpg"></textarea>' +
      '<title><img src="inside-title.jpg"></title>' +
      '<img src="real.jpg" alt="real" width="1" height="1">'
    const result = auditImages(html)
    expect(result.totalImages).toBe(1)
    expect(result.findings).toEqual([])
  })

  test('assigns indexes among all scanned images', () => {
    const result = auditImages('<img src="a.jpg"><img src="b.jpg" alt="ok" width="1" height="1"><img src="c.jpg" alt="" width="1" height="1">')
    expect(result.totalImages).toBe(3)
    expect(result.findings.map((finding) => [finding.code, finding.index])).toEqual([
      ['missing-alt', 0],
      ['missing-dimensions', 0],
      ['empty-alt', 2],
    ])
  })

  test('whitespace-only alt is reported as empty-alt (unless decorative)', () => {
    const result = auditImages('<img src="a.jpg" alt="   " width="1" height="1">')
    expect(result.findings.map((f) => f.code)).toContain('empty-alt')
    const decorative = auditImages('<img src="a.jpg" alt="   " role="presentation" width="1" height="1">')
    expect(decorative.findings.map((f) => f.code)).not.toContain('empty-alt')
  })

  test('caps finding count and truncates huge inline-image sources', () => {
    const huge = `data:image/png;base64,${'a'.repeat(70_000)}`
    const hugeResult = auditImages(`<img src="${huge}" alt="hero" width="1" height="1">`)
    const hugeFinding = hugeResult.findings.find((finding) => finding.code === 'huge-inline-image')
    expect(hugeFinding?.src.length).toBeLessThanOrEqual(IMAGE_FINDING_SRC_MAX)
    expect(hugeFinding?.src.endsWith('…')).toBe(true)

    const many = auditImages(Array.from({ length: 60 }, () => '<img src=x>').join(''))
    expect(many.findings.length).toBe(IMAGE_FINDINGS_MAX)
  })

  test('keeps the missing-alt total independent of the capped findings list', () => {
    const html = `${'<img src="decorative.jpg" alt="photo">'.repeat(100)}<img src="hero.jpg">`
    const result = auditImages(html)
    expect(result.findings.length).toBe(IMAGE_FINDINGS_MAX)
    expect(result.missingAlt).toBe(1)
  })

  test('does not throw on malformed HTML and handles a large document quickly', () => {
    expect(() => auditImages('<img alt="unterminated > <img src=x')).not.toThrow()
    const html = `${'<div>content</div>'.repeat(11000)}<img src="ok.jpg" alt="ok" width="1" height="1">`
    const start = performance.now()
    const result = auditImages(html)
    const elapsed = performance.now() - start
    expect(result.totalImages).toBe(1)
    expect(elapsed).toBeLessThan(1000)
  })

  // -------------------------------------------------------------------------
  // Round-5 triage fixes (docs/TRIAGE-round5/G-publish-schema-audit.md)
  // -------------------------------------------------------------------------

  test('t3-27 #4: spec-valid abrupt comments terminate instead of masking the rest', () => {
    // `<!-->` and `<!--->` are COMPLETE empty comments; scanning them for a
    // `-->` that is not there used to hide every later image (false pass).
    expect(auditImages('<!--><img src="x.jpg">').totalImages).toBe(1)
    expect(auditImages('<!---><img src="x.jpg">').totalImages).toBe(1)
    // A genuinely unterminated comment still masks to the end of the input.
    expect(auditImages('<!-- <img src="x.jpg">').totalImages).toBe(0)
    // …and an ordinary comment still ends at its own `-->`.
    expect(auditImages('<!-- c --><img src="x.jpg">').totalImages).toBe(1)
  })

  test('t3-27 #5: attribute values are entity-decoded before the semantic checks', () => {
    // `&#32;` is a space: no accessible name, so this is an empty alt.
    expect(codes('<img src="a.jpg" alt="&#32;" width="1" height="1">')).toContain('empty-alt')
    expect(codes('<img src="a.jpg" alt="&nbsp;" width="1" height="1">')).toContain('empty-alt')
    // An entity-obfuscated data: prefix is still an inline image.
    const huge = `&#100;ata:image/png;base64,${'a'.repeat(70_000)}`
    expect(codes(`<img src="${huge}" alt="hero" width="1" height="1">`)).toContain(
      'huge-inline-image',
    )
    // Decoding must not invent findings on ordinary values.
    expect(codes('<img src="a.jpg?x=1&amp;y=2" alt="A mountain" width="1" height="1">')).toEqual([])
  })

  test('t3-27 #6: width/height must parse as positive integers', () => {
    expect(codes('<img alt="hero" width="banana" height="480">')).toContain('missing-dimensions')
    expect(codes('<img alt="hero" width="640" height="">')).toContain('missing-dimensions')
    expect(codes('<img alt="hero" width="0" height="480">')).toContain('missing-dimensions')
    expect(codes('<img alt="hero" width="50%" height="480">')).toContain('missing-dimensions')
    expect(codes('<img alt="hero" width=" 640 " height="480">')).not.toContain('missing-dimensions')
  })

  test('t3-27 grok #9: role="none" is decorative, like role="presentation"', () => {
    expect(codes('<img src="d.svg" alt="" role="none" width="1" height="1">')).not.toContain(
      'empty-alt',
    )
    expect(codes('<img src="d.svg" alt="" role="NONE" width="1" height="1">')).not.toContain(
      'empty-alt',
    )
    // Any other role still leaves the empty alt to be confirmed.
    expect(codes('<img src="d.svg" alt="" role="img" width="1" height="1">')).toContain('empty-alt')
  })

  test('t3-27 #3: counters stay exact past the retained-record cap', () => {
    const extra = 5
    const html = '<img src="x.jpg">'.repeat(IMAGE_RECORDS_MAX + extra)
    const result = auditImages(html)
    expect(result.totalImages).toBe(IMAGE_RECORDS_MAX + extra)
    expect(result.missingAlt).toBe(IMAGE_RECORDS_MAX + extra)
    expect(result.findings.length).toBe(IMAGE_FINDINGS_MAX)
  })

  test('t3-27 #3: deep nesting plus unmatched closes stays linear', () => {
    // Every unmatched `</span>` rescans the open-element stack. Uncapped that
    // is n². Measured at this depth: ~4.5 s uncapped vs ~80 ms capped at
    // IMAGE_STACK_MAX, where the rescan is n × 512 — a ~50× margin either
    // side of the budget below.
    const depth = 50_000
    expect(depth).toBeGreaterThan(IMAGE_STACK_MAX * 50)
    const html =
      '<div>'.repeat(depth) +
      '</span>'.repeat(depth) +
      '<img src="ok.jpg" alt="ok" width="1" height="1">'
    const start = performance.now()
    const result = auditImages(html)
    const elapsed = performance.now() - start
    expect(result.totalImages).toBe(1)
    expect(result.findings).toEqual([])
    expect(elapsed).toBeLessThan(1000)
  })

  test('t3-27 #3: the picture exemption survives the stack cap', () => {
    const html =
      '<div>'.repeat(IMAGE_STACK_MAX + 10) +
      '<picture><source srcset="hero.webp"><img alt="hero"></picture>'
    expect(codes(html)).not.toContain('missing-dimensions')
  })
})

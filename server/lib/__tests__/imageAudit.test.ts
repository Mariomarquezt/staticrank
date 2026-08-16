import { describe, expect, test } from 'bun:test'
import { auditImages } from '../imageAudit'

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

  test('ignores images in comments and skipped elements', () => {
    const html = `<!-- <img src="comment.jpg"> --><script><img src="script.jpg"></script><style><img src="style.jpg"></style><noscript><img src="noscript.jpg"></noscript><template><img src="template.jpg"></template><img src="real.jpg" alt="real" width="1" height="1">`
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

  test('does not throw on malformed HTML and handles a large document quickly', () => {
    expect(() => auditImages('<img alt="unterminated > <img src=x')).not.toThrow()
    const html = `${'<div>content</div>'.repeat(11000)}<img src="ok.jpg" alt="ok" width="1" height="1">`
    const start = performance.now()
    const result = auditImages(html)
    const elapsed = performance.now() - start
    expect(result.totalImages).toBe(1)
    expect(elapsed).toBeLessThan(1000)
  })
})

/**
 * extract — dependency-free HTML → structured plain text for content analysis.
 *
 * Runs inside Instatic's QuickJS-WASM plugin sandbox: ES2020, no DOM, no Node
 * APIs, no dependencies. Single forward scan over the markup (same discipline
 * as headSurgeon.ts): comments, `<script>`, `<style>` and `<noscript>` bodies
 * are masked out entirely; every tag is parsed with a quote-aware attribute
 * scanner so `alt="a > b"` never terminates a tag early.
 *
 * Word-boundary rules:
 * - Block-level tags (p, div, li, td, headings, …) are HARD boundaries: they
 *   flush the current paragraph and separate text blocks with `\n`.
 * - `<br>` is a SOFT boundary: it inserts a line break inside the current
 *   block (word boundary preserved, paragraph not split).
 * - Inline tags (b, i, em, span, a, …) insert NOTHING, so a phrase written as
 *   `best <b>coffee</b> beans` extracts as `best coffee beans` and
 *   `key<b>word</b>` stays the single word `keyword`.
 *
 * Entity decoding is intentionally basic: the named entities that matter for
 * word matching (&amp; &lt; &gt; &quot; &apos; &nbsp; and common punctuation)
 * plus decimal/hex numeric references. Unknown entities are left verbatim.
 */

export interface ParsedHeading {
  /** 1–6 */
  level: number
  text: string
}

export interface ParsedLink {
  href: string
}

export interface ParsedDoc {
  /** Full plain text; blocks separated by `\n`. */
  text: string
  /** Non-empty non-heading text blocks, in document order. */
  paragraphs: string[]
  headings: ParsedHeading[]
  /** One entry per `<img>`; `null` when the alt attribute is absent. */
  imageAlts: (string | null)[]
  links: ParsedLink[]
  /**
   * Text runs delimited by h2–h4 subheadings (heading text excluded).
   * Always at least one entry; used by the subheading-distribution check.
   */
  segmentTexts: string[]
  /**
   * Number of `<h2>` ELEMENTS opened, including empty ones. `headings` only
   * lists headings with text, so an empty `<h2></h2>` counts here but not
   * there — structural presence vs. keyword-matchable text.
   */
  h2Count: number
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  shy: '',
}

/** Decode basic named + numeric character references. Unknown → verbatim. */
export function decodeEntities(input: string): string {
  if (input.indexOf('&') === -1) return input
  let out = ''
  let i = 0
  while (i < input.length) {
    const amp = input.indexOf('&', i)
    if (amp === -1) {
      out += input.slice(i)
      break
    }
    out += input.slice(i, amp)
    // Entity bodies are short (≤10 chars for everything we decode); scan a
    // BOUNDED window char-by-char so adversarial inputs like '&&&&…;' stay
    // linear instead of each '&' searching the rest of the document.
    let semi = -1
    const windowEnd = Math.min(input.length, amp + 12)
    for (let k = amp + 1; k < windowEnd; k += 1) {
      const ch = input[k]
      if (ch === ';') {
        semi = k
        break
      }
      if (ch === '&') break // a fresh '&' restarts the scan there
    }
    if (semi === -1) {
      out += '&'
      i = amp + 1
      continue
    }
    const body = input.slice(amp + 1, semi)
    let decoded: string | undefined
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const numText = hex ? body.slice(2) : body.slice(1)
      if (numText.length > 0 && (hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(numText)) {
        const code = parseInt(numText, hex ? 16 : 10)
        // Per the HTML spec, NUL, surrogates and out-of-range code points
        // decode to U+FFFD REPLACEMENT CHARACTER, never verbatim.
        if (code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
          decoded = '�'
        } else {
          decoded = String.fromCodePoint(code)
        }
      }
    } else if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) {
      // OWN properties only: a plain object literal also answers to
      // `&toString;` / `&__proto__;` with inherited values, which would
      // splice native-function source (or `[object Object]`) into the text.
      decoded = NAMED_ENTITIES[body]
    }
    if (decoded === undefined) {
      out += '&'
      i = amp + 1
    } else {
      out += decoded
      i = semi + 1
    }
  }
  return out
}

/** Tags whose open OR close ends the current text block/paragraph. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'dialog',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav',
  'ol', 'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul',
])

/** Elements whose entire body is masked (never text). Exported (additive)
 * so capture-side scanners can share the exact masking set. */
export const MASKED_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'textarea'])

/**
 * Masked elements that OCCUPY LAYOUT: they render something (a graphic, a
 * frame, a widget), so they are a word boundary — `a<svg…></svg>b` is two
 * words. The rest (script/style/noscript/template) render NOTHING, so
 * `key<script></script>word` is the single word `keyword`, exactly as a
 * browser lays it out. Neither kind is a paragraph break.
 */
const MASKED_REPLACED = new Set(['svg', 'iframe', 'textarea'])

/**
 * Masked elements that MAY legally self-close, i.e. where `<name/>` really is
 * an empty element and must not swallow the following text. Only foreign
 * content (svg) qualifies: for HTML raw-text/RCDATA elements the parser
 * ignores the slash, so `<script/>hidden</script>` still hides `hidden`
 * (imageAudit.ts:283-284 states the same rule).
 */
const SELF_CLOSABLE_MASKED = new Set(['svg'])

interface TagToken {
  name: string
  closing: boolean
  /** `<tag …/>` — relevant for masked elements only. */
  selfClosing: boolean
  attrs: Record<string, string>
  /** index just past the closing `>` */
  end: number
}

/**
 * Parse one tag starting at `html[start] === '<'`. Quote-aware: `>` inside a
 * quoted attribute value does not end the tag. Returns null when the `<` does
 * not open a real tag (treated as text by the caller).
 */
function parseTag(html: string, start: number): TagToken | null {
  let i = start + 1
  let closing = false
  if (html[i] === '/') {
    closing = true
    i += 1
  }
  const nameStart = i
  // HTML tokenization requires a LETTER to open a tag name: `<3` in "I <3 SEO"
  // is literal text to a browser, not a tag whose unterminated body would eat
  // the rest of the phrase.
  if (i >= html.length || !/[a-zA-Z]/.test(html[i])) return null
  while (i < html.length && /[a-zA-Z0-9:-]/.test(html[i])) i += 1
  if (i === nameStart) return null
  const name = html.slice(nameStart, i).toLowerCase()
  const attrs: Record<string, string> = {}
  let selfClosing = false
  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i])) i += 1
    const ch = html[i]
    if (ch === undefined) break
    if (ch === '>') {
      return { name, closing, selfClosing, attrs, end: i + 1 }
    }
    if (ch === '/') {
      if (html[i + 1] === '>') selfClosing = true
      i += 1
      continue
    }
    // attribute name
    const attrStart = i
    while (i < html.length && !/[\s=/>]/.test(html[i])) i += 1
    if (i === attrStart) {
      i += 1
      continue
    }
    const attrName = html.slice(attrStart, i).toLowerCase()
    while (i < html.length && /\s/.test(html[i])) i += 1
    if (html[i] !== '=') {
      if (!(attrName in attrs)) attrs[attrName] = ''
      continue
    }
    i += 1
    while (i < html.length && /\s/.test(html[i])) i += 1
    let value = ''
    const q = html[i]
    if (q === '"' || q === "'") {
      const close = html.indexOf(q, i + 1)
      if (close === -1) {
        value = html.slice(i + 1)
        i = html.length
      } else {
        value = html.slice(i + 1, close)
        i = close + 1
      }
    } else {
      const valStart = i
      while (i < html.length && !/[\s>]/.test(html[i])) i += 1
      value = html.slice(valStart, i)
    }
    if (!(attrName in attrs)) attrs[attrName] = decodeEntities(value)
  }
  // Ran off the end of the document inside a tag.
  return { name, closing, selfClosing, attrs, end: html.length }
}

/**
 * Masked elements that may legally nest inside themselves and therefore need
 * depth tracking (`<template>` and `<svg>`). The others (script/style/…)
 * cannot contain themselves, so their first close tag ends the region.
 * Known limitation (documented): a self-closing `<template/>` INSIDE a masked
 * region is counted as an open, and a close tag hidden inside a quoted
 * attribute is honoured — both are invalid-HTML corner cases we accept.
 */
const NESTABLE_MASKED = new Set(['template', 'svg'])

function isTagNameBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === '>' || ch === '/' || /\s/.test(ch)
}

/**
 * Find `token` (e.g. `</script`) in `lower` starting at `from`, requiring the
 * next character to be a legal tag-name boundary so `</scriptx>` never
 * terminates a `<script>` region.
 */
function findTagToken(lower: string, token: string, from: number): number {
  let i = from
  for (;;) {
    const at = lower.indexOf(token, i)
    if (at === -1) return -1
    if (isTagNameBoundary(lower[at + token.length])) return at
    i = at + 1
  }
}

/**
 * Index just past the end of the comment starting at `lt` (`<!--`), or
 * `html.length` when it is never closed. The HTML tokenizer treats the ABRUPT
 * forms `<!-->` and `<!--->` as COMPLETE (empty) comments, so `<!--><img …>`
 * must not mask the rest of the document. Exported (additive) so capture-side
 * scanners can share the rule.
 */
export function findCommentEnd(html: string, lt: number): number {
  if (html.charCodeAt(lt + 4) === 62 /* > */) return lt + 5 // <!-->
  if (html.startsWith('->', lt + 4)) return lt + 6 // <!--->
  const close = html.indexOf('-->', lt + 4)
  return close === -1 ? html.length : close + 3
}

/**
 * Depth-tracked end of a NESTABLE masked region (`<template>`, `<svg>`), whose
 * content is ordinary parsed markup — so comments inside it are real comments
 * and the tokens they contain are NOT tags. Without that,
 * `<template><!-- <template> --></template><p>visible</p>` masks the visible
 * paragraph to EOF.
 */
function findNestableMaskedEnd(html: string, lower: string, name: string, from: number): number {
  let depth = 1
  let i = from
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) return html.length
    if (html.startsWith('<!--', lt)) {
      i = findCommentEnd(html, lt)
      continue
    }
    if (lower.startsWith('</' + name, lt) && isTagNameBoundary(lower[lt + name.length + 2])) {
      depth -= 1
      const gt = html.indexOf('>', lt)
      const after = gt === -1 ? html.length : gt + 1
      if (depth === 0) return after
      i = after
      continue
    }
    if (lower.startsWith('<' + name, lt) && isTagNameBoundary(lower[lt + name.length + 1])) {
      depth += 1
      i = lt + name.length + 1
      continue
    }
    i = lt + 1
  }
  return html.length
}

/** Index just past the `>` of the close tag that ends a masked region.
 * Exported (additive) so capture-side scanners reuse it instead of
 * forking the masking logic. */
export function findMaskedEnd(html: string, lower: string, name: string, from: number): number {
  // Raw-text/RCDATA elements (script, style, noscript, iframe, textarea) end
  // at their first boundary-checked close tag: their content is NOT parsed
  // markup, so `<!--` inside them does not start a comment.
  if (NESTABLE_MASKED.has(name)) return findNestableMaskedEnd(html, lower, name, from)
  const closeAt = findTagToken(lower, '</' + name, from)
  if (closeAt === -1) return html.length
  const gt = html.indexOf('>', closeAt)
  return gt === -1 ? html.length : gt + 1
}

/** Collapse whitespace within a block; turn BR_MARK into `\n`. */
const BR_MARK = "\u{E000}"

function finishBlock(raw: string): string {
  const lines = raw
    .split(BR_MARK)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
  return lines.join('\n')
}

/** Additive options for parseHtml. Omitting them (every existing caller)
 * keeps the historical behavior exactly. */
export interface ParseHtmlOptions {
  /**
   * When false, `<a href>` values are NOT accumulated into `links` (the
   * array stays empty) — for callers that only need text/headings/images
   * and must not allocate an unbounded link list on hostile documents
   * (e.g. the audit capture, which collects links through its own capped
   * streaming scanner). Default true.
   */
  collectLinks?: boolean
}

/**
 * One-pass structural parse. Also the engine behind extractTextFromHtml.
 */
export function parseHtml(html: string, options?: ParseHtmlOptions): ParsedDoc {
  const collectLinks = options?.collectLinks !== false
  const lower = html.toLowerCase()
  const blocks: string[] = []
  const paragraphs: string[] = []
  const headings: ParsedHeading[] = []
  const imageAlts: (string | null)[] = []
  const links: ParsedLink[] = []
  const segmentTexts: string[] = ['']
  let h2Count = 0

  let buffer = ''
  /** >0 while inside an <h1>–<h6>; holds the heading level. */
  let headingLevel = 0

  const flush = (): void => {
    const text = finishBlock(buffer)
    buffer = ''
    if (text.length === 0) return
    blocks.push(text)
    if (headingLevel > 0) {
      headings.push({ level: headingLevel, text })
    } else {
      paragraphs.push(text)
      segmentTexts[segmentTexts.length - 1] += (segmentTexts[segmentTexts.length - 1] ? '\n' : '') + text
    }
  }

  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      buffer += decodeEntities(html.slice(i))
      break
    }
    if (lt > i) buffer += decodeEntities(html.slice(i, lt))

    // Comments (the abrupt `<!-->` / `<!--->` forms end immediately)
    if (html.startsWith('<!--', lt)) {
      i = findCommentEnd(html, lt)
      continue
    }
    // CDATA is one opaque region through ']]>' (it is not rendered text in
    // HTML documents, so it is masked entirely — a '>' inside it is data).
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9)
      i = end === -1 ? html.length : end + 3
      continue
    }
    // Other <! (doctype) and <? declarations end at the first '>'.
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt + 1)
      i = end === -1 ? html.length : end + 1
      continue
    }

    const tag = parseTag(html, lt)
    if (tag === null) {
      buffer += '<'
      i = lt + 1
      continue
    }
    i = tag.end

    if (!tag.closing && MASKED_TAGS.has(tag.name)) {
      // `<script/>` is NOT an empty element — the HTML parser ignores the
      // slash and `<script/>hidden</script>` still hides `hidden`. Only
      // foreign content (svg) may genuinely self-close.
      if (!(tag.selfClosing && SELF_CLOSABLE_MASKED.has(tag.name))) {
        // Skip to the matching close tag: boundary-checked (`</scriptx>` is
        // not a close) and depth-tracked for the nestable masked elements.
        i = findMaskedEnd(html, lower, tag.name, i)
      }
      // NOT a paragraph break: none of these elements is block-level, so
      // flushing here would split `key<script></script>word` into two blocks
      // even though the page renders the single word `keyword`. Elements that
      // occupy layout still separate words.
      if (MASKED_REPLACED.has(tag.name)) buffer += ' '
      continue
    }

    if (tag.name === 'br') {
      buffer += BR_MARK
      continue
    }

    if (!tag.closing) {
      if (tag.name === 'img') {
        imageAlts.push('alt' in tag.attrs ? tag.attrs['alt'] : null)
        // Replaced element: a word boundary, so `a<img …>b` never fuses to
        // "ab" — but only a space, not a paragraph break.
        buffer += ' '
        continue
      }
      // Other replaced/void elements are word boundaries too (hr is already
      // a block tag; wbr is intentionally NOT one — it is an in-word break
      // opportunity).
      if (tag.name === 'input' || tag.name === 'embed' || tag.name === 'source' || tag.name === 'track') {
        buffer += ' '
        continue
      }
      if (tag.name === 'a') {
        const href = tag.attrs['href']
        if (collectLinks && typeof href === 'string' && href.length > 0) links.push({ href })
        continue
      }
    }

    if (BLOCK_TAGS.has(tag.name)) {
      flush()
      const level = /^h[1-6]$/.test(tag.name) ? Number(tag.name[1]) : 0
      // Any block boundary ends the heading — `</hN>` is only the well-formed
      // case. Without this, one unclosed `<h2>Title` turns every later
      // paragraph in the document into heading text (and drops it from
      // `paragraphs`). Reset AFTER flush() so the heading itself is still
      // recorded at its own level.
      headingLevel = 0
      if (!tag.closing && level > 0) {
        headingLevel = level
        if (level === 2) h2Count += 1
      } else if (tag.closing && level > 0) {
        if (level >= 2 && level <= 4) segmentTexts.push('')
      }
    }
    // Inline tags: no boundary at all.
  }
  flush()

  return {
    text: blocks.join('\n'),
    paragraphs,
    headings,
    imageAlts,
    links,
    segmentTexts,
    h2Count,
  }
}

/**
 * Strip tags/scripts/styles/comments, decode basic entities, preserve word
 * boundaries (block tags and `<br>` become newlines; inline tags vanish).
 */
export function extractTextFromHtml(html: string): string {
  return parseHtml(html).text
}

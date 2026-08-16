/**
 * headSurgeon — marker-based `<head>` rewriting for the publish.html filter.
 *
 * Runs inside Instatic's QuickJS-WASM plugin sandbox: ES2020, no DOM, no Node
 * APIs, no dependencies. Everything here is anchored string surgery on the
 * known head structure (DESIGN.md §5.4).
 *
 * Contract:
 * - Operates ONLY on the region before the first `</head>` (case-insensitive).
 *   Nothing at or after that closing tag is ever modified.
 * - Documents without a `</head>` closing tag are returned unchanged — there
 *   is no safe anchor, so we refuse to guess. (A `<head>` open tag alone is
 *   not enough; the closing tag is the insertion anchor.)
 * - A payload with NO defined fields (title, metaDescription and block all
 *   undefined) is a pure no-op: the input is returned byte-identical and
 *   stale plugin blocks are NOT stripped. Empty-string fields still count as
 *   defined ("set to empty").
 * - Idempotent: applySeoHead(applySeoHead(html, p), p) === applySeoHead(html, p).
 *   Re-publishing never accumulates duplicate tags.
 * - `undefined` payload fields are left untouched; empty string means
 *   "set to empty".
 * - HTML-aware matching: decoy tags inside `<!-- comments -->` or inside
 *   `<script>`/`<style>`/`<noscript>` bodies in the head are ignored (masked).
 *   The exact comments `<!--seo:start-->`/`<!--seo:end-->` are recognised as
 *   our block markers, never masked as ordinary comments.
 * - `payload.block` is sanitised before insertion: any literal occurrence of
 *   the marker comments is stripped, so a block payload can never break the
 *   marker pairing or idempotency.
 * - A stray `<!--seo:start-->` with no matching `<!--seo:end-->` after it
 *   (before any further start marker) is left alone, never removed.
 *
 * Injection hardening: payload-derived text is NEVER passed as a string
 * replacement to String.replace — all substitutions are performed by explicit
 * slice/concat edits, so replacement tokens like `$&`, `` $` `` or `$'` in
 * payload values are inert. Every pattern is linear (bounded character
 * classes or single forward scans); the marker-block scanner is a one-pass
 * indexOf walk, so pathological inputs (e.g. thousands of orphan start
 * markers) stay linear too.
 */

export interface SeoHeadPayload {
  /** Plain text; replaces the text content of the document's first <title>. */
  title?: string
  /** Plain text; replaces/creates <meta name="description">. */
  metaDescription?: string
  /**
   * Pre-rendered HTML owned by the plugin (canonical, robots, OG, Twitter,
   * JSON-LD…). Built and escaped by the CALLER; inserted verbatim inside the
   * `<!--seo:start-->…<!--seo:end-->` marker block — except that literal
   * occurrences of the marker comments themselves are stripped out.
   */
  block?: string
}

const SEO_START = '<!--seo:start-->'
const SEO_END = '<!--seo:end-->'

/** First closing head tag, case-insensitive, tolerating `</head >`. */
const HEAD_CLOSE_RE = /<\/head\s*>/i

/** A <title …> open tag, case-insensitive, attributes tolerated. */
const TITLE_OPEN_RE = /<title\b[^>]*>/gi

/** A </title> close tag, case-insensitive, tolerating `</title >`. */
const TITLE_CLOSE_RE = /<\/title\s*>/gi

/** A raw-text element open at a `<`: its body must be masked from matching. */
const RAW_TEXT_OPEN_RE = /^<(script|style|noscript)\b/i

/** A `<meta` tag open, case-insensitive. Tag end is found by the tokenizer. */
const META_OPEN_RE = /<meta\b/gi

/** [start, end) ranges of head content that must not be matched against. */
type Mask = [number, number]

/** A pending splice: replace s[start, end) with text. */
interface Edit {
  start: number
  end: number
  text: string
}

interface MetaAttr {
  name: string
  /** Raw source text of the value (quotes stripped); null for bare attributes. */
  value: string | null
}

interface ParsedMetaTag {
  start: number
  end: number
  attrs: MetaAttr[]
  selfClosing: boolean
}

/** Escape plain text for use as HTML element text content (e.g. <title>). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Escape plain text for use inside a double-quoted HTML attribute value. */
export function escapeAttr(text: string): string {
  // Same entity set as escapeHtml: strictly a superset of what a
  // double-quoted attribute needs, and safe in every attribute context.
  return escapeHtml(text)
}

/**
 * Apply the SEO head plan to a published page's HTML.
 *
 * Pipeline (all within the pre-`</head>` region):
 * 1. Remove every properly paired `<!--seo:start-->…<!--seo:end-->` block
 *    (one-pass scan; orphan start markers are left alone; markers inside
 *    comments or script/style/noscript bodies are ignored).
 * 2. Replace the first real `<title>` text with escaped payload.title; if the
 *    document has no title tag, a fallback <title> is queued for the block.
 * 3. Rewrite the first real `<meta name="description">` via a quote-aware
 *    attribute tokenizer (content normalised to `content="…"`, other
 *    attributes preserved), delete any duplicate description metas; if none
 *    exists, a fallback meta tag is queued for the block.
 * 4. Insert exactly one fresh marker block immediately before `</head>`,
 *    containing sanitised payload.block plus any queued fallback tags. When
 *    payload.block is undefined and no fallbacks are needed, no block is
 *    emitted (stale blocks stay removed).
 *
 * Documents with no `</head>` are returned unchanged, and so is any call
 * whose payload has no defined fields (pure no-op).
 */
export function applySeoHead(html: string, payload: SeoHeadPayload): string {
  if (payload.title === undefined && payload.metaDescription === undefined && payload.block === undefined) {
    return html
  }

  const headClose = HEAD_CLOSE_RE.exec(html)
  if (!headClose) return html

  // Everything strictly before `</head>` is ours; the tag itself and all
  // bytes after it pass through untouched.
  let head = html.slice(0, headClose.index)
  const tail = html.slice(headClose.index)

  // 1. Strip every stale plugin block so re-publishing never accumulates tags.
  head = removeSeoBlocks(head)

  const masks = computeMasks(head)
  const edits: Edit[] = []
  const blockParts: string[] = []

  // Locate the first real title element regardless of payload.title: its raw
  // text content must also be shielded from the meta scanner (a title can
  // legally contain `<meta …>`-looking text).
  const title = findTitle(head, masks)

  // 2. Title.
  if (payload.title !== undefined) {
    const escaped = escapeHtml(payload.title)
    if (title) {
      edits.push({ start: title.contentStart, end: title.contentEnd, text: escaped })
    } else {
      blockParts.push(`<title>${escaped}</title>`)
    }
  }

  // 3. Meta description.
  if (payload.metaDescription !== undefined) {
    const metaMasks: Mask[] = title ? [...masks, [title.tagStart, title.tagEnd]] : masks
    const escaped = escapeAttr(payload.metaDescription)
    const descriptions = findDescriptionMetas(head, metaMasks)
    if (descriptions.length === 0) {
      blockParts.push(`<meta name="description" content="${escaped}">`)
    } else {
      const first = descriptions[0]
      edits.push({ start: first.start, end: first.end, text: rebuildMetaTag(first, escaped) })
      for (let i = 1; i < descriptions.length; i++) {
        // Duplicate description metas hurt SEO: drop them entirely.
        edits.push({ start: descriptions[i].start, end: descriptions[i].end, text: '' })
      }
    }
  }

  head = applyEdits(head, edits)

  // 4. Fresh plugin block immediately before `</head>`.
  const sanitizedBlock = payload.block !== undefined ? stripMarkers(payload.block) : undefined
  if (sanitizedBlock !== undefined && sanitizedBlock !== '') blockParts.unshift(sanitizedBlock)
  const emitBlock = payload.block !== undefined || blockParts.length > 0
  if (emitBlock) {
    head += `${SEO_START}\n${blockParts.join('\n')}${blockParts.length > 0 ? '\n' : ''}${SEO_END}\n`
  }

  return head + tail
}

/** Remove literal marker comments from caller-supplied block HTML. */
function stripMarkers(block: string): string {
  return block.split(SEO_START).join('').split(SEO_END).join('')
}

/**
 * Compute masked ranges within the head region: ordinary HTML comments and
 * the full extent of script/style/noscript elements. The exact marker
 * comments `<!--seo:start-->`/`<!--seo:end-->` are NOT masked — they are our
 * own block delimiters. Unterminated constructs mask to the end of the head.
 * Single forward pass, linear.
 */
function computeMasks(head: string): Mask[] {
  const masks: Mask[] = []
  const lower = head.toLowerCase()
  const n = head.length
  let i = 0
  while (i < n) {
    const lt = head.indexOf('<', i)
    if (lt === -1) break
    if (head.startsWith('<!--', lt)) {
      if (head.startsWith(SEO_START, lt)) {
        i = lt + SEO_START.length
        continue
      }
      if (head.startsWith(SEO_END, lt)) {
        i = lt + SEO_END.length
        continue
      }
      const close = head.indexOf('-->', lt + 4)
      const end = close === -1 ? n : close + 3
      masks.push([lt, end])
      i = end
      continue
    }
    const raw = RAW_TEXT_OPEN_RE.exec(head.slice(lt, lt + 11))
    if (raw) {
      const name = raw[1].toLowerCase()
      const openEnd = head.indexOf('>', lt)
      let end = n
      if (openEnd !== -1) {
        const closeIdx = lower.indexOf('</' + name, openEnd + 1)
        if (closeIdx !== -1) {
          const closeGt = head.indexOf('>', closeIdx)
          end = closeGt === -1 ? n : closeGt + 1
        }
      }
      masks.push([lt, end])
      i = end
      continue
    }
    i = lt + 1
  }
  return masks
}

/** Does [start, end) overlap any mask? */
function isMasked(masks: Mask[], start: number, end: number): boolean {
  for (let i = 0; i < masks.length; i++) {
    const m = masks[i]
    if (start < m[1] && m[0] < end) return true
  }
  return false
}

/** indexOf that skips occurrences overlapping a mask. */
function findUnmasked(s: string, needle: string, from: number, masks: Mask[]): number {
  let i = s.indexOf(needle, from)
  while (i !== -1 && isMasked(masks, i, i + needle.length)) {
    i = s.indexOf(needle, i + 1)
  }
  return i
}

/**
 * Remove every properly paired seo marker block via a one-pass indexOf scan
 * (no regex — a lazy global regex is superlinear against thousands of orphan
 * start markers). Pairing rule: a start marker pairs with the next end marker
 * ONLY if no other start marker sits between them; otherwise it is an orphan
 * and is left alone. Markers inside comments or raw-text elements are
 * ignored. Consumes one trailing newline after each removed block, matching
 * what insertion emits, so re-apply is byte-stable.
 */
function removeSeoBlocks(head: string): string {
  const masks = computeMasks(head)
  const removals: Mask[] = []
  // Cache for the next end-marker position: end markers are consumed in
  // order, so a previously found end at/after the search start is reusable.
  // This keeps orphan-heavy inputs linear. -2 = unknown, -1 = none left.
  let cachedEnd = -2
  const nextEnd = (from: number): number => {
    if (cachedEnd === -1) return -1
    if (cachedEnd !== -2 && cachedEnd >= from) return cachedEnd
    cachedEnd = findUnmasked(head, SEO_END, from, masks)
    return cachedEnd
  }
  let pos = 0
  while (true) {
    const s = findUnmasked(head, SEO_START, pos, masks)
    if (s === -1) break
    const e = nextEnd(s + SEO_START.length)
    if (e === -1) break // no end marker anywhere after: s and all later starts are orphans
    const s2 = findUnmasked(head, SEO_START, s + SEO_START.length, masks)
    if (s2 !== -1 && s2 < e) {
      // Another start marker intervenes before the end: s is an orphan.
      pos = s2
      continue
    }
    let end = e + SEO_END.length
    if (head.charCodeAt(end) === 10 /* \n */) end++
    removals.push([s, end])
    cachedEnd = -2
    pos = end
  }
  if (removals.length === 0) return head
  let out = ''
  let cursor = 0
  for (let i = 0; i < removals.length; i++) {
    out += head.slice(cursor, removals[i][0])
    cursor = removals[i][1]
  }
  return out + head.slice(cursor)
}

/**
 * Locate the first unmasked <title> element. Returns null when there is none
 * (including an open tag with no matching close — no safe content range).
 */
function findTitle(
  head: string,
  masks: Mask[]
): { tagStart: number; contentStart: number; contentEnd: number; tagEnd: number } | null {
  TITLE_OPEN_RE.lastIndex = 0
  let open: RegExpExecArray | null
  while ((open = TITLE_OPEN_RE.exec(head)) !== null) {
    if (isMasked(masks, open.index, open.index + open[0].length)) continue
    const contentStart = open.index + open[0].length
    TITLE_CLOSE_RE.lastIndex = contentStart
    const close = TITLE_CLOSE_RE.exec(head)
    if (!close) return null
    return {
      tagStart: open.index,
      contentStart,
      contentEnd: close.index,
      tagEnd: close.index + close[0].length,
    }
  }
  return null
}

/**
 * Collect every unmasked `<meta name="description">` tag, in document order.
 * Tag extent and the name decision both come from a quote-aware attribute
 * tokenizer, so `name=description` text inside another attribute's quoted
 * value can never match, and `>` inside quoted values does not truncate the
 * tag.
 */
function findDescriptionMetas(head: string, masks: Mask[]): ParsedMetaTag[] {
  const found: ParsedMetaTag[] = []
  META_OPEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = META_OPEN_RE.exec(head)) !== null) {
    const parsed = parseMetaTag(head, m.index)
    if (!parsed) {
      META_OPEN_RE.lastIndex = m.index + m[0].length
      continue
    }
    META_OPEN_RE.lastIndex = parsed.end
    if (isMasked(masks, parsed.start, parsed.end)) continue
    const nameAttr = parsed.attrs.find((a) => a.name.toLowerCase() === 'name')
    if (nameAttr && nameAttr.value !== null && nameAttr.value.toLowerCase() === 'description') {
      found.push(parsed)
    }
  }
  return found
}

function isWsCode(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13
}

/**
 * Tokenize one `<meta …>` tag starting at `start` (which points at `<meta`).
 * Attribute grammar follows the HTML spec closely enough for head metas:
 * name up to whitespace/`=`/`/`/`>`, optional `=`, then a `"`/`'` quoted
 * value or an unquoted value running to whitespace or `>` (so `/` stays part
 * of an unquoted value). Returns null for a tag with no closing `>` or an
 * unterminated quote.
 */
function parseMetaTag(s: string, start: number): ParsedMetaTag | null {
  const n = s.length
  const attrs: MetaAttr[] = []
  let i = start + 5 // past '<meta'
  while (i < n) {
    while (i < n && isWsCode(s.charCodeAt(i))) i++
    if (i >= n) return null
    const c = s[i]
    if (c === '>') return { start, end: i + 1, attrs, selfClosing: false }
    if (c === '/') {
      if (s[i + 1] === '>') return { start, end: i + 2, attrs, selfClosing: true }
      i++ // stray solidus: spec says ignore
      continue
    }
    const nameStart = i
    while (i < n) {
      const ch = s[i]
      if (isWsCode(s.charCodeAt(i)) || ch === '=' || ch === '>' || ch === '/') break
      i++
    }
    const name = s.slice(nameStart, i)
    if (name === '') {
      i++ // defensive: guarantee progress on malformed input
      continue
    }
    while (i < n && isWsCode(s.charCodeAt(i))) i++
    if (s[i] !== '=') {
      attrs.push({ name, value: null })
      continue
    }
    i++ // consume '='
    while (i < n && isWsCode(s.charCodeAt(i))) i++
    if (i >= n) return null
    const q = s[i]
    if (q === '"' || q === "'") {
      const close = s.indexOf(q, i + 1)
      if (close === -1) return null // unterminated quote
      attrs.push({ name, value: s.slice(i + 1, close) })
      i = close + 1
    } else {
      const vStart = i
      while (i < n && !isWsCode(s.charCodeAt(i)) && s[i] !== '>') i++
      attrs.push({ name, value: s.slice(vStart, i) })
    }
  }
  return null
}

/**
 * Serialize a parsed meta tag with its content attribute set to
 * `escapedContent` (added when missing, duplicates of content dropped).
 * All other attributes are preserved in order, normalised to
 * double-quoted form; only `"` inside preserved values is entity-escaped,
 * which keeps re-serialisation byte-stable.
 */
function rebuildMetaTag(meta: ParsedMetaTag, escapedContent: string): string {
  const parts: string[] = []
  let contentDone = false
  for (const a of meta.attrs) {
    if (a.name.toLowerCase() === 'content') {
      if (!contentDone) {
        parts.push(`content="${escapedContent}"`)
        contentDone = true
      }
      continue
    }
    if (a.value === null) {
      parts.push(a.name)
    } else {
      parts.push(`${a.name}="${a.value.split('"').join('&quot;')}"`)
    }
  }
  if (!contentDone) parts.push(`content="${escapedContent}"`)
  return `<meta ${parts.join(' ')}${meta.selfClosing ? ' />' : '>'}`
}

/**
 * Apply non-overlapping edits to a string in one pass. Edits are built from
 * scans of the SAME base string, and payload-derived text goes in via plain
 * concatenation — String.replace replacement tokens can never fire.
 */
function applyEdits(s: string, edits: Edit[]): string {
  if (edits.length === 0) return s
  edits.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const e of edits) {
    out += s.slice(cursor, e.start) + e.text
    cursor = e.end
  }
  return out + s.slice(cursor)
}

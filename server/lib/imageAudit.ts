/**
 * Image SEO checks for rendered HTML.
 *
 * This module takes no host, SDK or DOM dependency: it is also loaded by the
 * QuickJS-WASM plugin sandbox (and by the editor bundle). Its only import is
 * the analysis lib's `decodeEntities`, which is dependency-free under exactly
 * the same rules and ships in every bundle this module does — attribute
 * values must be decoded before the semantic checks (`alt="&#32;"` carries no
 * accessible name; an entity-obfuscated `data:` src is still inline), and
 * forking a second entity table here is how the two scanners drift apart.
 * The document is walked from left to right; comments and raw-ish elements
 * are skipped before image tags are parsed.
 */

import { decodeEntities } from './analysis/extract'

export interface ImageAuditFinding {
  code:
    | 'missing-alt'
    | 'empty-alt'
    | 'generic-alt'
    | 'missing-dimensions'
    | 'huge-inline-image'
    | 'alt-too-long'
  src: string
  index: number
  detail?: string
}

export interface ImageAuditResult {
  totalImages: number
  /** Full count of images without an alt attribute, independent of findings cap. */
  missingAlt: number
  findings: ImageAuditFinding[]
}

interface Attribute {
  name: string
  value: string | null
}

interface PictureFrame {
  /** A direct child <source>; this is the sibling exemption for dimensions. */
  hasSiblingSource: boolean
}

interface ElementEntry {
  name: string
  picture?: PictureFrame
}

interface ImageRecord {
  index: number
  src: string
  alt: string | null
  hasAlt: boolean
  decorative: boolean
  /** A width attribute that parses as a positive integer (see hasPositiveDimension). */
  hasWidth: boolean
  /** A height attribute that parses as a positive integer. */
  hasHeight: boolean
  picture: PictureFrame | undefined
}

const GENERIC_ALT_RE = /^(img|image|photo|dsc|screenshot)[-_ ]?\d*$/i

const RAW_ELEMENT_NAMES = ['script', 'style', 'noscript', 'template', 'textarea', 'title']

/** Bound both report size and the number of findings from hostile pages. */
export const IMAGE_FINDINGS_MAX = 100
export const IMAGE_FINDING_SRC_MAX = 256

/**
 * Max `<img>` elements whose attributes are RETAINED for the findings pass.
 * `totalImages` and `missingAlt` are counted during the scan and stay EXACT
 * past this cap — only per-image detail (and therefore further findings,
 * themselves capped at 100) stops accumulating, so a page with a million
 * images can no longer make the publish tick allocate a million records.
 */
export const IMAGE_RECORDS_MAX = 10_000

/**
 * Max open elements tracked while walking. The stack exists only to answer
 * "is this img a direct child of a <picture> with a <source> sibling", so
 * dropping the OLDEST (outermost) entries costs nothing that matters, and it
 * turns the unmatched-close rescan — which walks the whole stack per closing
 * tag — from O(n²) into a linear scan with a constant factor.
 */
export const IMAGE_STACK_MAX = 512

const VOID_ELEMENT_NAMES = [
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]

function isSpace(code: number): boolean {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32
}

function isNameChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 58
  )
}

function isTagNameBoundary(code: number): boolean {
  return code === 62 || code === 47 || isSpace(code)
}

function hasTagNameAt(lower: string, start: number, name: string): boolean {
  if (!lower.startsWith(name, start)) return false
  const after = start + name.length
  return after >= lower.length || isTagNameBoundary(lower.charCodeAt(after))
}

/** Find a tag's closing `>` while respecting both quote types. */
function findTagEnd(html: string, start: number): number {
  let quote = 0
  let afterEquals = false
  for (let i = start + 1; i < html.length; i++) {
    const code = html.charCodeAt(i)
    if (quote !== 0) {
      if (code === quote) quote = 0
    } else if (code === 61 /* = */) {
      afterEquals = true
    } else if (afterEquals && (code === 34 || code === 39)) {
      quote = code
      afterEquals = false
    } else if (code === 62) {
      return i + 1
    } else if (afterEquals && !isSpace(code)) {
      afterEquals = false
    }
  }
  // Treat an unterminated tag as extending to the document end. This is
  // safe for malformed input and prevents a later `>` from ending the tag.
  return html.length
}

/**
 * End of the comment opening at `start` (which starts `<!--`).
 *
 * The two SPEC-VALID abrupt forms `<!-->` and `<!--->` are COMPLETE, empty
 * comments (HTML tokenizer: comment-start and comment-start-dash both take
 * `>` as "abrupt closing of empty comment"). Scanning them for a `-->` that
 * is not there masked the rest of the document, so `<!--><img src=x>`
 * reported totalImages 0 — a false pass. A genuinely unterminated comment
 * still masks to the end of the input, which is what a browser does too.
 */
function findCommentEnd(html: string, start: number): number {
  if (html.charCodeAt(start + 4) === 62) return start + 5
  if (html.charCodeAt(start + 4) === 45 && html.charCodeAt(start + 5) === 62) return start + 6
  for (let i = start + 4; i + 2 < html.length; i++) {
    if (html.charCodeAt(i) === 45 && html.charCodeAt(i + 1) === 45 && html.charCodeAt(i + 2) === 62) {
      return i + 3
    }
  }
  return html.length
}

/** Find a raw element close tag with one forward character scan. */
function findRawClose(html: string, lower: string, start: number, name: string): number {
  const prefixLength = name.length + 2 // `</` plus the element name
  for (let i = start; i + prefixLength <= html.length; i++) {
    if (lower.charCodeAt(i) !== 60 || lower.charCodeAt(i + 1) !== 47) continue
    if (!lower.startsWith(name, i + 2)) continue
    const after = i + prefixLength
    if (after < html.length && !isTagNameBoundary(lower.charCodeAt(after))) continue
    return i
  }
  return -1
}

function isSelfClosing(html: string, tagEnd: number): boolean {
  let i = tagEnd - 2 // one character before `>`
  while (i >= 0 && isSpace(html.charCodeAt(i))) i--
  return i >= 0 && html.charCodeAt(i) === 47
}

function isVoidElement(name: string): boolean {
  for (let i = 0; i < VOID_ELEMENT_NAMES.length; i++) {
    if (VOID_ELEMENT_NAMES[i] === name) return true
  }
  return false
}

function parseTagName(html: string, start: number, end: number): { name: string; closing: boolean } | null {
  let i = start + 1
  let closing = false
  if (html.charCodeAt(i) === 47) {
    closing = true
    i++
  }
  while (i < end && isSpace(html.charCodeAt(i))) i++
  const nameStart = i
  while (i < end && isNameChar(html.charCodeAt(i))) i++
  if (i === nameStart) return null
  return { name: html.slice(nameStart, i).toLowerCase(), closing }
}

/** Tokenize attributes in [start, end), where end excludes the tag's `>`. */
function parseAttributes(html: string, start: number, end: number): Attribute[] {
  const attrs: Attribute[] = []
  let i = start
  while (i < end) {
    while (i < end && isSpace(html.charCodeAt(i))) i++
    if (i >= end) break

    const nameStart = i
    while (i < end && !isSpace(html.charCodeAt(i)) && html.charCodeAt(i) !== 61) i++
    if (i === nameStart) {
      i++
      continue
    }
    const name = html.slice(nameStart, i).toLowerCase()
    while (i < end && isSpace(html.charCodeAt(i))) i++

    let value: string | null = null
    if (i < end && html.charCodeAt(i) === 61) {
      i++
      while (i < end && isSpace(html.charCodeAt(i))) i++
      if (i < end && (html.charCodeAt(i) === 34 || html.charCodeAt(i) === 39)) {
        const quote = html.charCodeAt(i++)
        const valueStart = i
        while (i < end && html.charCodeAt(i) !== quote) i++
        value = html.slice(valueStart, i)
        if (i < end) i++
      } else {
        const valueStart = i
        while (i < end && !isSpace(html.charCodeAt(i))) i++
        value = html.slice(valueStart, i)
      }
    }
    // A slash immediately before the tag end is syntax, not an attribute.
    // Values are entity-decoded (parity with capture.ts's parseTagAttrs):
    // the semantic checks below read the value a browser would see, not the
    // source bytes. A bare attribute keeps its `null` (absent value).
    if (name !== '/') attrs.push({ name, value: value === null ? null : decodeEntities(value) })
  }
  return attrs
}

function firstAttribute(attrs: Attribute[], name: string): Attribute | undefined {
  for (let i = 0; i < attrs.length; i++) {
    if (attrs[i].name === name) return attrs[i]
  }
  return undefined
}

function countCodePoints(value: string): number {
  let count = 0
  for (let i = 0; i < value.length; count++) {
    const first = value.charCodeAt(i++)
    if (first >= 0xd800 && first <= 0xdbff && i < value.length) {
      const second = value.charCodeAt(i)
      if (second >= 0xdc00 && second <= 0xdfff) i++
    }
  }
  return count
}

/** `role="none"` is ARIA 1.1's synonym for `role="presentation"` — both mark
 * the image decorative and both silence `empty-alt`. */
function isDecorative(attrs: Attribute[]): boolean {
  const role = firstAttribute(attrs, 'role')
  const ariaHidden = firstAttribute(attrs, 'aria-hidden')
  const roleValue = role === undefined ? '' : (role.value || '').trim().toLowerCase()
  return (
    roleValue === 'presentation' ||
    roleValue === 'none' ||
    (ariaHidden !== undefined && (ariaHidden.value || '').trim().toLowerCase() === 'true')
  )
}

/** A width/height attribute that actually constrains layout: HTML dimension
 * attributes are non-negative integers, and only a POSITIVE one lets the
 * browser reserve space before the image loads. `width="banana"`,
 * `width="50%"` and `width="0"` are all as good as absent for CLS. */
function hasPositiveDimension(attrs: Attribute[], name: string): boolean {
  const attr = firstAttribute(attrs, name)
  if (attr === undefined) return false
  const value = (attr.value || '').trim()
  if (!/^[0-9]+$/.test(value)) return false
  return parseInt(value, 10) > 0
}

/** Push an open element, dropping the OUTERMOST entry once the stack is
 * full — see IMAGE_STACK_MAX. */
function pushElement(stack: ElementEntry[], entry: ElementEntry): void {
  if (stack.length >= IMAGE_STACK_MAX) stack.shift()
  stack.push(entry)
}

function addFinding(findings: ImageAuditFinding[], code: ImageAuditFinding['code'], image: ImageRecord): void {
  if (findings.length >= IMAGE_FINDINGS_MAX) return
  const src =
    image.src.length <= IMAGE_FINDING_SRC_MAX
      ? image.src
      : image.src.slice(0, IMAGE_FINDING_SRC_MAX - 1) + '…'
  findings.push({ code, src, index: image.index })
}

/**
 * Audit all real <img> elements in a rendered HTML document.
 *
 * Empty alt is exempted when role="presentation", role="none" (its ARIA 1.1
 * synonym) or aria-hidden="true" is present, because those attributes
 * explicitly mark the image decorative.
 * Missing dimensions are exempted only for an img that is a direct child of
 * a <picture> containing a direct-child <source> sibling. The source may occur
 * before or after the img; the decision is deferred until scanning completes.
 * width/height must PARSE as positive integers to count — a present but
 * unusable value reserves no space, so it is not a dimension.
 *
 * Resource bounds: `totalImages`/`missingAlt` are exact for any input, while
 * retained per-image detail stops at IMAGE_RECORDS_MAX and the open-element
 * stack at IMAGE_STACK_MAX (both documented at their declarations).
 */
export function auditImages(html: string): ImageAuditResult {
  const lower = html.toLowerCase()
  const images: ImageRecord[] = []
  const stack: ElementEntry[] = []
  // Counted during the scan so they stay EXACT past IMAGE_RECORDS_MAX.
  let totalImages = 0
  let missingAlt = 0
  let i = 0

  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) break

    if (html.startsWith('<!--', lt)) {
      i = findCommentEnd(html, lt)
      continue
    }

    let skippedRaw = false
    for (let rawIndex = 0; rawIndex < RAW_ELEMENT_NAMES.length; rawIndex++) {
      const rawName = RAW_ELEMENT_NAMES[rawIndex]
      if (!hasTagNameAt(lower, lt + 1, rawName)) continue

      const openEnd = findTagEnd(html, lt)
      // HTML raw/RCDATA elements are not self-closing: a slash before `>` is
      // ignored by the HTML parser, so `<script src=x />` still owns its body.
      const closeStart = findRawClose(html, lower, openEnd, rawName)
      i = closeStart === -1 ? html.length : findTagEnd(html, closeStart)
      skippedRaw = true
      break
    }
    if (skippedRaw) continue

    if (!hasTagNameAt(lower, lt + 1, 'img')) {
      const roughName = parseTagName(html, lt, html.length)
      if (roughName && roughName.name !== '') {
        const tagEnd = findTagEnd(html, lt)
        if (roughName.closing) {
          let match = -1
          for (let stackIndex = stack.length - 1; stackIndex >= 0; stackIndex--) {
            if (stack[stackIndex].name === roughName.name) {
              match = stackIndex
              break
            }
          }
          if (match !== -1) stack.length = match
        } else {
          const selfClosing = isSelfClosing(html, tagEnd)
          if (roughName.name === 'source' && stack.length > 0) {
            const parent = stack[stack.length - 1]
            if (parent.name === 'picture' && parent.picture) parent.picture.hasSiblingSource = true
          }
          if (roughName.name === 'picture' && !selfClosing) {
            pushElement(stack, { name: 'picture', picture: { hasSiblingSource: false } })
          } else if (!selfClosing && !isVoidElement(roughName.name)) {
            pushElement(stack, { name: roughName.name })
          }
        }
        i = tagEnd
        continue
      }
      i = lt + 1
      continue
    }

    const tagEnd = findTagEnd(html, lt)
    const attrsEnd = tagEnd > lt && html.charCodeAt(tagEnd - 1) === 62 ? tagEnd - 1 : tagEnd
    const attrs = parseAttributes(html, lt + 4, attrsEnd)
    const altAttribute = firstAttribute(attrs, 'alt')
    const srcAttribute = firstAttribute(attrs, 'src')
    const picture =
      stack.length > 0 && stack[stack.length - 1].name === 'picture'
        ? stack[stack.length - 1].picture
        : undefined

    const hasAlt = altAttribute !== undefined
    const index = totalImages
    totalImages++
    if (!hasAlt) missingAlt++
    if (images.length < IMAGE_RECORDS_MAX) {
      images.push({
        index,
        src: srcAttribute?.value || '',
        alt: altAttribute?.value || null,
        hasAlt,
        decorative: isDecorative(attrs),
        hasWidth: hasPositiveDimension(attrs, 'width'),
        hasHeight: hasPositiveDimension(attrs, 'height'),
        picture,
      })
    }
    i = tagEnd
  }

  const findings: ImageAuditFinding[] = []
  for (let imageIndex = 0; imageIndex < images.length; imageIndex++) {
    const image = images[imageIndex]
    if (!image.hasAlt) {
      addFinding(findings, 'missing-alt', image)
    } else {
      const alt = image.alt || ''
      // A bare alt attribute is treated like alt="", matching HTML DOM use.
      // Whitespace-only alt carries no accessible name either — same finding.
      if (alt.trim() === '' && !image.decorative) {
        addFinding(findings, 'empty-alt', image)
      } else if (GENERIC_ALT_RE.test(alt.trim())) {
        addFinding(findings, 'generic-alt', image)
      }
      if (countCodePoints(alt) > 125) addFinding(findings, 'alt-too-long', image)
    }
    if ((!image.hasWidth || !image.hasHeight) && !(image.picture && image.picture.hasSiblingSource)) {
      addFinding(findings, 'missing-dimensions', image)
    }
    if (image.src.length > 65535 && image.src.slice(0, 5).toLowerCase() === 'data:') {
      addFinding(findings, 'huge-inline-image', image)
    }
  }

  return { totalImages, missingAlt, findings }
}

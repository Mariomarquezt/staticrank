/**
 * metaBlock — pure head-plan builder for the publish.html filter (task 1.3).
 *
 * Turns merged SEO meta + page context into the `SeoHeadPayload` that
 * `applySeoHead` consumes. No SDK imports, no platform globals beyond
 * ES2020 — unit-tests under plain `bun test` and bundles into the QuickJS
 * sandbox unchanged.
 *
 * Two layers, both exported for tests:
 *
 *   1. `mergeSeoMeta(entry, config, ctx)` — the DESIGN §5.4 merge chain:
 *      per-entry seo_meta override → table title template → site defaults.
 *      Output is a plain `SeoMetaPayload` holding the RESOLVED values.
 *   2. `buildSeoHeadPayload(merged, ctx)` — resolved values → the
 *      `{ title?, metaDescription?, block? }` payload. Tag emission rules:
 *      no tag is ever emitted for absent data (empty-content tags never
 *      appear), and a fully absent result is `{}` so `applySeoHead`
 *      passes the document through byte-identical.
 *
 * Emission rules (per task 1.3):
 * - `<link rel="canonical">` only when the canonical RESOLVES to an
 *   absolute URL: stored absolute values pass through; stored
 *   site-relative paths are joined onto the configured site URL; a
 *   relative canonical with no configured site URL is NOT emitted (a
 *   relative canonical is close to meaningless to crawlers, and guessing
 *   an origin would be worse). Same resolution applies to og:image.
 * - `<meta name="robots">` only when noindex or nofollow is TRUE.
 *   Absent flags and explicit `false` emit nothing — indexability is the
 *   default and is never degraded by omission (task rule 4).
 * - OG tags: og:title falls back to the merged title, og:description to
 *   the merged description (standard SEO practice); og:image has no
 *   fallback. Each tag only when its resolved value is non-empty.
 * - Twitter: `twitter:card` only when a card type is stored; then
 *   twitter:title/twitter:description ride along via the OG fallback
 *   values when those resolve. (Scrapers also fall back to og:* on their
 *   own; emitting the pair is belt-and-braces, never new data.)
 *
 * Escaping: attribute values go through `escapeAttr`; `title` and
 * `metaDescription` are passed as PLAIN TEXT because `applySeoHead`
 * escapes them itself (see SeoHeadPayload docs — pre-escaping here would
 * double-escape).
 */

import type { SeoHeadPayload } from './lib/headSurgeon'
import { applySeoHead, escapeAttr, findCommentEnd, findHeadClose } from './lib/headSurgeon'
import { pageUrl, slugBreadcrumbs } from './lib/pageUrl'
import { buildSchemaGraph } from './lib/schemaGraph'
import { renderTemplate } from './lib/templateEngine'
import type { SeoMetaPayload } from './seoMeta'
// Type-only: a VALUE import from seoConfig would create an import cycle
// (seoConfig imports normalizeSiteOrigin/TITLE_TEMPLATE_VARS from here).
// The schema-enabled default is therefore checked inline below. Configs
// without a version retain the original default-on shape; versioned configs
// require an explicit true toggle.
import type { SeoConfigData } from './seoConfig'

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

/** Context for the merge chain (one publish.html invocation). */
export interface MergeContext {
  /** Table the published entry belongs to (`pages` for regular pages). */
  tableSlug: string
  /** Slug from the filter context — feeds `%slug%`. */
  slug: string
  /**
   * Text of the page's existing `<title>` (host bakes `settings.metaTitle
   * ?? page.title ?? site.name` — publisher render.ts:326). Feeds
   * `%title%`; when absent or empty the slug is used instead.
   */
  pageTitle?: string
}

/** Context for tag emission. */
export interface PageSeoContext {
  /**
   * Absolute site origin from seo-config site defaults (e.g.
   * `https://example.com`) — the base for absolutizing site-relative
   * canonical / og:image values. Absent = relative values are dropped.
   */
  siteUrl?: string
  /**
   * The ORIGINAL page title the `%title%` template variable rendered
   * from, stashed as an escaped `<!--seo:source-title:…-->` comment
   * inside the plugin block whenever the emitted title is
   * template-derived. Without the stash, re-filtering our own output
   * would feed the already-templated `<title>` back into `%title%` and
   * compound (`A | Site` → `A | Site | Site`); with it, re-apply is
   * idempotent. `''` means "the document had no source title" (the slug
   * fallback re-applies). `undefined` = no stash (title not templated).
   */
  sourceTitle?: string
}

/**
 * Template variables the title templates may reference. Validation in
 * seoConfig.ts rejects templates using anything else, so a typo'd
 * variable fails at save time instead of silently rendering ''.
 */
export const TITLE_TEMPLATE_VARS = ['title', 'site', 'sep', 'slug'] as const

/**
 * Separator used for `%sep%` when the site defaults don't configure one.
 * Kept deliberately plain; overridden by `site.separator`.
 */
export const DEFAULT_SEPARATOR = '-'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Undefined/empty-string → undefined; anything else passes through. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined
}

/** Absolute http(s) URL with a non-empty authority? (mirrors seoMeta's check) */
function isAbsoluteHttpUrl(value: string): boolean {
  const m = /^https?:\/\/([^/?#]*)/i.exec(value)
  return m !== null && m[1]!.length > 0
}

/**
 * A bare site ORIGIN: http(s), non-empty hostname (registered name or a
 * bracketed IPv6 literal), no userinfo, optional port, and NO
 * path/query/fragment beyond a single optional trailing slash. The
 * hostname charset excludes `@`, `:`, `/`, `?`, `#` and whitespace, so
 * `https://@/`, `https://:443/`, and `https://example.com/base?x=1` all
 * fail — an origin with a path would produce malformed joins
 * (`…/base?x=1/about`).
 */
const SITE_ORIGIN_RE = /^(https?:\/\/(?:[a-z0-9._~%-]+|\[[0-9a-fA-F:.]+\])(?::\d{1,5})?)\/?$/i

/**
 * Validate + normalize a site origin: returns the origin WITHOUT any
 * trailing slash, or undefined when the value is not a bare origin.
 */
export function normalizeSiteOrigin(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  const m = SITE_ORIGIN_RE.exec(value)
  return m ? m[1] : undefined
}

/**
 * Resolve a stored URL value to the absolute URL to emit, or undefined
 * when it cannot be resolved. Absolute http(s) values pass through;
 * site-relative paths (`/…`, never `//…` — validation upstream already
 * rejects protocol-relative) join onto the normalized site ORIGIN.
 * Anything else — a relative path with no configured site origin, or a
 * stored siteUrl that is not a bare origin (stale pre-validation
 * records) — is not emitted.
 */
export function resolveAbsoluteUrl(
  value: string | undefined,
  siteUrl: string | undefined,
): string | undefined {
  if (value === undefined || value === '') return undefined
  if (isAbsoluteHttpUrl(value)) return value
  if (!value.startsWith('/') || value.startsWith('//')) return undefined
  const origin = normalizeSiteOrigin(siteUrl)
  if (origin === undefined) return undefined
  return origin + value
}

// ---------------------------------------------------------------------------
// Existing-title extraction — the `%title%` variable source
// ---------------------------------------------------------------------------

/**
 * Decode the entity set the host's `escapeHtml` can produce
 * (`&amp; &lt; &gt; &quot; &#x27;` — src/core/html-sanitize/index.ts:10-16)
 * plus our own `&#39;` and `&apos;`, and generic numeric references.
 * Single pass, so `&amp;lt;` correctly decodes to the literal `&lt;`.
 */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g,
    (match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (named !== undefined) {
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named] as string
      }
      const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec as string, 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    },
  )
}

/** Legal character after a tag name (headSurgeon's boundary rule) — so
 * `</titlex>` never closes `<title>` and `<titles>` never opens one. */
function isTitleTagBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === '>' || ch === '/' || /\s/.test(ch)
}

/** Index just past a tag's closing `>`, respecting both quote types (the
 * imageAudit rule: an unterminated tag extends to the end of the region). */
function findTitleTagEnd(html: string, start: number): number {
  let quote = 0
  for (let i = start + 1; i < html.length; i++) {
    const code = html.charCodeAt(i)
    if (quote !== 0) {
      if (code === quote) quote = 0
    } else if (code === 34 || code === 39) {
      quote = code
    } else if (code === 62) {
      return i + 1
    }
  }
  return html.length
}

/** First boundary-checked `</name` at or after `from`, or -1. */
function findTitleRawClose(lower: string, name: string, from: number): number {
  let i = from
  for (;;) {
    const at = lower.indexOf('</' + name, i)
    if (at === -1) return -1
    if (isTitleTagBoundary(lower[at + name.length + 2])) return at
    i = at + 1
  }
}

/** Raw-text head elements whose bodies are opaque to the title scan. */
const TITLE_MASKED = ['script', 'style', 'noscript']

/**
 * Hard cap on the extracted `<title>` text, in Unicode code points.
 *
 * The document title is the one input to the head pipeline the plugin does not
 * bound anywhere else: it feeds `%title%`, the `<!--seo:source-title:…-->`
 * stash, the schema graph's page name and the captured audit facts. Matches
 * `RENDERED_TEMPLATE_MAX` so a title and a rendered template clamp alike; both
 * are far past any usable SERP title.
 */
export const TITLE_TEXT_MAX = 512

/** Truncate to `max` CODE POINTS (never splits a surrogate pair). */
function clampCodePoints(text: string, max: number): string {
  // UTF-16 length >= code-point count, so this fast path can never truncate.
  if (text.length <= max) return text
  let out = ''
  let count = 0
  for (const ch of text) {
    if (count === max) break
    out += ch
    count += 1
  }
  return out
}

/**
 * Extract the text of the document's first real `<title>` in the head as
 * plain (entity-decoded, whitespace-collapsed) text. The scan is
 * MASK-AWARE (headSurgeon's masking discipline): comment content and
 * script/style/noscript raw-text bodies are opaque, so neither a
 * commented-out decoy title nor a `<title>` string inside a script (e.g.
 * `<script>const x="<title>evil</title>"</script>`) can ever win.
 * Returns undefined when there is no head, no title, or the title is
 * empty, and clamps the result to TITLE_TEXT_MAX code points. This feeds
 * `%title%` only — head REWRITING stays with the far stricter headSurgeon.
 */
export function extractTitleText(html: string): string | undefined {
  const headClose = findHeadClose(html)
  if (headClose === -1) return undefined
  const head = html.slice(0, headClose)
  const lower = head.toLowerCase()
  let i = 0
  while (i < head.length) {
    const lt = head.indexOf('<', i)
    if (lt === -1) break
    if (head.startsWith('<!--', lt)) {
      i = findCommentEnd(head, lt)
      continue
    }
    let masked = false
    for (const name of TITLE_MASKED) {
      if (!lower.startsWith('<' + name, lt)) continue
      if (!isTitleTagBoundary(lower[lt + name.length + 1])) continue
      const openEnd = findTitleTagEnd(head, lt)
      const closeAt = findTitleRawClose(lower, name, openEnd)
      i = closeAt === -1 ? head.length : findTitleTagEnd(head, closeAt)
      masked = true
      break
    }
    if (masked) continue
    if (lower.startsWith('<title', lt) && isTitleTagBoundary(lower[lt + 6])) {
      const openEnd = findTitleTagEnd(head, lt)
      const closeAt = findTitleRawClose(lower, 'title', openEnd)
      if (closeAt === -1) return undefined
      const text = decodeEntities(head.slice(openEnd, closeAt)).replace(/\s+/g, ' ').trim()
      return text === '' ? undefined : clampCodePoints(text, TITLE_TEXT_MAX)
    }
    i = findTitleTagEnd(head, lt)
  }
  return undefined
}

/** Stash-comment delimiters (see PageSeoContext.sourceTitle). */
const SOURCE_TITLE_OPEN = '<!--seo:source-title:'
const TITLE_FP_OPEN = '<!--seo:title-fp:'
const COMMENT_CLOSE = '-->'
const SEO_BLOCK_START = '<!--seo:start-->'
const SEO_BLOCK_END = '<!--seo:end-->'

/** Normalize title text for comparison/storage: collapse ws, trim. */
function normalizeTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * [start, end) ranges of head content that is OPAQUE to the marker scan:
 * ordinary HTML comments and the full extent of script/style/noscript
 * elements. The marker comments themselves are never masked — they are the
 * plugin's own delimiters. Mirrors headSurgeon's `computeMasks` discipline
 * with metaBlock's existing tag helpers; single forward pass, linear.
 */
function computeMarkerMasks(head: string): Array<[number, number]> {
  const masks: Array<[number, number]> = []
  const lower = head.toLowerCase()
  let i = 0
  while (i < head.length) {
    const lt = head.indexOf('<', i)
    if (lt === -1) break
    if (head.startsWith('<!--', lt)) {
      if (head.startsWith(SEO_BLOCK_START, lt)) {
        i = lt + SEO_BLOCK_START.length
        continue
      }
      if (head.startsWith(SEO_BLOCK_END, lt)) {
        i = lt + SEO_BLOCK_END.length
        continue
      }
      const end = findCommentEnd(head, lt)
      masks.push([lt, end])
      i = end
      continue
    }
    let masked = false
    for (const name of TITLE_MASKED) {
      if (!lower.startsWith('<' + name, lt)) continue
      if (!isTitleTagBoundary(lower[lt + name.length + 1])) continue
      const openEnd = findTitleTagEnd(head, lt)
      const closeAt = findTitleRawClose(lower, name, openEnd)
      const end = closeAt === -1 ? head.length : findTitleTagEnd(head, closeAt)
      masks.push([lt, end])
      i = end
      masked = true
      break
    }
    if (masked) continue
    i = findTitleTagEnd(head, lt)
  }
  return masks
}

/** indexOf that skips occurrences overlapping a masked (opaque) range. */
function indexOfUnmasked(
  s: string,
  needle: string,
  from: number,
  masks: Array<[number, number]>,
): number {
  let i = s.indexOf(needle, from)
  while (i !== -1) {
    let hidden = false
    for (const m of masks) {
      if (i < m[1] && m[0] < i + needle.length) {
        hidden = true
        break
      }
    }
    if (!hidden) return i
    i = s.indexOf(needle, i + 1)
  }
  return -1
}

/**
 * [start, end) of the first properly PAIRED `<!--seo:start-->…
 * <!--seo:end-->` block in `s` — same pairing rule as headSurgeon's
 * remover (a start marker pairs with the next end marker only when no
 * other start marker sits between them). Returns null when none.
 *
 * MASK-AWARE, exactly like `removeSeoBlocks`: markers that only appear as
 * text inside a comment or a script/style/noscript body are not markers.
 * Without that, a head `<script>` holding a literal marker pair earlier in
 * the document would win over the plugin's real (trailing) block and its
 * forged `<!--seo:source-title:…-->` would poison `%title%`.
 */
function findPairedSeoBlock(s: string): [number, number] | null {
  const masks = computeMarkerMasks(s)
  let pos = 0
  while (true) {
    const start = indexOfUnmasked(s, SEO_BLOCK_START, pos, masks)
    if (start === -1) return null
    const end = indexOfUnmasked(s, SEO_BLOCK_END, start + SEO_BLOCK_START.length, masks)
    if (end === -1) return null
    const nextStart = indexOfUnmasked(s, SEO_BLOCK_START, start + SEO_BLOCK_START.length, masks)
    if (nextStart !== -1 && nextStart < end) {
      pos = nextStart // orphan start — keep scanning
      continue
    }
    return [start + SEO_BLOCK_START.length, end]
  }
}

/** Decode the payload of `<open>…-->` within `s`, or undefined. */
function readStashComment(s: string, open: string): string | undefined {
  const at = s.indexOf(open)
  if (at === -1) return undefined
  const close = s.indexOf(COMMENT_CLOSE, at + open.length)
  if (close === -1) return undefined
  return normalizeTitle(decodeEntities(s.slice(at + open.length, close)))
}

/**
 * The `%title%` source for one filter run.
 *
 * A previous run's stash (`<!--seo:source-title:…-->`) is honored ONLY
 * when BOTH hold:
 *
 *   1. It sits inside the properly paired `<!--seo:start-->…
 *      <!--seo:end-->` block within the head — a user-authored
 *      look-alike comment elsewhere in the document can never poison
 *      `%title%` (stash forgery guard).
 *   2. The sibling fingerprint (`<!--seo:title-fp:…-->` — the title AS
 *      DECORATED by the run that wrote the stash) still matches the
 *      document's current `<title>` text. A mismatch means the title
 *      was edited out-of-band since we decorated it — the stash is
 *      stale, and the CURRENT title text becomes the new source.
 *
 * Otherwise the document's current `<title>` text is the source. An
 * empty honored stash decodes to undefined ("source document had no
 * title" — the slug fallback re-applies).
 */
export function resolveSourceTitle(html: string): string | undefined {
  const currentTitle = extractTitleText(html)
  const headClose = findHeadClose(html)
  if (headClose === -1) return currentTitle
  const head = html.slice(0, headClose)

  const block = findPairedSeoBlock(head)
  if (!block) return currentTitle
  const blockBody = head.slice(block[0], block[1])

  const stash = readStashComment(blockBody, SOURCE_TITLE_OPEN)
  if (stash === undefined) return currentTitle
  const fingerprint = readStashComment(blockBody, TITLE_FP_OPEN)
  if (fingerprint === undefined) return currentTitle
  if (currentTitle === undefined || normalizeTitle(currentTitle) !== fingerprint) {
    // Title edited (or removed) since we decorated it — stash is stale.
    return currentTitle
  }
  return stash === '' ? undefined : stash
}

// ---------------------------------------------------------------------------
// Merge chain — per-entry override → table template → site defaults
// ---------------------------------------------------------------------------

/**
 * Resolve the final meta values for one published page.
 *
 * Precedence, field by field:
 * - `title`: per-entry title verbatim (an explicit SEO title IS the full
 *   title — templates never rewrite it) → table title template → site
 *   default title template. Template variables: `%title%` = existing
 *   `<title>` text, falling back to the slug; `%site%` = site name;
 *   `%sep%` = configured separator (default `-`); `%slug%` = slug. A
 *   template rendering to '' yields NO title (host title stands).
 * - `metaDescription`: per-entry → site default description.
 * - `canonical`, `robots`, `ogTitle`, `ogDescription`, `ogImage`,
 *   `twitterCard`: per-entry only — never templated, never defaulted
 *   (robots especially: rule 4, indexable by default).
 */
export function mergeSeoMeta(
  entry: SeoMetaPayload,
  config: SeoConfigData,
  ctx: MergeContext,
): SeoMetaPayload {
  const site = config.site ?? {}
  const merged: SeoMetaPayload = {}

  const entryTitle = nonEmpty(entry.title)
  if (entryTitle !== undefined) {
    merged.title = entryTitle
  } else {
    const template =
      nonEmpty(config.tables?.[ctx.tableSlug]?.titleTemplate) ?? nonEmpty(site.titleTemplate)
    if (template !== undefined) {
      const rendered = renderTemplate(template, {
        title: nonEmpty(ctx.pageTitle) ?? ctx.slug,
        site: nonEmpty(site.siteName),
        sep: nonEmpty(site.separator) ?? DEFAULT_SEPARATOR,
        slug: ctx.slug,
      })
      if (rendered !== '') merged.title = rendered
    }
  }

  const description = nonEmpty(entry.metaDescription) ?? nonEmpty(site.metaDescription)
  if (description !== undefined) merged.metaDescription = description

  if (nonEmpty(entry.canonical) !== undefined) merged.canonical = entry.canonical
  if (entry.robots !== undefined) merged.robots = entry.robots
  if (nonEmpty(entry.ogTitle) !== undefined) merged.ogTitle = entry.ogTitle
  if (nonEmpty(entry.ogDescription) !== undefined) merged.ogDescription = entry.ogDescription
  if (nonEmpty(entry.ogImage) !== undefined) merged.ogImage = entry.ogImage
  if (entry.twitterCard !== undefined) merged.twitterCard = entry.twitterCard
  // Task 2.3 per-entry-only fields: never templated, never defaulted.
  if (entry.schemaType !== undefined) merged.schemaType = entry.schemaType
  if (entry.focusKeywords !== undefined && entry.focusKeywords.length > 0) {
    merged.focusKeywords = entry.focusKeywords
  }

  return merged
}

// ---------------------------------------------------------------------------
// Tag emission — merged meta → SeoHeadPayload
// ---------------------------------------------------------------------------

/**
 * Build the applySeoHead payload from merged meta. Returns `{}` (all
 * fields undefined) when there is nothing to emit — applySeoHead then
 * returns the document byte-identical.
 */
export function buildSeoHeadPayload(
  merged: SeoMetaPayload,
  ctx: PageSeoContext,
): SeoHeadPayload {
  const payload: SeoHeadPayload = {}
  const parts: string[] = []

  const title = nonEmpty(merged.title)
  if (title !== undefined) payload.title = title

  if (ctx.sourceTitle !== undefined) {
    // Stash the pre-template source AND a fingerprint of the title as we
    // are about to decorate it. resolveSourceTitle only honors the stash
    // while the fingerprint still matches the document's live <title> —
    // see its doc comment (stale-stash / forgery guards).
    parts.push(`${SOURCE_TITLE_OPEN}${escapeAttr(normalizeTitle(ctx.sourceTitle))}${COMMENT_CLOSE}`)
    parts.push(`${TITLE_FP_OPEN}${escapeAttr(normalizeTitle(title ?? ''))}${COMMENT_CLOSE}`)
  }

  const description = nonEmpty(merged.metaDescription)
  if (description !== undefined) payload.metaDescription = description

  const canonical = resolveAbsoluteUrl(merged.canonical, ctx.siteUrl)
  if (canonical !== undefined) {
    parts.push(`<link rel="canonical" href="${escapeAttr(canonical)}">`)
  }

  const robotsTokens: string[] = []
  if (merged.robots?.noindex === true) robotsTokens.push('noindex')
  if (merged.robots?.nofollow === true) robotsTokens.push('nofollow')
  if (robotsTokens.length > 0) {
    parts.push(`<meta name="robots" content="${robotsTokens.join(', ')}">`)
  }

  const ogTitle = nonEmpty(merged.ogTitle) ?? title
  const ogDescription = nonEmpty(merged.ogDescription) ?? description
  const ogImage = resolveAbsoluteUrl(merged.ogImage, ctx.siteUrl)
  if (ogTitle !== undefined) {
    parts.push(`<meta property="og:title" content="${escapeAttr(ogTitle)}">`)
  }
  if (ogDescription !== undefined) {
    parts.push(`<meta property="og:description" content="${escapeAttr(ogDescription)}">`)
  }
  if (ogImage !== undefined) {
    parts.push(`<meta property="og:image" content="${escapeAttr(ogImage)}">`)
  }

  if (merged.twitterCard !== undefined) {
    parts.push(`<meta name="twitter:card" content="${escapeAttr(merged.twitterCard)}">`)
    if (ogTitle !== undefined) {
      parts.push(`<meta name="twitter:title" content="${escapeAttr(ogTitle)}">`)
    }
    if (ogDescription !== undefined) {
      parts.push(`<meta name="twitter:description" content="${escapeAttr(ogDescription)}">`)
    }
  }

  if (parts.length > 0) payload.block = parts.join('\n')
  return payload
}

// ---------------------------------------------------------------------------
// Full composition — what the publish.html filter runs per page
// ---------------------------------------------------------------------------

export interface ComposeContext {
  /** Table the published entry belongs to (`pages` for regular pages). */
  tableSlug: string
  /** Slug from the filter context. */
  slug: string
  /**
   * Present ONLY for regular (non-template) page renders: arms schema.org
   * JSON-LD graph emission for this page (task 2.3), still subject to
   * `config.schema.enabled` and to a configured site origin. Template /
   * composed renders and legacy callers omit it — no graph, byte-identical
   * behavior to pre-2.3 builds. The timestamps come from the pages row the
   * filter has ALREADY fetched for template detection (ContentEntry
   * createdAt/updatedAt — no extra lookup); either may be absent, in which
   * case the corresponding date is simply omitted from the graph.
   */
  schemaPage?: {
    /** ISO row-creation timestamp → datePublished. */
    datePublished?: string
    /** ISO last-row-update timestamp → dateModified. */
    dateModified?: string
  }
  /**
   * Pre-built analytics config `<script>` tag (task 2.4 —
   * `buildAnalyticsConfigTag` in server/analytics.ts), appended to the
   * seo block VERBATIM. The CALLER owns the whole lifecycle: building it
   * only when analytics is enabled, choosing the beacon endpoint (regular
   * vs 404-template render), and adding the tag's sha256 to the page CSP
   * afterwards (server/lib/cspPatch.ts) — without the hash the browser
   * blocks the inline tag, so callers must skip the tag when the CSP
   * cannot be patched. Absent = no tag (byte-identical pre-2.4 output).
   */
  analyticsTag?: string
}

/**
 * Verification `<meta>` tags (task 2.4) from the config's `verification`
 * section, in fixed engine order. Tokens are validated/extracted at the
 * config boundary (seoConfig.ts) and escaped here for the attribute
 * position. Emitted on EVERY render (pages, data rows, the 404 template)
 * — verification services may crawl any URL, and a site-wide constant tag
 * is the standard shape.
 */
export function buildVerificationTags(config: SeoConfigData): string[] {
  const verification = config.verification
  if (verification === undefined) return []
  const tags: string[] = []
  if (nonEmpty(verification.google) !== undefined) {
    tags.push(`<meta name="google-site-verification" content="${escapeAttr(verification.google!)}">`)
  }
  if (nonEmpty(verification.bing) !== undefined) {
    tags.push(`<meta name="msvalidate.01" content="${escapeAttr(verification.bing!)}">`)
  }
  if (nonEmpty(verification.pinterest) !== undefined) {
    tags.push(`<meta name="p:domain_verify" content="${escapeAttr(verification.pinterest!)}">`)
  }
  return tags
}

/**
 * Build the JSON-LD `<script>` tag for one page render, or undefined when
 * the graph must not / cannot be emitted. Inputs (task 2.3):
 *
 * - Gate: `ctx.schemaPage` present (regular page render), schema not
 *   disabled (`config.schema.enabled !== false` — absent = enabled), AND
 *   a configured site origin. Without an origin no absolute page URL can
 *   exist and buildSchemaGraph would emit nothing page-shaped anyway —
 *   returning undefined preserves the byte-identical no-op for
 *   unconfigured sites.
 * - siteUrl/siteName from the site defaults; publisher from the schema
 *   config (name required by the graph builder — a publisher section
 *   without a name emits no publisher node input at all).
 * - page.url via the SHARED `pageUrl` helper (server/lib/pageUrl.ts) —
 *   the exact URL the sitemap lists for the same slug.
 * - title/description = the FINAL values baking into the head: the merged
 *   title when one is emitted, else the document's standing `<title>`
 *   text; the merged description (absent = omitted).
 * - page.type from the per-entry `schemaType` override (buildSchemaGraph
 *   defaults it to WebPage).
 * - breadcrumbs from the slug path: Home → prettified intermediate
 *   segments (cumulative URLs) → current page (final title, no URL).
 *
 * The returned tag is fully escaped by buildSchemaGraph (`</` and `<!--`
 * neutralized inside the JSON) and MUST be appended to the block payload
 * VERBATIM — never through escapeAttr.
 */
export function buildSchemaTag(
  merged: SeoMetaPayload,
  config: SeoConfigData,
  ctx: ComposeContext,
  documentTitle: string | undefined,
): string | undefined {
  if (ctx.schemaPage === undefined) return undefined
  const schemaEnabled =
    config.version === undefined
      ? config.schema?.enabled !== false
      : config.version === 1 && config.schema?.enabled === true
  if (!schemaEnabled) return undefined
  const origin = normalizeSiteOrigin(config.site?.siteUrl)
  if (origin === undefined) return undefined

  const finalTitle = nonEmpty(merged.title) ?? nonEmpty(documentTitle)
  const schema = config.schema
  const publisherName = nonEmpty(schema?.publisherName)
  return buildSchemaGraph({
    siteUrl: origin,
    siteName: nonEmpty(config.site?.siteName),
    publisher:
      publisherName !== undefined
        ? {
            kind: schema?.publisherKind === 'person' ? 'person' : 'organization',
            name: publisherName,
            logoUrl: nonEmpty(schema?.publisherLogoUrl),
            sameAs: schema?.sameAs,
          }
        : undefined,
    page: {
      url: pageUrl(origin, ctx.slug),
      title: finalTitle,
      description: nonEmpty(merged.metaDescription),
      type: merged.schemaType,
      datePublished: nonEmpty(ctx.schemaPage.datePublished),
      dateModified: nonEmpty(ctx.schemaPage.dateModified),
      breadcrumbs: slugBreadcrumbs(origin, ctx.slug, finalTitle),
    },
  })
}

/**
 * The complete per-page pipeline: resolve `%title%`'s source (stash from
 * a previous run, else current `<title>`), run the merge chain, build
 * the payload, append the schema.org JSON-LD tag (task 2.3 — VERBATIM,
 * buildSchemaGraph did all the escaping), apply it. Idempotent on its own
 * output for fixed inputs: the whole seo block (JSON-LD included) is
 * regenerated from the same merged values on every run, and the graph's
 * page name reads the merged title first — never the re-templated
 * document title. With nothing stored anywhere (and no site origin
 * configured) the document passes through byte-identical (applySeoHead's
 * empty-payload no-op).
 */
export function composePublishHtml(
  html: string,
  entry: SeoMetaPayload,
  config: SeoConfigData,
  ctx: ComposeContext,
): string {
  const sourceTitle = resolveSourceTitle(html)
  const merged = mergeSeoMeta(entry, config, {
    tableSlug: ctx.tableSlug,
    slug: ctx.slug,
    pageTitle: sourceTitle,
  })
  // The stash is needed exactly when the emitted title is template-derived
  // (no per-entry title, but a title was produced): only then does the next
  // run need the pre-template source to keep %title% stable.
  const titleFromTemplate = nonEmpty(entry.title) === undefined && merged.title !== undefined
  const payload = buildSeoHeadPayload(merged, {
    siteUrl: config.site?.siteUrl,
    sourceTitle: titleFromTemplate ? sourceTitle ?? '' : undefined,
  })
  // When no merged title is emitted, the FINAL head title is whatever the
  // document already carries — feed that (not the pre-template stash) to
  // the graph so page.name always matches the baked <title>.
  const schemaTag = buildSchemaTag(merged, config, ctx, extractTitleText(html))
  // Task 2.4 block extensions, all appended VERBATIM (escaping already
  // done): verification metas → JSON-LD graph → analytics config tag.
  const extras: string[] = buildVerificationTags(config)
  if (schemaTag !== undefined) extras.push(schemaTag)
  if (ctx.analyticsTag !== undefined) extras.push(ctx.analyticsTag)
  if (extras.length > 0) {
    const extraBlock = extras.join('\n')
    payload.block = payload.block !== undefined ? `${payload.block}\n${extraBlock}` : extraBlock
  }
  return applySeoHead(html, payload)
}

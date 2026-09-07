/**
 * checks — every individual analysis check, grouped Yoast/RankMath-style.
 *
 * Check inventory and point maxima (documented thresholds inline):
 *
 * keyword (per focus keyword, aggregated across all keywords)
 *   keyword-in-title            4   phrase present; front-loaded (first half) = good, later = ok
 *   keyword-in-description      3   phrase present in meta description
 *   keyword-in-slug             2   phrase present in slug tokens
 *   keyword-in-first-paragraph  3   phrase present in first paragraph
 *   keyword-density             5   0.5–2.5% good; >0–<0.5% or 2.5–3% ok; 0% bad; >3% stuffing bad
 *   keyword-in-heading          3   phrase in at least one h2–h4
 *   keyword-in-image-alt        2   phrase in at least one img alt (na when no images)
 *
 * title
 *   title-exists                2
 *   title-length                4   30–60 code points good; 1–29 ok; >60 ok (truncated); na when missing
 *
 * description
 *   description-exists          2
 *   description-length          4   120–160 good; 70–119 ok; >160 ok (truncated); <70 bad; na when missing
 *
 * content
 *   content-word-count          6   >=300 good; 150–299 ok; <150 bad
 *   content-has-h2              3   at least one <h2> (na without HTML)
 *   content-images              2   at least one <img> (na without HTML)
 *   content-internal-link       3   at least one internal link (see link classification below)
 *   content-external-link       3   at least one external link
 *   content-subheading-distribution 3  no run of >300 words without an h2–h4 (na when <300 words or no HTML)
 *
 * readability
 *   readability-sentence-length 4   average sentence length <=20 good; <=25 ok; >25 bad
 *   readability-paragraph-length 3  all paragraphs <=150 words good; worst <=200 ok; >200 bad
 *   readability-passive-voice   3   passive sentences <=10% good; <=15% ok; else bad (English only, else na)
 *   readability-transition-words 3  sentences with a transition >=30% good; >=20% ok; else bad (English only, else na)
 *
 * Link classification: a relative href is always internal; an absolute href
 * is internal/external by host comparison against input.url (ignoring a
 * leading "www." and the port). Without input.url absolute links cannot be
 * classified, so both link checks report 'na' unless a relative (internal)
 * link already settles the internal check. mailto:/tel:/javascript:/#… are
 * ignored entirely.
 *
 * Word/sentence measurement: title and description lengths are measured on the
 * value AS RENDERED (zero-width characters dropped, whitespace collapsed,
 * trimmed) so the existence and length halves of a check never disagree. Word
 * counts and sentence splitting are CJK-aware — an unspaced CJK run counts as
 * ~1 word per 2 characters and `。！？` end a sentence — while spaced scripts
 * measure exactly as before.
 *
 * Keyword aggregation: each keyword check runs once per focus keyword; the
 * reported CheckResult carries the MEAN score across keywords and a status
 * derived from earned/available (>=90% good, >=50% ok, else bad; all-na = na).
 */

import type { ParsedHeading, ParsedLink } from './extract'
import {
  containsPhrase,
  countWords,
  tokenizeBlocks,
  hasTransition,
  isPassiveSentence,
  looksEnglish,
  phraseIndexOf,
  phraseOccurrences,
  splitSentences,
  tokenizeWords,
} from './lang'
import type { CheckResult, CheckStatus } from './types'

/** Everything the checks need, precomputed once by analyzeContent. */
export interface DocContext {
  hasHtml: boolean
  text: string
  /** Pure word tokens (no boundary sentinels) — counts, stats, language. */
  textTokens: string[]
  /**
   * Block-aware token stream (TOKEN_BREAK sentinels at block/line
   * boundaries) — ALL in-content phrase matching runs against this, so a
   * keyword can never match across `<p>…</p><p>…</p>` or a `<br>`.
   */
  matchTokens: string[]
  /** `<h2>` ELEMENT count incl. empty ones (structural presence; nit #12). */
  h2Count: number
  paragraphs: string[]
  headings: ParsedHeading[]
  imageAlts: (string | null)[]
  /** null when the input had no HTML (links unknowable). */
  links: ParsedLink[] | null
  /** null when the input had no HTML (headings unknowable). */
  segmentTexts: string[] | null
  sentences: string[]
  isEnglish: boolean
  title?: string
  metaDescription?: string
  slug?: string
  url?: string
}

const GROUP_KEYWORD = 'keyword'
const GROUP_TITLE = 'title'
const GROUP_DESCRIPTION = 'description'
const GROUP_CONTENT = 'content'
const GROUP_READABILITY = 'readability'

function result(
  id: string,
  group: string,
  status: CheckStatus,
  score: number,
  max: number,
  detail: string,
): CheckResult {
  return { id, group, status, score: status === 'na' ? 0 : score, max, detail }
}

// ---------------------------------------------------------------------------
// Keyword checks
// ---------------------------------------------------------------------------

interface PerKeywordOutcome {
  status: CheckStatus
  score: number
  note: string
}

type KeywordCheckFn = (keywordTokens: string[], keyword: string, doc: DocContext) => PerKeywordOutcome

interface KeywordCheckDef {
  id: string
  max: number
  run: KeywordCheckFn
}

function checkKeywordInTitle(kw: string[], raw: string, doc: DocContext): PerKeywordOutcome {
  // Whitespace-only targets are as absent as missing ones (consistent with
  // the existence checks, which already flag them as 'bad').
  if (doc.title === undefined || doc.title.trim().length === 0) {
    return { status: 'na', score: 0, note: 'no title to inspect' }
  }
  const titleTokens = tokenizeWords(doc.title)
  const at = phraseIndexOf(titleTokens, kw)
  if (at === -1) return { status: 'bad', score: 0, note: `"${raw}" not in title` }
  // Front-loaded: the phrase begins within the first half of the title words.
  if (at < titleTokens.length / 2) {
    return { status: 'good', score: 4, note: `"${raw}" at the start of the title` }
  }
  return { status: 'ok', score: 3, note: `"${raw}" in the title, but not near the start` }
}

function checkKeywordInDescription(kw: string[], raw: string, doc: DocContext): PerKeywordOutcome {
  if (doc.metaDescription === undefined || doc.metaDescription.trim().length === 0) {
    return { status: 'na', score: 0, note: 'no meta description to inspect' }
  }
  return containsPhrase(doc.metaDescription, raw)
    ? { status: 'good', score: 3, note: `"${raw}" in the meta description` }
    : { status: 'bad', score: 0, note: `"${raw}" not in the meta description` }
}

function checkKeywordInSlug(kw: string[], raw: string, doc: DocContext): PerKeywordOutcome {
  if (doc.slug === undefined || doc.slug.trim().length === 0) {
    return { status: 'na', score: 0, note: 'no slug to inspect' }
  }
  return phraseIndexOf(tokenizeWords(doc.slug), kw) !== -1
    ? { status: 'good', score: 2, note: `"${raw}" in the slug` }
    : { status: 'bad', score: 0, note: `"${raw}" not in the slug` }
}

function checkKeywordInFirstParagraph(kw: string[], raw: string, doc: DocContext): PerKeywordOutcome {
  const first = doc.paragraphs[0]
  if (first === undefined) return { status: 'na', score: 0, note: 'no content to inspect' }
  // Block-aware: a <br> inside the paragraph is a boundary phrases can't cross.
  return phraseIndexOf(tokenizeBlocks(first), kw) !== -1
    ? { status: 'good', score: 3, note: `"${raw}" appears in the first paragraph` }
    : { status: 'bad', score: 0, note: `"${raw}" missing from the first paragraph` }
}

function checkKeywordDensity(kw: string[], raw: string, doc: DocContext): PerKeywordOutcome {
  const total = doc.textTokens.length
  if (total === 0) return { status: 'na', score: 0, note: 'no content to inspect' }
  // Occurrences counted on the block-aware stream (no cross-block phantom
  // matches); density denominator is the pure word count.
  const hits = phraseOccurrences(doc.matchTokens, kw)
  // (hits * 100) / total keeps round percentages exact (3/100 → 3, not 3.0000…4).
  const density = (hits * 100) / total
  const pct = `${Math.round(density * 100) / 100}%`
  if (hits === 0) return { status: 'bad', score: 0, note: `"${raw}" does not appear in the content` }
  if (density > 3) {
    return { status: 'bad', score: 0, note: `"${raw}" density ${pct} looks like keyword stuffing (>3%)` }
  }
  if (density >= 0.5 && density <= 2.5) {
    return { status: 'good', score: 5, note: `"${raw}" density ${pct} (${hits}×)` }
  }
  const side = density < 0.5 ? 'a little low' : 'a little high'
  return { status: 'ok', score: 3, note: `"${raw}" density ${pct} is ${side}` }
}

function checkKeywordInHeading(kw: string[], raw: string, doc: DocContext): PerKeywordOutcome {
  const subheads = doc.headings.filter((h) => h.level >= 2 && h.level <= 4)
  if (!doc.hasHtml || subheads.length === 0) {
    return { status: 'na', score: 0, note: 'no h2–h4 subheadings to inspect' }
  }
  for (const h of subheads) {
    if (phraseIndexOf(tokenizeWords(h.text), kw) !== -1) {
      return { status: 'good', score: 3, note: `"${raw}" in an h${h.level} subheading` }
    }
  }
  return { status: 'bad', score: 0, note: `"${raw}" not in any h2–h4 subheading` }
}

function checkKeywordInImageAlt(kw: string[], raw: string, doc: DocContext): PerKeywordOutcome {
  if (!doc.hasHtml || doc.imageAlts.length === 0) {
    return { status: 'na', score: 0, note: 'no images to inspect' }
  }
  for (const alt of doc.imageAlts) {
    if (alt !== null && phraseIndexOf(tokenizeWords(alt), kw) !== -1) {
      return { status: 'good', score: 2, note: `"${raw}" in an image alt attribute` }
    }
  }
  return { status: 'bad', score: 0, note: `"${raw}" not in any image alt attribute` }
}

const KEYWORD_CHECKS: readonly KeywordCheckDef[] = [
  { id: 'keyword-in-title', max: 4, run: checkKeywordInTitle },
  { id: 'keyword-in-description', max: 3, run: checkKeywordInDescription },
  { id: 'keyword-in-slug', max: 2, run: checkKeywordInSlug },
  { id: 'keyword-in-first-paragraph', max: 3, run: checkKeywordInFirstParagraph },
  { id: 'keyword-density', max: 5, run: checkKeywordDensity },
  { id: 'keyword-in-heading', max: 3, run: checkKeywordInHeading },
  { id: 'keyword-in-image-alt', max: 2, run: checkKeywordInImageAlt },
]

function statusFromRatio(ratio: number): CheckStatus {
  if (ratio >= 0.9) return 'good'
  if (ratio >= 0.5) return 'ok'
  return 'bad'
}

/**
 * Keywords are capped at 20 tokens for matching (longer ones are truncated —
 * documented limitation). With the cap, the naive early-out phrase scan is
 * at worst O(doc × 20), so adversarial mega-keywords cannot blow up analysis.
 */
const MAX_KEYWORD_TOKENS = 20

export function runKeywordChecks(doc: DocContext, focusKeywords: string[]): CheckResult[] {
  const keywords = focusKeywords
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .map((k) => ({ raw: k, tokens: tokenizeWords(k).slice(0, MAX_KEYWORD_TOKENS) }))
    .filter((k) => k.tokens.length > 0)

  if (keywords.length === 0) {
    return KEYWORD_CHECKS.map((def) =>
      result(def.id, GROUP_KEYWORD, 'na', 0, def.max, 'No focus keyword set.'),
    )
  }

  return KEYWORD_CHECKS.map((def) => {
    const outcomes = keywords.map((k) => def.run(k.tokens, k.raw, doc))
    const scored = outcomes.filter((o) => o.status !== 'na')
    if (scored.length === 0) {
      return result(def.id, GROUP_KEYWORD, 'na', 0, def.max, outcomes[0].note)
    }
    const earned = scored.reduce((sum, o) => sum + o.score, 0)
    const score = Math.round((earned / scored.length) * 100) / 100
    const status = statusFromRatio(earned / (scored.length * def.max))
    const detail = outcomes.map((o) => o.note).join('; ')
    return result(def.id, GROUP_KEYWORD, status, score, def.max, detail)
  })
}

// ---------------------------------------------------------------------------
// Title + description checks
// ---------------------------------------------------------------------------

/** Length in Unicode code points (an emoji counts once, not twice). */
function codePointLength(s: string): number {
  let n = 0
  for (const _ of s) n += 1
  return n
}

/**
 * Zero-width / invisible formatting characters: present in the string but
 * absent from the rendered SERP snippet, so they must not satisfy an
 * existence check nor inflate a length measurement.
 */
const ZERO_WIDTH_RE = /[\u200B-\u200F\u2060\uFEFF]/g

/**
 * The value AS A SEARCH ENGINE WOULD SHOW IT: zero-width characters dropped,
 * whitespace runs collapsed, ends trimmed.
 *
 * The existence and length halves of these checks must measure the SAME
 * string. They used to disagree — `exists` tested `trim()` while the length
 * measured the RAW value — so 20 leading spaces plus an 11-character title
 * scored the 30–60 "sweet spot", and a zero-width-only title passed
 * `title-exists`.
 */
function measuredValue(value: string): string {
  return value.replace(ZERO_WIDTH_RE, '').replace(/\s+/g, ' ').trim()
}

export function runTitleChecks(doc: DocContext): CheckResult[] {
  const title = measuredValue(doc.title ?? '')
  const exists = title.length > 0
  const out: CheckResult[] = [
    exists
      ? result('title-exists', GROUP_TITLE, 'good', 2, 2, 'An SEO title is set.')
      : result('title-exists', GROUP_TITLE, 'bad', 0, 2, 'No SEO title is set.'),
  ]
  if (!exists) {
    out.push(result('title-length', GROUP_TITLE, 'na', 0, 4, 'No title to measure.'))
    return out
  }
  const len = codePointLength(title)
  if (len >= 30 && len <= 60) {
    out.push(result('title-length', GROUP_TITLE, 'good', 4, 4, `Title length ${len} is in the 30–60 sweet spot.`))
  } else if (len < 30) {
    out.push(result('title-length', GROUP_TITLE, 'ok', 2, 4, `Title length ${len} is short; aim for 30–60 characters.`))
  } else {
    out.push(result('title-length', GROUP_TITLE, 'ok', 2, 4, `Title length ${len} may be truncated in results (over 60).`))
  }
  return out
}

export function runDescriptionChecks(doc: DocContext): CheckResult[] {
  const desc = measuredValue(doc.metaDescription ?? '')
  const exists = desc.length > 0
  const out: CheckResult[] = [
    exists
      ? result('description-exists', GROUP_DESCRIPTION, 'good', 2, 2, 'A meta description is set.')
      : result('description-exists', GROUP_DESCRIPTION, 'bad', 0, 2, 'No meta description is set.'),
  ]
  if (!exists) {
    out.push(result('description-length', GROUP_DESCRIPTION, 'na', 0, 4, 'No description to measure.'))
    return out
  }
  const len = codePointLength(desc)
  if (len >= 120 && len <= 160) {
    out.push(result('description-length', GROUP_DESCRIPTION, 'good', 4, 4, `Description length ${len} is in the 120–160 sweet spot.`))
  } else if (len < 70) {
    out.push(result('description-length', GROUP_DESCRIPTION, 'bad', 0, 4, `Description length ${len} is far too short (under 70).`))
  } else if (len < 120) {
    out.push(result('description-length', GROUP_DESCRIPTION, 'ok', 2, 4, `Description length ${len} is a bit short; aim for 120–160.`))
  } else {
    out.push(result('description-length', GROUP_DESCRIPTION, 'ok', 2, 4, `Description length ${len} may be truncated in results (over 160).`))
  }
  return out
}

// ---------------------------------------------------------------------------
// CJK-aware measurement (round-5 item 22)
//
// The tokenizer in lang.ts is `[\p{L}\p{N}]+`, which is correct for
// space-delimited scripts but collapses an entire unspaced Chinese/Japanese/
// Korean clause into ONE token. A perfectly normal 800-character CJK article
// therefore counted as a handful of "words" (false `content-word-count` bad)
// while its single unsplit "sentence" sailed through the readability length
// check. Both measurements are corrected here, in the layer that reports them:
// the code-unit ranges are spelled out rather than using `\p{Script=…}` so the
// QuickJS sandbox needs nothing beyond what lang.ts already relies on.
//
// English (and every other spaced script) is bit-for-bit unaffected: a token
// with no CJK characters counts as exactly one word, and text with no CJK
// terminator is not re-split.
// ---------------------------------------------------------------------------

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) || // hiragana + katakana
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK unified ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xac00 && cp <= 0xd7a3) || // hangul syllables
    (cp >= 0x1100 && cp <= 0x11ff) || // hangul jamo
    (cp >= 0x3130 && cp <= 0x318f) || // hangul compatibility jamo
    (cp >= 0x20000 && cp <= 0x2ffff) //  CJK unified ext B–F
  )
}

/**
 * Word count over tokens, counting an unspaced CJK run as ~1 word per 2
 * characters (the ratio every mainstream CJK word counter approximates with)
 * instead of as a single word. A token without CJK characters counts 1, so
 * this equals `tokens.length` for spaced scripts.
 */
function wordUnits(tokens: string[]): number {
  let total = 0
  for (const token of tokens) {
    let cjk = 0
    let other = 0
    for (const ch of token) {
      if (isCjkCodePoint(ch.codePointAt(0) as number)) cjk += 1
      else other += 1
    }
    total += cjk === 0 ? 1 : Math.ceil(cjk / 2) + (other > 0 ? 1 : 0)
  }
  return total
}

/** `wordUnits` over raw text. */
function countTextUnits(text: string): number {
  return wordUnits(tokenizeWords(text))
}

function isCjkTerminator(ch: string): boolean {
  return ch === '。' || ch === '！' || ch === '？' || ch === '．'
}

function isCjkCloser(ch: string): boolean {
  return /["'’”」』）】]/.test(ch)
}

/**
 * Split further on the full-width terminators `。！？．`, which lang.ts's
 * splitter does not know about (it only ends a sentence on ASCII `.!?…`,
 * neither of which appears in ordinary CJK prose). Sentences with no such
 * terminator are passed through unchanged.
 */
function splitCjkSentences(sentences: string[]): string[] {
  const out: string[] = []
  for (const sentence of sentences) {
    let hasTerminator = false
    for (const ch of sentence) {
      if (isCjkTerminator(ch)) {
        hasTerminator = true
        break
      }
    }
    if (!hasTerminator) {
      out.push(sentence)
      continue
    }
    let start = 0
    let i = 0
    while (i < sentence.length) {
      if (!isCjkTerminator(sentence[i])) {
        i += 1
        continue
      }
      let j = i + 1
      while (j < sentence.length && isCjkTerminator(sentence[j])) j += 1
      while (j < sentence.length && isCjkCloser(sentence[j])) j += 1
      const piece = sentence.slice(start, j).trim()
      if (piece.length > 0) out.push(piece)
      i = j
      start = j
    }
    const rest = sentence.slice(start).trim()
    if (rest.length > 0) out.push(rest)
  }
  return out
}

// ---------------------------------------------------------------------------
// Content checks
// ---------------------------------------------------------------------------

interface LinkClasses {
  internal: number
  external: number
  /** Absolute links that could not be classified (no input.url). */
  unknown: number
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

function hostOf(url: string): string | null {
  let rest: string
  if (url.startsWith('//')) {
    rest = url.slice(2)
  } else {
    const m = url.match(/^[a-z][a-z0-9+.-]*:\/\//i)
    if (m === null) return null
    rest = url.slice(m[0].length)
  }
  // `\` terminates the authority too: browsers normalise it to `/` in special
  // (http/https) URLs, so `https://evil.example\@owner.example/x` navigates to
  // evil.example. Without it the `\` stayed in the host, the userinfo strip
  // yielded `owner.example`, and the link counted as INTERNAL.
  const end = rest.search(/[/?#\\]/)
  let host = (end === -1 ? rest : rest.slice(0, end)).toLowerCase()
  const at = host.lastIndexOf('@')
  if (at !== -1) host = host.slice(at + 1)
  const colon = host.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon)
  // A fully-qualified trailing dot ("example.com.") names the same host;
  // strip ONE terminal dot so both sides of the comparison normalize alike
  // (applies to protocol-relative URLs too — same code path).
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (host.startsWith('www.')) host = host.slice(4)
  return host.length > 0 ? host : null
}

export function classifyLinks(links: ParsedLink[], ownUrl: string | undefined): LinkClasses {
  const ownHost = ownUrl === undefined ? null : hostOf(ownUrl)
  const out: LinkClasses = { internal: 0, external: 0, unknown: 0 }
  for (const { href } of links) {
    const trimmed = href.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const isProtocolRelative = trimmed.startsWith('//')
    if (!isProtocolRelative && SCHEME_RE.test(trimmed)) {
      if (!/^https?:/i.test(trimmed)) continue // mailto:, tel:, javascript:, data:…
    } else if (!isProtocolRelative) {
      out.internal += 1 // relative URL — always same site
      continue
    }
    const host = hostOf(trimmed)
    if (host === null) continue
    if (ownHost === null) out.unknown += 1
    else if (host === ownHost) out.internal += 1
    else out.external += 1
  }
  return out
}

export function runContentChecks(doc: DocContext): CheckResult[] {
  const out: CheckResult[] = []
  // CJK-aware: an unspaced run is not one word (see wordUnits).
  const words = wordUnits(doc.textTokens)

  if (words >= 300) {
    out.push(result('content-word-count', GROUP_CONTENT, 'good', 6, 6, `${words} words — a solid amount of content.`))
  } else if (words >= 150) {
    out.push(result('content-word-count', GROUP_CONTENT, 'ok', 3, 6, `${words} words — consider expanding toward 300+.`))
  } else {
    out.push(result('content-word-count', GROUP_CONTENT, 'bad', 0, 6, `${words} words is thin content (under 150).`))
  }

  if (!doc.hasHtml) {
    out.push(result('content-has-h2', GROUP_CONTENT, 'na', 0, 3, 'Headings unknown without HTML.'))
    out.push(result('content-images', GROUP_CONTENT, 'na', 0, 2, 'Images unknown without HTML.'))
  } else {
    // Structural presence: empty <h2></h2> elements count here (nit #12);
    // keyword-in-heading still requires heading TEXT to match against.
    const h2s = doc.h2Count
    out.push(
      h2s > 0
        ? result('content-has-h2', GROUP_CONTENT, 'good', 3, 3, `${h2s} h2 subheading${h2s === 1 ? '' : 's'} found.`)
        : result('content-has-h2', GROUP_CONTENT, 'bad', 0, 3, 'No h2 subheadings found.'),
    )
    const imgs = doc.imageAlts.length
    out.push(
      imgs > 0
        ? result('content-images', GROUP_CONTENT, 'good', 2, 2, `${imgs} image${imgs === 1 ? '' : 's'} found.`)
        : result('content-images', GROUP_CONTENT, 'bad', 0, 2, 'No images found in the content.'),
    )
  }

  if (doc.links === null) {
    out.push(result('content-internal-link', GROUP_CONTENT, 'na', 0, 3, 'Links unknown without HTML.'))
    out.push(result('content-external-link', GROUP_CONTENT, 'na', 0, 3, 'Links unknown without HTML.'))
  } else {
    const classes = classifyLinks(doc.links, doc.url)
    if (classes.internal > 0) {
      out.push(result('content-internal-link', GROUP_CONTENT, 'good', 3, 3, `${classes.internal} internal link${classes.internal === 1 ? '' : 's'} found.`))
    } else if (classes.unknown > 0) {
      out.push(result('content-internal-link', GROUP_CONTENT, 'na', 0, 3, 'Absolute links found but no entry URL given to classify them.'))
    } else {
      out.push(result('content-internal-link', GROUP_CONTENT, 'bad', 0, 3, 'No internal links found; link to related content.'))
    }
    if (classes.external > 0) {
      out.push(result('content-external-link', GROUP_CONTENT, 'good', 3, 3, `${classes.external} external link${classes.external === 1 ? '' : 's'} found.`))
    } else if (classes.unknown > 0) {
      out.push(result('content-external-link', GROUP_CONTENT, 'na', 0, 3, 'Absolute links found but no entry URL given to classify them.'))
    } else {
      out.push(result('content-external-link', GROUP_CONTENT, 'bad', 0, 3, 'No external links found; cite at least one source.'))
    }
  }

  if (doc.segmentTexts === null || words < 300) {
    out.push(result('content-subheading-distribution', GROUP_CONTENT, 'na', 0, 3,
      doc.segmentTexts === null ? 'Headings unknown without HTML.' : 'Text is short enough to not need subheadings.'))
  } else {
    const worst = doc.segmentTexts.reduce((max, text) => Math.max(max, countTextUnits(text)), 0)
    out.push(
      worst <= 300
        ? result('content-subheading-distribution', GROUP_CONTENT, 'good', 3, 3, 'No stretch of text runs over 300 words without a subheading.')
        : result('content-subheading-distribution', GROUP_CONTENT, 'bad', 0, 3, `A stretch of ${worst} words has no subheading; add h2/h3 structure.`),
    )
  }

  return out
}

// ---------------------------------------------------------------------------
// Readability checks
// ---------------------------------------------------------------------------

export function runReadabilityChecks(doc: DocContext): CheckResult[] {
  const out: CheckResult[] = []
  // CJK-aware: `。！？` end a sentence too (see splitCjkSentences). Text
  // without those characters comes back unchanged.
  const sentences = splitCjkSentences(doc.sentences)
  const sentenceTokens = sentences.map((s) => tokenizeWords(s))

  if (sentences.length === 0) {
    out.push(result('readability-sentence-length', GROUP_READABILITY, 'na', 0, 4, 'No sentences to measure.'))
  } else {
    const totalWords = sentenceTokens.reduce((n, t) => n + wordUnits(t), 0)
    const avg = totalWords / sentences.length
    const avgText = `${Math.round(avg * 10) / 10}`
    if (avg <= 20) {
      out.push(result('readability-sentence-length', GROUP_READABILITY, 'good', 4, 4, `Average sentence length ${avgText} words.`))
    } else if (avg <= 25) {
      out.push(result('readability-sentence-length', GROUP_READABILITY, 'ok', 2, 4, `Average sentence length ${avgText} words; try to stay under 20.`))
    } else {
      out.push(result('readability-sentence-length', GROUP_READABILITY, 'bad', 0, 4, `Average sentence length ${avgText} words is hard to read.`))
    }
  }

  if (doc.paragraphs.length === 0) {
    out.push(result('readability-paragraph-length', GROUP_READABILITY, 'na', 0, 3, 'No paragraphs to measure.'))
  } else {
    const worst = doc.paragraphs.reduce((max, paragraph) => Math.max(max, countTextUnits(paragraph)), 0)
    if (worst <= 150) {
      out.push(result('readability-paragraph-length', GROUP_READABILITY, 'good', 3, 3, 'No paragraph exceeds 150 words.'))
    } else if (worst <= 200) {
      out.push(result('readability-paragraph-length', GROUP_READABILITY, 'ok', 1, 3, `Longest paragraph is ${worst} words; consider splitting it.`))
    } else {
      out.push(result('readability-paragraph-length', GROUP_READABILITY, 'bad', 0, 3, `Longest paragraph is ${worst} words; split it up.`))
    }
  }

  if (!doc.isEnglish || sentences.length === 0) {
    const why = sentences.length === 0 ? 'No sentences to measure.' : 'Text does not look English; heuristic skipped.'
    out.push(result('readability-passive-voice', GROUP_READABILITY, 'na', 0, 3, why))
    out.push(result('readability-transition-words', GROUP_READABILITY, 'na', 0, 3, why))
    return out
  }

  const passive = sentenceTokens.filter((t) => isPassiveSentence(t)).length
  const passivePct = (passive / sentences.length) * 100
  const passiveText = `${Math.round(passivePct)}% of sentences look passive`
  if (passivePct <= 10) {
    out.push(result('readability-passive-voice', GROUP_READABILITY, 'good', 3, 3, `${passiveText} (10% or less is great).`))
  } else if (passivePct <= 15) {
    out.push(result('readability-passive-voice', GROUP_READABILITY, 'ok', 1, 3, `${passiveText}; try using more active voice.`))
  } else {
    out.push(result('readability-passive-voice', GROUP_READABILITY, 'bad', 0, 3, `${passiveText}; rewrite most in active voice.`))
  }

  const transitions = sentenceTokens.filter((t) => hasTransition(t)).length
  const transPct = (transitions / sentences.length) * 100
  const transText = `${Math.round(transPct)}% of sentences use a transition word`
  if (transPct >= 30) {
    out.push(result('readability-transition-words', GROUP_READABILITY, 'good', 3, 3, `${transText}.`))
  } else if (transPct >= 20) {
    out.push(result('readability-transition-words', GROUP_READABILITY, 'ok', 1, 3, `${transText}; 30%+ reads more fluidly.`))
  } else {
    out.push(result('readability-transition-words', GROUP_READABILITY, 'bad', 0, 3, `${transText}; connect your sentences more.`))
  }

  return out
}

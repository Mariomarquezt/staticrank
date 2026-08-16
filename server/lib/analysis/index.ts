/**
 * Content analysis engine — public API (DESIGN.md §4 content analysis rows,
 * §8 Phase 2 item 1).
 *
 * This is the FULL engine (all groups, unlimited keywords). Free/Pro gating
 * (1 keyword, basic checks only) happens at the UI/license layer, never here.
 * Pure TypeScript for the QuickJS sandbox: ES2020, no DOM/Node/Intl.
 *
 * Scoring model: every check carries `max` points and earns `score` points.
 * `'na'` checks are EXCLUDED from the available total (they neither help nor
 * hurt), so a text-only entry is not punished for unknowable image/link
 * checks. Overall = round(100 * earned / available); an input where every
 * check is 'na' scores 0. Group rollups use the same exclusion.
 */

import {
  runContentChecks,
  runDescriptionChecks,
  runKeywordChecks,
  runReadabilityChecks,
  runTitleChecks,
  type DocContext,
} from './checks'
import { parseHtml, type ParsedHeading, type ParsedLink } from './extract'
import { looksEnglish, splitSentences, tokenizeBlocks, tokenizeWords } from './lang'
import type {
  AnalysisInput,
  AnalysisResult,
  CheckResult,
  CheckStatus,
  ContentStats,
} from './types'

export type {
  AnalysisInput,
  AnalysisResult,
  CheckResult,
  CheckStatus,
  ContentStats,
} from './types'
export { extractTextFromHtml } from './extract'

const GROUP_ORDER = ['keyword', 'title', 'description', 'content', 'readability'] as const

function buildDocContext(input: AnalysisInput): DocContext {
  if (typeof input.html === 'string') {
    const parsed = parseHtml(input.html)
    return {
      hasHtml: true,
      text: parsed.text,
      textTokens: tokenizeWords(parsed.text),
      matchTokens: tokenizeBlocks(parsed.text),
      h2Count: parsed.h2Count,
      paragraphs: parsed.paragraphs,
      headings: parsed.headings,
      imageAlts: parsed.imageAlts,
      links: parsed.links,
      segmentTexts: parsed.segmentTexts,
      sentences: splitSentences(parsed.text),
      isEnglish: false, // filled below
      title: input.title,
      metaDescription: input.metaDescription,
      slug: input.slug,
      url: input.url,
    }
  }
  const text = input.text ?? ''
  // Plain-text mode: paragraphs are blank-line separated; headings, images
  // and links are unknowable ('na' in the relevant checks).
  const paragraphs = text
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/[ \t]+/g, ' ').trim())
    .filter((p) => p.length > 0)
  return {
    hasHtml: false,
    text,
    textTokens: tokenizeWords(text),
    matchTokens: tokenizeBlocks(text),
    h2Count: 0,
    paragraphs,
    headings: [],
    imageAlts: [],
    links: null,
    segmentTexts: null,
    sentences: splitSentences(text),
    isEnglish: false,
    title: input.title,
    metaDescription: input.metaDescription,
    slug: input.slug,
    url: input.url,
  }
}

// ---------------------------------------------------------------------------
// Prepared extraction (wave 3.4 perf, ADDITIVE): callers that run the engine
// several times over the SAME HTML (the editor panel's per-keyword passes)
// can extract once via `prepareContent` and hand the result to
// `analyzePreparedContent` per pass — eliminating the N+1 reparse. Existing
// callers of `analyzeContent` are untouched, and the prepared path is
// byte-identical: both funnel into the same `runAnalysis` core, and the
// prepared fields are exactly what `buildDocContext` derives from `html`
// (parity-tested in __tests__/prepared.test.ts).
// ---------------------------------------------------------------------------

/**
 * Everything `analyzeContent` derives from the HTML alone — no meta fields.
 * Opaque to callers by convention: build it with `prepareContent`, pass it
 * to `analyzePreparedContent`, never mutate it (it is shared across passes).
 */
export interface PreparedContent {
  readonly text: string
  readonly textTokens: string[]
  readonly matchTokens: string[]
  readonly h2Count: number
  readonly paragraphs: string[]
  readonly headings: ParsedHeading[]
  readonly imageAlts: (string | null)[]
  readonly links: ParsedLink[]
  readonly segmentTexts: string[]
  readonly sentences: string[]
  readonly isEnglish: boolean
}

/** The non-content analysis inputs (meta fields + keywords). */
export type PreparedAnalysisInput = Omit<AnalysisInput, 'html' | 'text'>

/** Run the extraction ONCE for HTML that will be analyzed multiple times. */
export function prepareContent(html: string): PreparedContent {
  const parsed = parseHtml(html)
  const textTokens = tokenizeWords(parsed.text)
  return {
    text: parsed.text,
    textTokens,
    matchTokens: tokenizeBlocks(parsed.text),
    h2Count: parsed.h2Count,
    paragraphs: parsed.paragraphs,
    headings: parsed.headings,
    imageAlts: parsed.imageAlts,
    links: parsed.links,
    segmentTexts: parsed.segmentTexts,
    sentences: splitSentences(parsed.text),
    isEnglish: looksEnglish(textTokens),
  }
}

/**
 * `analyzeContent` over an already-prepared extraction — same result as
 * `analyzeContent({ ...input, html })` for the html `prepared` was built
 * from, without reparsing.
 */
export function analyzePreparedContent(
  prepared: PreparedContent,
  input: PreparedAnalysisInput = {},
): AnalysisResult {
  const doc: DocContext = {
    hasHtml: true,
    text: prepared.text,
    textTokens: prepared.textTokens,
    matchTokens: prepared.matchTokens,
    h2Count: prepared.h2Count,
    paragraphs: prepared.paragraphs,
    headings: prepared.headings,
    imageAlts: prepared.imageAlts,
    links: prepared.links,
    segmentTexts: prepared.segmentTexts,
    sentences: prepared.sentences,
    isEnglish: prepared.isEnglish,
    title: input.title,
    metaDescription: input.metaDescription,
    slug: input.slug,
    url: input.url,
  }
  return runAnalysis(doc, input.focusKeywords ?? [])
}

export function analyzeContent(input: AnalysisInput): AnalysisResult {
  const doc = buildDocContext(input)
  doc.isEnglish = looksEnglish(doc.textTokens)
  return runAnalysis(doc, input.focusKeywords ?? [])
}

/** Shared core: checks + scoring over a fully-built DocContext. */
function runAnalysis(doc: DocContext, focusKeywords: string[]): AnalysisResult {
  const checks: CheckResult[] = [
    ...runKeywordChecks(doc, focusKeywords),
    ...runTitleChecks(doc),
    ...runDescriptionChecks(doc),
    ...runContentChecks(doc),
    ...runReadabilityChecks(doc),
  ]

  const groups: Record<string, { score: number; max: number }> = {}
  for (const g of GROUP_ORDER) groups[g] = { score: 0, max: 0 }
  let earned = 0
  let available = 0
  for (const check of checks) {
    if (check.status === 'na') continue
    const g = groups[check.group] ?? (groups[check.group] = { score: 0, max: 0 })
    g.score += check.score
    g.max += check.max
    earned += check.score
    available += check.max
  }
  // Keep group scores tidy (keyword aggregation can produce fractions).
  for (const g of GROUP_ORDER) {
    groups[g].score = Math.round(groups[g].score * 100) / 100
  }

  const sentenceTokens = doc.sentences.map((s) => tokenizeWords(s))
  const sentenceWordTotal = sentenceTokens.reduce((n, t) => n + t.length, 0)
  const stats: ContentStats = {
    wordCount: doc.textTokens.length,
    sentenceCount: doc.sentences.length,
    paragraphCount: doc.paragraphs.length,
    headingCount: doc.headings.length,
    imageCount: doc.imageAlts.length,
    linkCount: doc.links === null ? 0 : doc.links.length,
    avgSentenceLength:
      doc.sentences.length === 0 ? 0 : Math.round((sentenceWordTotal / doc.sentences.length) * 10) / 10,
    isEnglish: doc.isEnglish,
  }

  return {
    score: available === 0 ? 0 : Math.round((100 * earned) / available),
    groups,
    checks,
    stats,
  }
}

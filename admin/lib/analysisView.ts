/**
 * Analysis view model (task 2.5) — pure mapping from the content-analysis
 * engine's output (server/lib/analysis) + the image audit
 * (server/lib/imageAudit) to what the editor panel renders. No React, no
 * SDK imports — unit-tests under plain `bun test`.
 *
 * SOURCE-AWARE HONESTY: when the analyzed HTML was serialized from the
 * live editor page tree (admin/lib/pageContent.ts — the panel's primary
 * content source), image ALT text and width/height are UNKNOWABLE: alt
 * lives on the media-library asset and dimensions on the resolved media,
 * both applied server-side at render time (vendor/Instatic
 * src/modules/base/image/index.ts:181-217), never in the tree. Reporting
 * "missing alt" against that source would be a false positive on every
 * image. This module therefore, for the 'tree' source:
 *   - re-marks the engine's `keyword-in-image-alt` check as 'na' and
 *     RECOMPUTES the overall + group scores from the adjusted checks (the
 *     engine excludes 'na' from available points, so the rollup here uses
 *     the exact same rule — index.ts:110-121);
 *   - suppresses ALL per-image audit findings: alt/dimensions are
 *     unknowable from the tree, and `huge-inline-image` cannot occur in
 *     published output at all (the publisher's sanitizer rejects data:
 *     URLs — vendor/Instatic src/core/html-sanitize/index.ts:39
 *     DANGEROUS_URL_SCHEMES, applied by safeUrl in the image renderer) —
 *     an honest note replaces them;
 *   - renders an explicit skipped-sections note when the serializer
 *     reported `partial` content (VC refs / loops / unknown modules —
 *     see admin/lib/pageContent.ts) instead of blanket-na'ing content
 *     checks: they stay scored on what IS analyzable.
 *
 * SCORE THRESHOLDS (documented decision): overall score tone is
 *   good ≥ 80, ok 50–79, bad < 50.
 * 50 mirrors the engine's own per-check aggregation boundary
 * (checks.ts `statusFromRatio`: ≥0.5 → 'ok'); 80 is the conventional
 * "green" bar (Yoast publishes ~"good" at the top fifth of the scale) and
 * matches an all-'ok' result never reading as good (an all-ok run earns
 * roughly half to three-quarters of the points).
 */

import type {
  AnalysisResult,
  CheckResult,
  CheckStatus,
  ContentStats,
} from '../../server/lib/analysis'
import type { ImageAuditFinding, ImageAuditResult } from '../../server/lib/imageAudit'

// ---------------------------------------------------------------------------
// Content source
// ---------------------------------------------------------------------------

/**
 * Where the analyzed content HTML came from:
 *  - 'tree'  — serialized from the live editor page tree (primary path)
 *  - 'none'  — no content available (serialization failed / no page);
 *              content + readability checks are 'na' by the engine.
 */
export type ContentSourceKind = 'tree' | 'none'

// ---------------------------------------------------------------------------
// Score tone
// ---------------------------------------------------------------------------

export const SCORE_GOOD_MIN = 80
export const SCORE_OK_MIN = 50

export type ScoreTone = 'good' | 'ok' | 'bad'

export function scoreTone(score: number): ScoreTone {
  if (score >= SCORE_GOOD_MIN) return 'good'
  if (score >= SCORE_OK_MIN) return 'ok'
  return 'bad'
}

// ---------------------------------------------------------------------------
// Check / group presentation
// ---------------------------------------------------------------------------

/** Compact status glyphs for per-check rows. */
export const STATUS_GLYPHS: Record<CheckStatus, string> = {
  good: '✓',
  ok: '•',
  bad: '✕',
  na: '–',
}

export const GROUP_LABELS: Record<string, string> = {
  keyword: 'Focus keyword',
  title: 'SEO title',
  description: 'Meta description',
  content: 'Content',
  readability: 'Readability',
}

export interface CheckRowView {
  id: string
  status: CheckStatus
  glyph: string
  detail: string
}

export interface GroupView {
  id: string
  label: string
  /** Earned / available points over non-'na' checks (0/0 when all 'na'). */
  score: number
  max: number
  rows: CheckRowView[]
}

export interface ImageWarningsView {
  totalImages: number
  /** Formatted finding lines, capped — see MAX_IMAGE_FINDINGS_SHOWN. */
  shown: string[]
  /** Count of findings beyond `shown` ("and N more"). */
  moreCount: number
  /** Honest limitation note for the current source, when one applies. */
  note?: string
}

export interface AnalysisView {
  /** 0–100 overall (recomputed after source adjustments). */
  score: number
  tone: ScoreTone
  groups: GroupView[]
  statsLine: string
  /** Honest limitation / guidance notes to render under the score. */
  notes: string[]
  /** Image findings block; null when no audit ran (no HTML). */
  imageWarnings: ImageWarningsView | null
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export const NOTE_NO_CONTENT =
  'Page content could not be read from the editor — content and readability checks are not scored.'

export const NOTE_NO_KEYWORD = 'Add a focus keyword to score the keyword checks.'

export const NOTE_TREE_IMAGE_LIMITS =
  'Alt text and image dimensions resolve from the media library at publish time — they are audited on published HTML, not on the editor draft.'

/** Skipped-sections note ("partial" serialization) — see buildSkippedNote. */
export function buildSkippedNote(skippedCount: number): string {
  return `${skippedCount} section${skippedCount === 1 ? ' lives' : 's live'} inside visual components, loops, or unsupported blocks and ${skippedCount === 1 ? 'is' : 'are'} not analyzed.`
}

const DETAIL_ALT_UNKNOWABLE =
  'Image alt text lives in the media library and is not readable from the editor draft.'

// ---------------------------------------------------------------------------
// Source adjustment + rollup
// ---------------------------------------------------------------------------

const ALT_DEPENDENT_CHECK_ID = 'keyword-in-image-alt'

function adjustChecksForSource(checks: CheckResult[], source: ContentSourceKind): CheckResult[] {
  if (source !== 'tree') return checks
  return checks.map((check) =>
    check.id === ALT_DEPENDENT_CHECK_ID && check.status !== 'na'
      ? { ...check, status: 'na' as const, score: 0, detail: DETAIL_ALT_UNKNOWABLE }
      : check,
  )
}

/**
 * Roll checks up to group + overall totals using the engine's exact rule:
 * 'na' checks are excluded from both earned and available points
 * (server/lib/analysis/index.ts:110-121). Recomputed here (rather than
 * trusting `result.groups`) because the source adjustment above can change
 * a check's status after the engine scored it.
 */
function rollup(checks: CheckResult[]): {
  score: number
  groups: Map<string, { score: number; max: number }>
} {
  const groups = new Map<string, { score: number; max: number }>()
  let earned = 0
  let available = 0
  for (const check of checks) {
    if (!groups.has(check.group)) groups.set(check.group, { score: 0, max: 0 })
    if (check.status === 'na') continue
    const g = groups.get(check.group) as { score: number; max: number }
    g.score += check.score
    g.max += check.max
    earned += check.score
    available += check.max
  }
  for (const g of groups.values()) g.score = Math.round(g.score * 100) / 100
  return { score: available === 0 ? 0 : Math.round((100 * earned) / available), groups }
}

// ---------------------------------------------------------------------------
// Stats + finding formatting
// ---------------------------------------------------------------------------

export function formatStatsLine(stats: ContentStats): string {
  const part = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`
  return [
    part(stats.wordCount, 'word'),
    part(stats.headingCount, 'heading'),
    part(stats.imageCount, 'image'),
    part(stats.linkCount, 'link'),
  ].join(' · ')
}

const FINDING_LABELS: Record<ImageAuditFinding['code'], string> = {
  'missing-alt': 'Missing alt text',
  'empty-alt': 'Empty alt text',
  'generic-alt': 'Generic alt text',
  'alt-too-long': 'Alt text over 125 characters',
  'missing-dimensions': 'Missing width/height',
  'huge-inline-image': 'Very large inline data: image',
}

export const MAX_IMAGE_FINDINGS_SHOWN = 3

/** Short display form of an image src: last path segment, query stripped. */
export function shortenSrc(src: string): string {
  if (src === '') return '(no src)'
  if (src.slice(0, 5).toLowerCase() === 'data:') return 'inline data: image'
  const noQuery = src.split(/[?#]/)[0]
  const segments = noQuery.split('/').filter((s) => s !== '')
  const last = segments.length > 0 ? segments[segments.length - 1] : noQuery
  return last.length > 60 ? `${last.slice(0, 59)}…` : last
}

export function formatImageFinding(finding: ImageAuditFinding): string {
  return `${FINDING_LABELS[finding.code]} — ${shortenSrc(finding.src)}`
}

function buildImageWarnings(
  audit: ImageAuditResult | null,
  source: ContentSourceKind,
): ImageWarningsView | null {
  if (audit === null) return null
  // Tree source: NO per-image findings are honestly decidable — alt and
  // dimensions live outside the tree, and huge-inline-image cannot survive
  // the publish sanitizer (data: URLs rejected — html-sanitize/index.ts:39,
  // applied by safeUrl in the image renderer). The note carries the explanation instead.
  const findings = source === 'tree' ? [] : audit.findings
  const shown = findings.slice(0, MAX_IMAGE_FINDINGS_SHOWN).map(formatImageFinding)
  return {
    totalImages: audit.totalImages,
    shown,
    moreCount: Math.max(0, findings.length - shown.length),
    ...(source === 'tree' && audit.totalImages > 0 ? { note: NOTE_TREE_IMAGE_LIMITS } : {}),
  }
}

// ---------------------------------------------------------------------------
// View assembly
// ---------------------------------------------------------------------------

export interface BuildAnalysisViewInput {
  result: AnalysisResult
  /** Image audit over the same HTML; null when no HTML was available. */
  imageAudit: ImageAuditResult | null
  source: ContentSourceKind
  /** Number of non-empty focus keywords fed to the engine. */
  keywordCount: number
  /**
   * Sections the serializer could not analyze (VC refs / loops / unknown
   * content modules) — 0 for complete trees and non-tree sources.
   */
  skippedCount?: number
}

export function buildAnalysisView(input: BuildAnalysisViewInput): AnalysisView {
  const checks = adjustChecksForSource(input.result.checks, input.source)
  const { score, groups } = rollup(checks)

  const groupViews: GroupView[] = []
  for (const [groupId, totals] of groups) {
    groupViews.push({
      id: groupId,
      label: GROUP_LABELS[groupId] ?? groupId,
      score: totals.score,
      max: totals.max,
      rows: checks
        .filter((c) => c.group === groupId)
        .map((c) => ({ id: c.id, status: c.status, glyph: STATUS_GLYPHS[c.status], detail: c.detail })),
    })
  }

  const notes: string[] = []
  if (input.keywordCount === 0) notes.push(NOTE_NO_KEYWORD)
  if (input.source === 'none') notes.push(NOTE_NO_CONTENT)
  const skippedCount = input.skippedCount ?? 0
  if (input.source === 'tree' && skippedCount > 0) notes.push(buildSkippedNote(skippedCount))

  return {
    score,
    tone: scoreTone(score),
    groups: groupViews,
    statsLine: formatStatsLine(input.result.stats),
    notes,
    imageWarnings: buildImageWarnings(input.imageAudit, input.source),
  }
}

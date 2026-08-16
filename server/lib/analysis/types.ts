/**
 * Public types for the content analysis engine (DESIGN.md §4 / §8 Phase 2.1).
 *
 * The engine is deliberately gating-free: it always runs EVERY check for
 * EVERY provided focus keyword. Free/Pro limits (1 keyword, basic group
 * only) are applied later at the UI/license layer, never here.
 */

export interface AnalysisInput {
  /** Rendered page/entry body HTML. */
  html?: string
  /** Plain text alternative when no HTML is available. */
  text?: string
  /** SEO title as it will bake into the published head. */
  title?: string
  metaDescription?: string
  slug?: string
  /** Canonical URL of the entry; enables internal/external link telling. */
  url?: string
  /** 0..n focus keywords; the engine analyzes ALL given. */
  focusKeywords?: string[]
}

export type CheckStatus = 'good' | 'ok' | 'bad' | 'na'

export interface CheckResult {
  id: string
  group: string
  status: CheckStatus
  /** Points earned; 0 when status is 'na' (and 'na' is excluded from max). */
  score: number
  /** Points available for this check. */
  max: number
  /** Human-readable explanation of the outcome. */
  detail: string
}

export interface ContentStats {
  wordCount: number
  sentenceCount: number
  paragraphCount: number
  headingCount: number
  imageCount: number
  linkCount: number
  /** Average words per sentence, 0 when there are no sentences. */
  avgSentenceLength: number
  /** Result of the English-stopword language heuristic. */
  isEnglish: boolean
}

export interface AnalysisResult {
  /** 0–100; 'na' checks are excluded from the available points. */
  score: number
  groups: Record<string, { score: number; max: number }>
  checks: CheckResult[]
  stats: ContentStats
}

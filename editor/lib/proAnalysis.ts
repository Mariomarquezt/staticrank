/**
 * Pro content-analysis unlock (wave 3.4) — pure, React-free logic behind
 * the editor panel's license awareness and full-analysis mode. No SDK
 * imports — unit-tests under plain `bun test`
 * (editor/lib/__tests__/proAnalysis.test.ts).
 *
 * LICENSE STATE: the panel fetches GET /license on the plugin's
 * authenticated runtime routes (the Connections tab's gating pattern).
 * `proUnlockedFromResponse` collapses every failure mode to LOCKED: a
 * non-OK response (the FREE build has no /license route at all — 404), a
 * malformed body, or `unlocked !== true`. The free build ships this SAME
 * editor bundle, so locked behavior must be byte-for-byte the free
 * behavior — presentation only; the server stays authoritative for every
 * gated route.
 *
 * WHY the parsing lives HERE and not admin/lib/license.ts: the free build
 * DELETES admin/lib/license.ts from the staged tree (scripts/build.ts
 * free-tier exclusions) while the editor panel ships in BOTH tiers — an
 * import would break the free build. This module re-implements only the
 * minimal defensive read the panel needs (recognizable `license` object
 * with a known status + the server-computed `unlocked` boolean, default
 * FALSE), mirroring admin/lib/license.ts `parseLicenseStatus` +
 * `licenseUnlocked` semantics exactly; the grace/expiry logic stays
 * server-side in both.
 *
 * KEYWORD SCORING TIERS:
 *   locked   → slot 0 only (admin/lib/metaForm.scoredFreeKeywords — the
 *              exact free-tier slice, unchanged)
 *   unlocked → the FULL normalized list (server-contract normalization,
 *              admin/lib/metaForm.normalizeKeywords), capped by the
 *              server's stored cap (seoMeta.FOCUS_KEYWORDS_MAX = 10).
 *
 * PER-KEYWORD ITEMIZATION: the engine is aggregate-by-design for multiple
 * keywords — runKeywordChecks AVERAGES each check across keywords and
 * joins the notes (server/lib/analysis/checks.ts:252-263), which is the
 * full-score path the overall badge shows. For the per-keyword breakdown
 * the panel therefore runs the engine once PER keyword over the SAME
 * PREPARED extraction (`prepareContent` runs ONCE per debounce in the
 * panel; each keyword pass is `analyzePreparedContent` — one serialize,
 * one parse, N cheap check passes, never an N+1 reparse) and keeps only
 * the keyword group of each result. The tree-source honesty adjustment
 * (admin/lib/analysisView.ts: `keyword-in-image-alt` is unknowable from
 * the editor tree → 'na', excluded from points) is applied here with the
 * exact same rule so a per-keyword line can never disagree with the
 * aggregate view about what is scorable.
 */

import {
  analyzeContent,
  analyzePreparedContent,
  type PreparedContent,
} from '../../server/lib/analysis'
import { FOCUS_KEYWORDS_MAX } from '../../server/seoMeta'
import { normalizeKeywords, scoredFreeKeywords } from '../../admin/lib/metaForm'
import {
  STATUS_GLYPHS,
  type AnalysisView,
  type CheckRowView,
  type ContentSourceKind,
} from '../../admin/lib/analysisView'

/**
 * License status (GET), relative to the plugin runtime base — the same
 * route contract admin/lib/license.ts declares (single-string duplicate
 * on purpose: that module is excluded from the free build, see header).
 */
export const LICENSE_ROUTE = '/license'

/** Stored keyword cap — the server's, never a UI invention (seoMeta.ts). */
export const KEYWORD_CAP = FOCUS_KEYWORDS_MAX

// ---------------------------------------------------------------------------
// License state
// ---------------------------------------------------------------------------

/**
 * Collapse a GET /license response to the panel's `proUnlocked` boolean.
 * `ok=false` (404 on the free build, any server error) and every parse
 * failure read as LOCKED — the default is always the free behavior.
 * Mirrors admin/lib/license.ts semantics: the body must carry a
 * recognizable `license` object (known status) and the SERVER-computed
 * `unlocked === true`; nothing is re-derived client-side.
 */
export function proUnlockedFromResponse(ok: boolean, body: unknown): boolean {
  if (!ok) return false
  if (body === null || typeof body !== 'object') return false
  const lic = (body as { license?: unknown }).license
  if (lic === null || lic === undefined || typeof lic !== 'object' || Array.isArray(lic)) {
    return false
  }
  const rec = lic as Record<string, unknown>
  if (rec.status !== 'active' && rec.status !== 'expired' && rec.status !== 'revoked') {
    return false
  }
  return rec.unlocked === true
}

// ---------------------------------------------------------------------------
// Keyword tiers
// ---------------------------------------------------------------------------

/**
 * The keywords actually fed to the engine for the CURRENT tier:
 * locked = the free slot-0 slice (unchanged semantics — an empty primary
 * scores nothing even when Pro extras are stored); unlocked = the full
 * server-contract-normalized list.
 */
export function scoredKeywordsForTier(focusKeywords: string[], proUnlocked: boolean): string[] {
  return proUnlocked ? normalizeKeywords(focusKeywords) : scoredFreeKeywords(focusKeywords)
}

/** Whether the add-another-keyword control is live (Pro, below the cap). */
export function canAddKeyword(slotCount: number, proUnlocked: boolean): boolean {
  return proUnlocked && slotCount < KEYWORD_CAP
}

// ---------------------------------------------------------------------------
// Per-keyword breakdown
// ---------------------------------------------------------------------------

/**
 * Tree-source honesty adjustment — MUST mirror admin/lib/analysisView.ts
 * (private there): alt text lives on media-library assets, never in the
 * editor tree, so the alt-dependent keyword check is 'na' (excluded from
 * points) when the analyzed HTML came from the tree.
 */
const ALT_DEPENDENT_CHECK_ID = 'keyword-in-image-alt'
const DETAIL_ALT_UNKNOWABLE =
  'Image alt text lives in the media library and is not readable from the editor draft.'

export interface KeywordAnalysisView {
  keyword: string
  /** Earned / available points over non-'na' keyword checks. */
  score: number
  max: number
  rows: CheckRowView[]
}

export interface BuildKeywordViewsInput {
  title: string
  metaDescription: string | undefined
  slug: string
  url: string | undefined
  /**
   * The SHARED prepared extraction of the panel's serialized HTML
   * (server/lib/analysis prepareContent — run ONCE per debounce, reused by
   * the aggregate pass and every keyword pass); undefined = no-content mode.
   */
  prepared: PreparedContent | undefined
  source: ContentSourceKind
  /** Already tier-sliced + normalized (scoredKeywordsForTier output). */
  keywords: string[]
}

/**
 * One engine pass per keyword over the same PREPARED extraction, keeping
 * only the keyword group — each keyword's itemization exactly as slot 0
 * gets today, plus its score line. Order follows the stored list. The
 * content is never reparsed here (`analyzePreparedContent` is
 * parity-tested byte-identical to the html path).
 */
export function buildKeywordViews(input: BuildKeywordViewsInput): KeywordAnalysisView[] {
  return input.keywords.map((keyword) => {
    const meta = {
      title: input.title,
      metaDescription: input.metaDescription,
      slug: input.slug,
      url: input.url,
      focusKeywords: [keyword],
    }
    const result =
      input.prepared !== undefined
        ? analyzePreparedContent(input.prepared, meta)
        : analyzeContent(meta)
    const checks = result.checks
      .filter((check) => check.group === 'keyword')
      .map((check) =>
        input.source === 'tree' &&
        check.id === ALT_DEPENDENT_CHECK_ID &&
        check.status !== 'na'
          ? { ...check, status: 'na' as const, score: 0, detail: DETAIL_ALT_UNKNOWABLE }
          : check,
      )
    let score = 0
    let max = 0
    for (const check of checks) {
      if (check.status === 'na') continue
      score += check.score
      max += check.max
    }
    return {
      keyword,
      score: Math.round(score * 100) / 100,
      max,
      rows: checks.map((check) => ({
        id: check.id,
        status: check.status,
        glyph: STATUS_GLYPHS[check.status],
        detail: check.detail,
      })),
    }
  })
}

// ---------------------------------------------------------------------------
// Tier-tagged analysis display (license-downgrade fix)
// ---------------------------------------------------------------------------

/**
 * The panel's analysis state, tagged with the tier it was COMPUTED under.
 * A license flip must not wait for the next debounced recompute to change
 * what renders — the tag lets rendering suppress Pro presentation
 * instantly whenever the computed tier disagrees with the current one.
 */
export interface TierTaggedAnalysis {
  /** `proUnlocked` at compute time. */
  proUnlocked: boolean
  view: AnalysisView | null
  keywordViews: KeywordAnalysisView[] | null
}

export interface AnalysisDisplay {
  view: AnalysisView | null
  /** Suppressed (null) whenever computed tier !== current tier. */
  keywordViews: KeywordAnalysisView[] | null
  /**
   * Presentation tier: Pro ONLY when the state was computed under Pro AND
   * the license is still Pro now. Any mismatch falls back to the locked
   * presentation of the aggregate (ProLock shown, per-keyword hidden)
   * until the recompute lands.
   */
  proUnlocked: boolean
}

/** Resolve what the analysis section renders for the CURRENT license tier. */
export function analysisDisplayForTier(
  state: TierTaggedAnalysis | null,
  currentProUnlocked: boolean,
): AnalysisDisplay {
  if (state === null) {
    return { view: null, keywordViews: null, proUnlocked: currentProUnlocked }
  }
  const tierMatches = state.proUnlocked === currentProUnlocked
  return {
    view: state.view,
    keywordViews: tierMatches ? state.keywordViews : null,
    proUnlocked: currentProUnlocked && state.proUnlocked,
  }
}

// ---------------------------------------------------------------------------
// License refetch gate (focus/visibilitychange storm fix)
// ---------------------------------------------------------------------------

/** Minimum interval between /license refetches (focus + visibility fire together). */
export const LICENSE_REFETCH_MIN_INTERVAL_MS = 5000

/**
 * Coalescing + throttling wrapper for the license refetch: while a fetch
 * is IN FLIGHT every caller gets that same promise (focus and
 * visibilitychange firing back-to-back share one request), and after it
 * settles a new fetch is allowed only once `minIntervalMs` has elapsed
 * since the last START (earlier calls resolve immediately as no-ops).
 * Purely a request-rate gate — the panel's generation guards on the state
 * commit are unchanged.
 */
export function createLicenseRefetchGate(
  minIntervalMs: number = LICENSE_REFETCH_MIN_INTERVAL_MS,
  now: () => number = Date.now,
): (refetch: () => Promise<void>) => Promise<void> {
  let inflight: Promise<void> | null = null
  let lastStart: number | null = null
  return (refetch) => {
    if (inflight !== null) return inflight
    const t = now()
    if (lastStart !== null && t - lastStart < minIntervalMs) return Promise.resolve()
    lastStart = t
    const run = refetch().finally(() => {
      inflight = null
    })
    inflight = run
    return run
  }
}

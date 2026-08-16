/**
 * SERP preview model (task 1.5) — pure functions that turn the panel's
 * current meta + config into what Google's result snippet would show.
 *
 * Reuses the SERVER merge chain (`mergeSeoMeta`, server/metaBlock.ts) so
 * the preview title resolves exactly the way publish will bake it:
 * per-entry title verbatim → table title template → site default template
 * → the host's own <title> (which the panel passes in as `pageTitle`,
 * mirroring the publisher's `settings.metaTitle ?? page.title ?? site.name`
 * chain — vendor/Instatic src/core/publisher/render.ts:326).
 *
 * No React, no SDK imports — unit-tests under plain `bun test` and bundles
 * into the browser editor bundle unchanged.
 */

import { mergeSeoMeta, normalizeSiteOrigin } from '../../server/metaBlock'
import type { SeoMetaPayload } from '../../server/seoMeta'
import type { SeoConfigData } from '../../server/seoConfig'

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

export type SerpDevice = 'desktop' | 'mobile'

/**
 * Display limits, in Unicode code points. Google truncates by pixel
 * width, not characters — these are the conventional count approximations
 * (title ~600 px ≈ 60 chars; descriptions ~160 desktop / ~120 mobile).
 */
export const SERP_TITLE_LIMIT = 60
export const SERP_DESCRIPTION_LIMIT: Record<SerpDevice, number> = {
  desktop: 160,
  mobile: 120,
}

/** Input-hint budgets shown next to the panel fields. */
export const TITLE_RECOMMENDED_MAX = SERP_TITLE_LIMIT
export const DESCRIPTION_RECOMMENDED_MAX = SERP_DESCRIPTION_LIMIT.desktop

export interface Truncation {
  text: string
  truncated: boolean
}

/**
 * Whitespace-collapse, then truncate to at most `max` CODE POINTS,
 * cutting on a word boundary when one exists inside the budget and
 * appending an ellipsis. The ellipsis counts toward the budget. A single
 * over-long word is hard-cut rather than overflowing.
 *
 * Measuring and slicing happen in code points (`Array.from`), never
 * UTF-16 units — an emoji (or any astral character) at the cut position
 * can never be split into a dangling surrogate half. Degenerate budgets:
 * `max <= 0` returns `''`, `max === 1` returns just `'…'` (both flagged
 * `truncated: true` when the input overflowed) — the ellipsis is the only
 * thing that fits the budget.
 */
export function truncateAtWordBoundary(text: string, max: number): Truncation {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const points = Array.from(collapsed)
  if (points.length <= max) return { text: collapsed, truncated: false }
  if (max <= 0) return { text: '', truncated: true }
  if (max === 1) return { text: '…', truncated: true }
  const budget = max - 1 // reserve one code point for the ellipsis
  const slice = points.slice(0, budget + 1) // +1: a space AT the boundary counts
  const lastSpace = slice.lastIndexOf(' ')
  const cutPoints = lastSpace > 0 ? slice.slice(0, lastSpace) : points.slice(0, budget)
  return { text: `${cutPoints.join('').replace(/[\s.,;:!?-]+$/, '')}…`, truncated: true }
}

// ---------------------------------------------------------------------------
// URL line
// ---------------------------------------------------------------------------

/**
 * Google-style URL line: `example.com › parent › child`. Uses the
 * configured site origin (scheme stripped) when it validates as a bare
 * origin; falls back to a plain `/slug` path when none is configured.
 * An empty slug renders the bare origin (homepage).
 */
export function buildSerpUrlLine(siteUrl: string | undefined, slug: string): string {
  const origin = normalizeSiteOrigin(siteUrl)
  const segments = slug.split('/').filter((s) => s !== '')
  if (origin === undefined) {
    return segments.length > 0 ? `/${segments.join('/')}` : '/'
  }
  const host = origin.replace(/^https?:\/\//i, '')
  return segments.length > 0 ? `${host} › ${segments.join(' › ')}` : host
}

// ---------------------------------------------------------------------------
// Preview resolution
// ---------------------------------------------------------------------------

export type SerpTitleSource = 'entry' | 'template' | 'page'
export type SerpDescriptionSource = 'entry' | 'site' | 'none'

export interface SerpPreviewInput {
  /** Per-entry meta as currently edited in the panel (unsaved edits included). */
  meta: SeoMetaPayload
  /** The /config document (site defaults + table templates). */
  config: SeoConfigData
  /** Table the entry belongs to (`pages` in the site editor). */
  tableSlug: string
  /** The page's URL slug. */
  slug: string
  /**
   * What the host bakes into <title> absent SEO decoration:
   * `site.settings.metaTitle ?? page.title ?? site.name`
   * (vendor/Instatic src/core/publisher/render.ts:326). Feeds `%title%`.
   */
  pageTitle?: string
  device: SerpDevice
}

export interface SerpPreview {
  title: Truncation
  titleSource: SerpTitleSource
  description: Truncation
  descriptionSource: SerpDescriptionSource
  urlLine: string
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined
}

/**
 * Resolve the full SERP snippet. Title fallback chain matches publish
 * exactly (via `mergeSeoMeta`); when the merge chain produces no title
 * (no override, no template anywhere) the host's own <title> stands, so
 * the preview falls back to `pageTitle`, then the slug.
 */
export function buildSerpPreview(input: SerpPreviewInput): SerpPreview {
  const merged = mergeSeoMeta(input.meta, input.config, {
    tableSlug: input.tableSlug,
    slug: input.slug,
    pageTitle: input.pageTitle,
  })

  const titleText = merged.title ?? nonEmpty(input.pageTitle) ?? input.slug
  const titleSource: SerpTitleSource =
    nonEmpty(input.meta.title) !== undefined
      ? 'entry'
      : merged.title !== undefined
        ? 'template'
        : 'page'

  const descriptionText = merged.metaDescription ?? ''
  const descriptionSource: SerpDescriptionSource =
    nonEmpty(input.meta.metaDescription) !== undefined
      ? 'entry'
      : merged.metaDescription !== undefined
        ? 'site'
        : 'none'

  return {
    title: truncateAtWordBoundary(titleText, SERP_TITLE_LIMIT),
    titleSource,
    description: truncateAtWordBoundary(descriptionText, SERP_DESCRIPTION_LIMIT[input.device]),
    descriptionSource,
    urlLine: buildSerpUrlLine(input.config.site?.siteUrl, input.slug),
  }
}

/**
 * Social share preview model (task 3.4) — pure functions that turn the
 * panel's RESOLVED meta values into what a Facebook / X share card would
 * show. Mirrors the SERP preview's discipline (admin/lib/serp.ts): the
 * fallback logic reuses the exact server rules — og:title falls back to
 * the resolved title and og:description to the resolved description
 * (server/metaBlock.ts `buildSeoHeadPayload`), and og:image resolves
 * site-relative paths against the configured origin via the SAME
 * `resolveAbsoluteUrl` helper publish uses — so the preview can never
 * drift from what the head bake emits.
 *
 * Inputs are POST-fallback: the panel hands in the resolved display
 * title/description (the same values the SERP preview shows), plus the
 * raw og overrides. This module only applies the og→resolved precedence
 * and the platform truncation — it never re-runs the merge chain.
 *
 * No React, no SDK imports — unit-tests under plain `bun test` and
 * bundles into the browser editor bundle unchanged.
 */

import { normalizeSiteOrigin, resolveAbsoluteUrl } from '../../server/metaBlock'
import type { TwitterCard } from '../../server/seoMeta'
import { truncateAtWordBoundary } from '../../admin/lib/serp'

// ---------------------------------------------------------------------------
// Truncation — research-free count approximations of the platforms' real
// (pixel/line-based) clipping. Both platforms clamp by rendered lines, not
// characters; these budgets are the conventional counts previews use.
// ---------------------------------------------------------------------------

/**
 * Facebook link-card budgets (code points): titles clip around ~88
 * characters in the feed card; descriptions show roughly one–two lines,
 * conventionally approximated at ~110 characters. Deliberately coarse —
 * no per-pixel logic (task rule).
 */
export const FB_TITLE_LIMIT = 88
export const FB_DESCRIPTION_LIMIT = 110

/**
 * X (Twitter) large-summary-card budgets (code points): card titles clip
 * around ~70 characters; descriptions around ~125 (two lines when shown
 * at all). Same coarse-approximation policy as Facebook.
 */
export const X_TITLE_LIMIT = 70
export const X_DESCRIPTION_LIMIT = 125

export interface SocialTruncation {
  title: string
  description: string
}

/**
 * Facebook display strings: whitespace-collapsed, word-boundary truncated
 * with an ellipsis (shared `truncateAtWordBoundary` — the exact SERP
 * preview mechanics, including code-point measuring so an emoji at the
 * cut can never split into surrogate halves).
 */
export function truncateForFacebook(title: string, desc: string): SocialTruncation {
  return {
    title: truncateAtWordBoundary(title, FB_TITLE_LIMIT).text,
    description: truncateAtWordBoundary(desc, FB_DESCRIPTION_LIMIT).text,
  }
}

/** X display strings — same mechanics, X's budgets. */
export function truncateForX(title: string, desc: string): SocialTruncation {
  return {
    title: truncateAtWordBoundary(title, X_TITLE_LIMIT).text,
    description: truncateAtWordBoundary(desc, X_DESCRIPTION_LIMIT).text,
  }
}

// ---------------------------------------------------------------------------
// Card resolution
// ---------------------------------------------------------------------------

/** The subset of the component props the pure resolver reads. */
export interface SocialCardInput {
  /** Resolved display title (post-fallback — what the SERP preview shows). */
  title: string
  /** Resolved display description (post-fallback; '' = none). */
  description: string
  /** Stored og:title override, if any. */
  ogTitle?: string
  /** Stored og:description override, if any. */
  ogDescription?: string
  /** Stored og:image URL — absolute or site-relative; may be empty. */
  ogImage?: string
  /**
   * Stored `twitter:card` override. Per-entry only — never templated,
   * never defaulted (server/metaBlock.ts:379): publish emits the tag ONLY
   * when it is stored, so an absent value keeps the preview on the large
   * card this mock has always shown.
   */
  twitterCard?: TwitterCard
  /** Bare site origin ('' when unconfigured). */
  siteUrl: string
}

export interface SocialCard {
  /** Resolved absolute image URL, or null when none can be emitted. */
  imageUrl: string | null
  /** Lowercased host from the site origin ('' when unconfigured/invalid). */
  host: string
  fbTitle: string
  fbDescription: string
  xTitle: string
  xDescription: string
  /**
   * Which X layout the stored meta would actually produce: `'summary'` is
   * the small square-thumbnail card, `'summary_large_image'` the wide one.
   * Reads the stored `twitterCard` so a page configured for the small card
   * never previews as something X will not show (t4-39).
   */
  xCard: TwitterCard
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined
}

/**
 * Lowercased host (hostname[:port]) from a configured site origin.
 * Validates through the server's `normalizeSiteOrigin` — a non-origin
 * value (path, userinfo, garbage) yields '' exactly like an unconfigured
 * site, never a half-parsed host.
 */
export function hostFromSiteUrl(siteUrl: string | undefined): string {
  const origin = normalizeSiteOrigin(siteUrl)
  if (origin === undefined) return ''
  return origin.replace(/^https?:\/\//i, '').toLowerCase()
}

/**
 * Resolve everything both cards render.
 *
 * Precedence per field (identical to the head bake — metaBlock.ts):
 * - card title: og:title override → resolved title.
 * - card description: og:description override → resolved description
 *   ('' stays '' — the cards render a muted "no description" state).
 * - image: `resolveAbsoluteUrl(ogImage, siteUrl)` — absolute http(s)
 *   passes through; a site-relative `/path` joins onto the configured
 *   origin; relative with no origin (or an empty/absent value) is null,
 *   matching publish emitting no og:image tag at all.
 */
/**
 * Why a stored og:image produced no previewable image (null = it resolved,
 * or none is stored — no hint to show):
 * - 'needs-site-url': the value IS a single-slash site-relative path and
 *   the site origin is missing/invalid — configuring the Site URL fixes it.
 * - 'unpreviewable': anything else unresolvable (protocol-relative,
 *   javascript:, non-http scheme, malformed) — a Site URL would NOT fix
 *   it, so the copy stays neutral instead of pointing at settings.
 */
export type MissingImageHint = 'needs-site-url' | 'unpreviewable' | null

export function missingImageHint(
  ogImage: string | undefined,
  siteUrl: string | undefined,
): MissingImageHint {
  const image = nonEmpty(ogImage)
  if (image === undefined) return null
  if (resolveAbsoluteUrl(image, nonEmpty(siteUrl)) !== undefined) return null
  const siteRelative = image.startsWith('/') && !image.startsWith('//')
  if (siteRelative && normalizeSiteOrigin(siteUrl) === undefined) return 'needs-site-url'
  return 'unpreviewable'
}

export function resolveSocialCard(input: SocialCardInput): SocialCard {
  const title = nonEmpty(input.ogTitle) ?? input.title
  const description = nonEmpty(input.ogDescription) ?? input.description
  const fb = truncateForFacebook(title, description)
  const x = truncateForX(title, description)
  return {
    imageUrl: resolveAbsoluteUrl(input.ogImage, nonEmpty(input.siteUrl)) ?? null,
    host: hostFromSiteUrl(nonEmpty(input.siteUrl)),
    fbTitle: fb.title,
    fbDescription: fb.description,
    xTitle: x.title,
    xDescription: x.description,
    // Unset = the large card, matching what this mock has always shown and
    // what the head bake leaves to X's own default (no tag is emitted).
    xCard: input.twitterCard === 'summary' ? 'summary' : 'summary_large_image',
  }
}

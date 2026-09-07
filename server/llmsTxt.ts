/**
 * llms.txt (task 2.2) — a markdown site index for AI crawlers, served from
 * a public plugin runtime route (`…/runtime/llms.txt`) because the
 * publisher emits no root-level files (G2, same serving model as the
 * sitemap — see ./sitemap.ts header).
 *
 * Follows the llmstxt.org shape:
 *
 *   # <site name>
 *
 *   > <one-line description>
 *
 *   ## Pages
 *
 *   - [<title>](<absolute url>)
 *
 * Inputs come from seo-config (siteName, metaDescription, siteUrl) and the
 * seo-sitemap page list (title + slug per published page). Pure builder —
 * unit-testable with no SDK imports.
 */

import {
  isEmittableEntry,
  mapEntriesWithinBudget,
  pageUrl,
  SITEMAP_ENTRY_MAX_CHARS,
  SITEMAP_URL_BUDGET_CHARS,
  SITEMAP_URL_CAP,
  type SitemapEntry,
} from './sitemap'

export interface LlmsTxtInput {
  /** Normalized bare origin (seo-config siteUrl) — REQUIRED by callers. */
  siteUrl: string
  siteName?: string
  description?: string
  entries: readonly SitemapEntry[]
  /** True when the storage read may have been truncated. */
  truncatedLoad?: boolean
  urlCap?: number
  /**
   * Per-entry length bound (default SITEMAP_ENTRY_MAX_CHARS): entries with
   * a longer SLUG are skipped (same rule as the sitemap, so the two
   * documents list the same pages) and longer titles/descriptions are
   * truncated. See the constant's comment in ./sitemap.
   */
  entryMaxChars?: number
  /** Aggregate encoded-URL budget (default SITEMAP_URL_BUDGET_CHARS). */
  urlBudgetChars?: number
}

/**
 * Truncate to `maxChars`, appending an ellipsis so the cut is visible in
 * the emitted document (silent caps forbidden). Returns the input
 * unchanged when it already fits.
 */
export function truncateForLlmsTxt(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
}

/**
 * Markdown link-text escaping: brackets would close the link label early;
 * collapse newlines so one entry stays one line.
 */
export function escapeMarkdownLabel(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Escape Markdown link-destination punctuation without changing the URL. */
export function escapeMarkdownDestination(url: string): string {
  return url.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/**
 * Build the llms.txt document. Deterministic: pages sorted by URL, same
 * cap as the sitemap, truncation always noted in the output (silent caps
 * forbidden). Falls back to the origin's host when no site name is set
 * and to the slug when a page has no stored title.
 */
export function buildLlmsTxt(input: LlmsTxtInput): string {
  const cap = input.urlCap ?? SITEMAP_URL_CAP
  const entryMax = input.entryMaxChars ?? SITEMAP_ENTRY_MAX_CHARS
  const heading = truncateForLlmsTxt(
    input.siteName?.trim() || input.siteUrl.replace(/^https?:\/\//i, ''),
    entryMax,
  )

  const lines: string[] = [`# ${escapeMarkdownLabel(heading)}`, '']
  const description = input.description?.trim()
  if (description) {
    lines.push(`> ${truncateForLlmsTxt(description.replace(/\s+/g, ' '), entryMax)}`, '')
  }

  // Per-entry length gate BEFORE any URL is built — same rule as
  // buildSitemapXml so both public documents list the same page set.
  const emittable = input.entries.filter((entry) => isEmittableEntry(entry, entryMax))
  const oversize = input.entries.length - emittable.length
  // Match sitemap.xml: choose budget survivors by the already-bounded raw
  // slug, never by storage order, then retain the existing URL sort below.
  emittable.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  // Same AGGREGATE encoded-output budget as buildSitemapXml (round-5
  // wave-2 O#4) — see SITEMAP_URL_BUDGET_CHARS.
  const { mapped, overBudget } = mapEntriesWithinBudget(
    emittable,
    (entry) => pageUrl(input.siteUrl, entry.slug),
    input.urlBudgetChars ?? SITEMAP_URL_BUDGET_CHARS,
  )
  const sorted = mapped.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
  const capped = sorted.slice(0, cap)

  lines.push('## Pages', '')
  for (const { entry, url } of capped) {
    const label = escapeMarkdownLabel(truncateForLlmsTxt(entry.title ?? entry.slug, entryMax))
    lines.push(`- [${label}](${escapeMarkdownDestination(url)})`)
  }
  if (sorted.length > cap) {
    lines.push('', `<!-- truncated: showing ${cap} of ${sorted.length} pages (cap ${cap}) -->`)
  }
  if (oversize > 0) {
    lines.push(
      '',
      `<!-- skipped: ${oversize} page${oversize === 1 ? '' : 's'} with a slug longer than ${entryMax} characters -->`,
    )
  }
  if (overBudget > 0) {
    lines.push(
      '',
      `<!-- skipped: ${overBudget} page${overBudget === 1 ? '' : 's'} past the ${input.urlBudgetChars ?? SITEMAP_URL_BUDGET_CHARS}-character total URL budget -->`,
    )
  }
  if (input.truncatedLoad === true) {
    lines.push('', '<!-- warning: page index read hit the storage list cap; the list may be incomplete -->')
  }
  return lines.join('\n') + '\n'
}

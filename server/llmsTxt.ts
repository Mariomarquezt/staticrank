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

import { pageUrl, SITEMAP_URL_CAP, type SitemapEntry } from './sitemap'

export interface LlmsTxtInput {
  /** Normalized bare origin (seo-config siteUrl) — REQUIRED by callers. */
  siteUrl: string
  siteName?: string
  description?: string
  entries: readonly SitemapEntry[]
  /** True when the storage read may have been truncated. */
  truncatedLoad?: boolean
  urlCap?: number
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

/**
 * Build the llms.txt document. Deterministic: pages sorted by URL, same
 * cap as the sitemap, truncation always noted in the output (silent caps
 * forbidden). Falls back to the origin's host when no site name is set
 * and to the slug when a page has no stored title.
 */
export function buildLlmsTxt(input: LlmsTxtInput): string {
  const cap = input.urlCap ?? SITEMAP_URL_CAP
  const heading = input.siteName?.trim() || input.siteUrl.replace(/^https?:\/\//i, '')

  const lines: string[] = [`# ${escapeMarkdownLabel(heading)}`, '']
  const description = input.description?.trim()
  if (description) {
    lines.push(`> ${description.replace(/\s+/g, ' ')}`, '')
  }

  const sorted = [...input.entries]
    .map((entry) => ({ entry, url: pageUrl(input.siteUrl, entry.slug) }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
  const capped = sorted.slice(0, cap)

  lines.push('## Pages', '')
  for (const { entry, url } of capped) {
    const label = escapeMarkdownLabel(entry.title ?? entry.slug)
    lines.push(`- [${label}](${url})`)
  }
  if (sorted.length > cap) {
    lines.push('', `<!-- truncated: showing ${cap} of ${sorted.length} pages (cap ${cap}) -->`)
  }
  if (input.truncatedLoad === true) {
    lines.push('', '<!-- warning: page index read hit the storage list cap; the list may be incomplete -->')
  }
  return lines.join('\n') + '\n'
}

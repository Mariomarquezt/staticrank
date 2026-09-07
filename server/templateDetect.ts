/**
 * templateDetect — is the publish.html context's pageId a TEMPLATE page?
 * (task 1.3 blocker fix). Pure module with an injected content-table
 * interface; no SDK imports.
 *
 * Why this matters: for data-row routes the filter context carries the
 * entry TEMPLATE's page id and slug, not the row's — `merged.id` /
 * `merged.slug` come from the innermost template
 * (vendor/Instatic src/core/templates/templateCompose.ts, return block:
 * "identifies what was rendered for the publish.html filter";
 * server/publish/publicRenderer.ts:194). Without detection, the filter's
 * `pages:<pageId>` lookup would resolve the TEMPLATE page's stored
 * seo-meta for EVERY row rendered through it — a canonical stored on the
 * template page would be stamped identically across all row pages.
 *
 * Why the flag is decisive: template pages are NEVER baked at their own
 * slug — `server/publish/publishSite.ts:231,269`: `if (!page ||
 * isTemplatePage(page)) continue // template pages only ever wrap; never
 * baked at their own slug`, where `isTemplatePage(page)` is
 * `page.template?.enabled === true` (src/core/templates/
 * templateMatching.ts:17-19), mapped from the pages row's
 * `templateEnabled` cell (src/core/data/pageFromRow.ts:11,73 and
 * pageToCells at :103). So a template-page pageId in the filter context
 * ALWAYS means a composed render (data row, or the notFound template) —
 * never a regular page — and the per-entry seo-meta tier must be
 * SKIPPED for it (template/site tiers still apply). Slug comparison
 * cannot detect this: the context slug for a row render IS the template
 * page's own slug (templateCompose.ts returns `slug: innermost.slug`).
 *
 * Failure posture: when the row cannot be read (missing entry, revoked
 * permission, storage error) the answer is `true` — i.e. SKIP the
 * per-entry tier. Losing a page's overrides for one publish is
 * recoverable; stamping one page's canonical across a whole table is
 * not. The template/site tiers are unaffected either way.
 *
 * Memoized in module state with the same TTL discipline as seoConfig
 * (the plugin VM persists across filter dispatches — one QuickJS VM per
 * plugin, pluginWorker.ts:61,129,342): one content lookup per pageId per
 * TTL window during a bake. The whole map is dropped on expiry, which
 * also bounds growth.
 */

export interface PagesTableLike {
  get: (entryId: string) => Promise<{
    cells: Record<string, unknown>
    /**
     * ISO row timestamps — the real `pages.get` ContentEntry always
     * carries them (ContentEntrySchema, vendor src/core/plugin-sdk/
     * contentSchemas.ts:89-90; mapped from the data_rows row by
     * rowToEntry, server/plugins/host/handlers/contentProjection.ts:
     * 196-197, as ISO strings via isoDate, repositories/data/rows/
     * mapper.ts:91-92). Optional in the structural type so existing
     * cells-only test doubles stay valid.
     */
    createdAt?: string
    updatedAt?: string
  } | null>
}

export interface TemplatePageInfo {
  /** True: composed render — the per-entry seo-meta tier must be skipped. */
  isTemplate: boolean
  /**
   * True when the template's target kind is `notFound` (task 2.4): this
   * render IS the site's 404 page — the ONLY injection point the 404
   * beacon has. Vendor evidence: `resolveNotFoundTemplate` matches pages
   * with `page.template?.target.kind === 'notFound'`
   * (src/core/templates/templateMatching.ts:73-79), the target riding the
   * pages row's `templateTarget` cell (src/core/data/pageFromRow.ts:12,76,
   * 104); the 404 render goes through `applyPublishedHtmlPipeline` with
   * that template page's id/slug (server/publish/publicRouter.ts:
   * renderNotFoundResponse → renderPublishedNotFound,
   * publicRenderer.ts:152-168). NOTE the 404 body is baked/cached ONCE
   * with a synthetic `/404` URL ("identical for every missed path" —
   * publicRouter.ts renderNotFoundResponse doc), so per-request
   * server-side 404 counting is impossible; only the browser tracker can
   * report the real missed path.
   */
  isNotFound?: boolean
  /**
   * For `postTypes` templates, the PRIMARY target table slug (first of
   * `templateTarget.tableSlugs` — mirrors `primaryTemplateTableSlug`,
   * src/core/templates/templateMatching.ts:27-31, "the overwhelmingly
   * common single-target case"). Lets the merge chain apply the ROW
   * table's title template (`tables.posts`, not `tables.pages`) to
   * data-row renders. Absent for everywhere/notFound templates and
   * regular pages.
   */
  targetTableSlug?: string
  /**
   * Row timestamps for NON-template pages (task 2.3 — schema.org
   * datePublished/dateModified), lifted from the SAME `pages.get` this
   * classifier already performs — zero extra lookups on the filter path
   * (G10). Absent for template classifications and unreadable rows.
   * `createdAt` is row creation; `updatedAt` is the last row update
   * (bumped by publishes too — publish.ts:284). The row's `publishedAt`
   * is deliberately NOT surfaced: it is overwritten with
   * current_timestamp on EVERY publish (vendor server/repositories/
   * publish.ts:281), so it cannot serve as a stable first-publication
   * date.
   */
  createdAt?: string
  updatedAt?: string
}

export const TEMPLATE_FLAG_CACHE_TTL_MS = 5_000

let cache: { infos: Map<string, TemplatePageInfo>; expiresAt: number } | null = null

/** Drop the memoized flags (tests; template edits are rare enough for TTL). */
export function invalidateTemplateFlagCache(): void {
  cache = null
}

/** cells.templateTarget as a plain object, or undefined. */
function readTemplateTarget(cells: Record<string, unknown>): Record<string, unknown> | undefined {
  const target = cells.templateTarget
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return undefined
  return target as Record<string, unknown>
}

/** cells.templateTarget → primary postTypes table slug, if any. */
function readTargetTableSlug(cells: Record<string, unknown>): string | undefined {
  const t = readTemplateTarget(cells)
  if (t === undefined || t.kind !== 'postTypes' || !Array.isArray(t.tableSlugs)) return undefined
  const first = t.tableSlugs[0]
  return typeof first === 'string' && first !== '' ? first : undefined
}

/**
 * Classify the context's pageId: template page (⇒ composed render, skip
 * the per-entry tier, optionally redirect the table tier to the target
 * table) or regular page. An unreadable row (missing entry, revoked
 * permission, storage error) classifies as a template — conservative:
 * skip the per-entry tier rather than risk the template-meta leak.
 */
export async function getTemplatePageInfo(
  table: PagesTableLike,
  pageId: string,
  now: number = Date.now(),
): Promise<TemplatePageInfo> {
  if (cache === null || now >= cache.expiresAt) {
    cache = { infos: new Map(), expiresAt: now + TEMPLATE_FLAG_CACHE_TTL_MS }
  }
  const generation = cache
  const cached = generation.infos.get(pageId)
  if (cached !== undefined) return cached

  let info: TemplatePageInfo
  try {
    const entry = await table.get(pageId)
    if (entry === null) {
      info = { isTemplate: true }
    } else if (entry.cells.templateEnabled === true) {
      const targetTableSlug = readTargetTableSlug(entry.cells)
      info = targetTableSlug !== undefined ? { isTemplate: true, targetTableSlug } : { isTemplate: true }
      if (readTemplateTarget(entry.cells)?.kind === 'notFound') info.isNotFound = true
    } else {
      info = { isTemplate: false }
      if (typeof entry.createdAt === 'string' && entry.createdAt !== '') {
        info.createdAt = entry.createdAt
      }
      if (typeof entry.updatedAt === 'string' && entry.updatedAt !== '') {
        info.updatedAt = entry.updatedAt
      }
    }
  } catch {
    info = { isTemplate: true }
  }
  // The lookup may have crossed a TTL boundary while awaiting storage. Do
  // not let the expired generation write into the replacement cache.
  if (cache === generation) generation.infos.set(pageId, info)
  return info
}

/** Convenience wrapper: just the boolean. */
export async function isTemplatePageId(
  table: PagesTableLike,
  pageId: string,
  now: number = Date.now(),
): Promise<boolean> {
  return (await getTemplatePageInfo(table, pageId, now)).isTemplate
}

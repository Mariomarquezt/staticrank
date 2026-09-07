/**
 * sitemap — storage-backed page list for `/sitemap.xml` + llms.txt (task 2.2).
 *
 * The publisher emits NO root-level files (DESIGN §7 G2), so the sitemap is
 * served from a PUBLIC plugin runtime route
 * (`/admin/api/cms/plugins/monkeywebs.seo/runtime/sitemap.xml` — plugin
 * routes are scoped under `/admin/api/cms/plugins/:id/runtime/<path>`,
 * vendor src/core/plugin-sdk/types/serverApi.ts:60-99; public access
 * dispatches with `user: null`, server/plugins/runtime.ts:209-256) and its
 * URL is submitted to engines directly (IndexNow — see ./indexNow.ts).
 *
 * Source of truth — per-page tracking off the publish pipeline. There is
 * NO site-level "publish completed" hook at pin 6b055cf78: `publish.before`
 * / `publish.after` fire PER PAGE inside `applyPublishedHtmlPipeline`
 * (vendor server/publish/publishedHtmlPipeline.ts:45-48,66-69) with
 * `{ siteId, pageId? }` only. So:
 *
 *   1. The `publish.html` FILTER (which does get `slug`) stashes
 *      `{ slug, title, noindex, fp }` for the pageId in MODULE STATE —
 *      zero storage writes on the filter path (G10 discipline).
 *   2. The `publish.after` EVENT handler pops the stash and reconciles the
 *      page's `seo-sitemap` record (hooks may write; one record per event,
 *      cleanup capped).
 *
 * Change detection: the pipeline also runs for LIVE renders and republish
 * (publicRouter.ts:272,336; republish.ts:69) — though NOT for editor
 * previews: the preview iframe explicitly skips publish.before/html/after
 * (previewRuntime.ts:106-111), and the only preview path through the
 * pipeline (data-row preview, handlers/cms/data/preview.ts:132) always
 * carries a template pageId, which the filter excludes. So "the filter
 * fired" must not mean "content changed" — a record is (re)written only
 * when the slug, title, or content fingerprint (FNV-1a over the composed
 * HTML, VERSION-NORMALIZED first — see `normalizeForFingerprint`)
 * actually differs; `lastmod` therefore tracks observed change, not
 * traffic. Noindexed pages are never listed: a stash with `noindex: true`
 * DELETES the page's records instead.
 *
 * Storage model (G10 discipline — no upsert/unique key at this pin):
 * flat scalar fields, one record per page keyed by `key = page:<pageId>`;
 * every read resolves duplicates newest-wins in memory; route reads are
 * memoized in module state (the plugin VM persists across dispatches).
 * Deletions of stale records happen only in hook/schedule handlers, capped.
 */

import { pageUrl } from './lib/pageUrl'

// ---------------------------------------------------------------------------
// Constants + shapes
// ---------------------------------------------------------------------------

/** Manifest resource id — must match instatic-plugin.config.ts. */
export const SEO_SITEMAP_RESOURCE_ID = 'seo-sitemap'

/** Record-key prefix: `page:<pageId>`. */
export const SITEMAP_PAGE_KEY_PREFIX = 'page:'

export function sitemapPageKey(pageId: string): string {
  return `${SITEMAP_PAGE_KEY_PREFIX}${pageId}`
}

/**
 * Flat record-data field ids, matching the `seo-sitemap` resource
 * declaration in instatic-plugin.config.ts.
 */
export const SEO_SITEMAP_FIELD_IDS = [
  'key',
  'pageId',
  'slug',
  'title',
  'lastmod',
  'fp',
  'pending',
  'imgTotal',
  'imgFindings',
] as const

/**
 * Hard cap on sitemap URLs. Protocol allows 50k; we stop far below the
 * 64 MB heap / 5 s eval budget. Truncation is NEVER silent — the XML
 * carries a comment when the cap (or a truncated storage read) bites.
 */
export const SITEMAP_URL_CAP = 5000

/**
 * Per-ENTRY length bound applied at the emission boundary (round-5 triage
 * E/t2-13). `SITEMAP_URL_CAP` bounds how MANY entries render, never how
 * many bytes each one costs: the host's page schema declares
 * `slug: Type.String()` with no max (vendor src/core/data/schemas.ts) and
 * `extractTitleText` stores whatever the page's <title> held, so 5,000
 * pathological multi-KB slugs/titles could exhaust the 64 MB QuickJS heap
 * while composing a PUBLIC response (sitemap.xml / llms.txt).
 *
 * Rule (shared by both documents so they can never disagree about which
 * pages exist): an entry whose SLUG exceeds this bound is SKIPPED — no
 * real route is 2,000 chars long, and the <loc> would be unusable anyway.
 * llms.txt additionally TRUNCATES over-long titles to this bound (a long
 * title is still a real page). Both are LOUD — the document carries a
 * comment whenever this bites, the same discipline SITEMAP_URL_CAP uses.
 */
export const SITEMAP_ENTRY_MAX_CHARS = 2000

/**
 * True when the entry may be emitted into a public document — i.e. its
 * slug fits `SITEMAP_ENTRY_MAX_CHARS`. Shared by buildSitemapXml and
 * buildLlmsTxt (see SITEMAP_ENTRY_MAX_CHARS).
 */
export function isEmittableEntry(
  entry: SitemapEntry,
  maxChars: number = SITEMAP_ENTRY_MAX_CHARS,
): boolean {
  return typeof entry.slug === 'string' && entry.slug.length <= maxChars
}

/**
 * AGGREGATE budget, in characters, for the percent-encoded URLs one public
 * document may retain (round-5 wave-2 O#4).
 *
 * `SITEMAP_ENTRY_MAX_CHARS` bounds each entry and `SITEMAP_URL_CAP` bounds
 * how many are RENDERED, but neither bounds the mapped set: the map runs
 * over EVERY emittable entry before the cap slices it, and `pageUrl`
 * percent-encodes (a non-ASCII BMP character becomes 9 characters). 5,000
 * maximum-length non-ASCII slugs therefore built ~90M characters of URL
 * (~180 MB) inside the map — past the 64 MB QuickJS heap, while composing
 * an anonymous public response.
 *
 * 2M characters is ~6x the worst REALISTIC document (5,000 URLs at ~60
 * encoded characters each is ~300K) and leaves the whole compose — mapped
 * URLs, the sorted array and the joined output — inside a few MB.
 */
export const SITEMAP_URL_BUDGET_CHARS = 2_000_000

/** One mapped entry plus its absolute, percent-encoded URL. */
export interface MappedSitemapEntry<E> {
  entry: E
  url: string
}

/**
 * Map entries to URLs while charging an AGGREGATE encoded-output budget:
 * building stops at the first URL that would push the running total past
 * `budget`, and the number of entries left unmapped is returned so the
 * caller can say so in the document (silent caps forbidden — the same
 * discipline as SITEMAP_URL_CAP and SITEMAP_ENTRY_MAX_CHARS).
 *
 * Entries are consumed in input order; the caller sorts what survives.
 * Budget exhaustion is therefore a pathological-content signal, not an
 * ordering guarantee — a document that drops entries here is one whose
 * slugs are already unusable as routes.
 */
export function mapEntriesWithinBudget<E>(
  entries: readonly E[],
  toUrl: (entry: E) => string,
  budget: number = SITEMAP_URL_BUDGET_CHARS,
): { mapped: MappedSitemapEntry<E>[]; overBudget: number } {
  const mapped: MappedSitemapEntry<E>[] = []
  let used = 0
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    const url = toUrl(entry)
    if (used + url.length > budget) return { mapped, overBudget: entries.length - i }
    used += url.length
    mapped.push({ entry, url })
  }
  return { mapped, overBudget: 0 }
}

/** Host storage list page size (StorageListOptionsSchema caps limit at 1000). */
export const SITEMAP_LIST_PAGE_SIZE = 1000

/** Max list pages fetched per load: cap / page size. */
export const SITEMAP_LIST_MAX_PAGES = Math.ceil(SITEMAP_URL_CAP / SITEMAP_LIST_PAGE_SIZE)

/** Route-read memo TTL — same discipline as seoConfig's reader. */
export const SITEMAP_CACHE_TTL_MS = 5_000

/** Per-invocation cap on record deletions in hook/schedule handlers. */
export const SITEMAP_CLEANUP_CAP = 25

/** One published page as tracked in storage. */
export interface SitemapEntry {
  pageId: string
  slug: string
  /** Baked <title> text (feeds llms.txt); absent when extraction failed. */
  title?: string
  /** ISO timestamp of the last OBSERVED content change. */
  lastmod?: string
  /** FNV-1a fingerprint of the composed HTML at last write. */
  fp?: string
  /** True while the URL awaits a successful IndexNow submission. */
  pending?: boolean
  /** Image-SEO audit of the last composed render (task 2.4): total <img>s. */
  imgTotal?: number
  /** …and how many audit findings they produced (server/lib/imageAudit.ts). */
  imgFindings?: number
}

/** What the publish.html filter stashes for publish.after (module state). */
export interface PageStash {
  slug: string
  title?: string
  noindex: boolean
  fp: string
  /** Image audit counts of the composed document (task 2.4) — the audit
   *  runs in the FILTER (which holds the HTML) so only two integers ride
   *  the stash, never the page itself. */
  imgTotal?: number
  imgFindings?: number
}

// ---------------------------------------------------------------------------
// Fingerprint — cheap change detection over the composed HTML
// ---------------------------------------------------------------------------

/**
 * Strip publish-version volatility before hashing (review fix #3). The
 * host stamps every publish with `nextPublishVersion`: module scripts get
 * `?v=<N>` query strings (moduleJsBundle injection) and hole shells carry
 * `data-instatic-version="<N>"` — both change on EVERY full publish even
 * when the page content did not. Hashing them would rewrite every record
 * and re-ping IndexNow on every publish. Normalization drops the numeric
 * `v` parameter from src/href attribute values and removes
 * data-instatic-version attributes;
 * other query parameters and everything else hashes verbatim.
 */
function withoutPublishVersion(value: string): string {
  const queryStart = value.indexOf('?')
  if (queryStart === -1) return value
  const fragmentStart = value.indexOf('#', queryStart + 1)
  const queryEnd = fragmentStart === -1 ? value.length : fragmentStart
  const query = value.slice(queryStart + 1, queryEnd)
  const parts = query.split('&')
  const kept = parts.filter((part) => !/^v=\d+$/i.test(part))
  if (kept.length === parts.length) return value
  const fragment = fragmentStart === -1 ? '' : value.slice(fragmentStart)
  return `${value.slice(0, queryStart)}${kept.length > 0 ? `?${kept.join('&')}` : ''}${fragment}`
}

export function normalizeForFingerprint(html: string): string {
  return html
    .replace(
      /(\s(?:src|href)\s*=\s*)(["'])([\s\S]*?)\2/gi,
      (_match: string, prefix: string, quote: string, value: string) =>
        `${prefix}${quote}${withoutPublishVersion(value)}${quote}`,
    )
    .replace(/\s+data-instatic-version="[^"]*"/gi, '')
}

/**
 * 32-bit FNV-1a over the string, hex-encoded. NOT cryptographic — it only
 * gates "did this page's bytes change since the last record write", where
 * a collision merely skips one lastmod bump. Chosen over crypto.subtle
 * (async host round-trip) to keep the filter path synchronous and cheap.
 * Callers hash `normalizeForFingerprint(html)`, never the raw document.
 */
export function contentFingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    // FNV prime 16777619 via shifts (32-bit overflow-safe in JS).
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// Record (de)serialization — defensive, newest-first-wins
// ---------------------------------------------------------------------------

function readString(data: Record<string, unknown>, field: string): string | undefined {
  const value = data[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** One record's data → entry, or undefined when malformed (never destroyed here). */
export function deserializeSitemapRecord(
  data: Record<string, unknown>,
): SitemapEntry | undefined {
  const key = readString(data, 'key')
  const pageId = readString(data, 'pageId')
  const slug = readString(data, 'slug')
  if (key === undefined || pageId === undefined || slug === undefined) return undefined
  if (key !== sitemapPageKey(pageId)) return undefined
  const entry: SitemapEntry = { pageId, slug }
  const title = readString(data, 'title')
  if (title !== undefined) entry.title = title
  const lastmod = readString(data, 'lastmod')
  if (lastmod !== undefined) entry.lastmod = lastmod
  const fp = readString(data, 'fp')
  if (fp !== undefined) entry.fp = fp
  if (data.pending === true) entry.pending = true
  const imgTotal = readCount(data, 'imgTotal')
  if (imgTotal !== undefined) entry.imgTotal = imgTotal
  const imgFindings = readCount(data, 'imgFindings')
  if (imgFindings !== undefined) entry.imgFindings = imgFindings
  return entry
}

/** Non-negative integer field, or undefined (defensive: storage data). */
function readCount(data: Record<string, unknown>, field: string): number | undefined {
  const value = data[field]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

export function serializeSitemapEntry(entry: SitemapEntry): Record<string, unknown> {
  const data: Record<string, unknown> = {
    key: sitemapPageKey(entry.pageId),
    pageId: entry.pageId,
    slug: entry.slug,
    pending: entry.pending === true,
  }
  if (entry.title) data.title = entry.title
  if (entry.lastmod) data.lastmod = entry.lastmod
  if (entry.fp) data.fp = entry.fp
  if (entry.imgTotal !== undefined) data.imgTotal = entry.imgTotal
  if (entry.imgFindings !== undefined) data.imgFindings = entry.imgFindings
  return data
}

// ---------------------------------------------------------------------------
// Write planning (publish.after) — pure, testable
// ---------------------------------------------------------------------------

export type SitemapWritePlan =
  | { action: 'none' }
  /** Delete every record for the page (page went noindex). */
  | { action: 'delete' }
  /** Create/update the page's record; `submit` = queue for IndexNow. */
  | { action: 'write'; data: Record<string, unknown>; submit: boolean }

/**
 * Decide what publish.after does for one page render. `existing` is the
 * newest stored entry for the page (undefined when none OR when the
 * stored record is malformed).
 *
 *   - noindex          → delete ALL of the page's records — even when the
 *                        newest failed to parse, so malformed leftovers
 *                        cannot keep a noindexed page listed (review #11);
 *                        the handler no-ops when nothing is stored.
 *   - new page         → write + submit.
 *   - slug/title/fp
 *     changed          → write + submit (lastmod bumps to `nowIso`).
 *   - unchanged        → none (live renders / byte-identical republishes
 *                        never touch storage — G10 write discipline).
 *
 * A still-pending record is rewritten as pending so an earlier failed
 * IndexNow submission is retried by the next flush.
 *
 * `onSlugMove` (wave 3.3, slug-move visibility — server/redirects/
 * hostMoves.ts): fired when a page's stored slug differs from the fresh
 * one on the (re)write path — the moment the page's public URL changed.
 * NOTE: page slug renames are NOT host-301'd at pin 6b055cf78 (evidence
 * in hostMoves.ts's header) — this is a "URL changed" observation only.
 * The plan stays synchronous, so the callback's promise is deliberately
 * NOT awaited and every failure (sync throw or rejection) is swallowed:
 * the observation must never break — or delay — a publish. Callers that
 * need durability should enqueue synchronously inside the callback.
 */
export function planSitemapWrite(
  existing: SitemapEntry | undefined,
  pageId: string,
  stash: PageStash,
  nowIso: string,
  onSlugMove?: (move: { pageId: string; fromSlug: string; toSlug: string }) => Promise<void>,
): SitemapWritePlan {
  if (stash.noindex) {
    return { action: 'delete' }
  }
  if (onSlugMove !== undefined && existing !== undefined && existing.slug !== stash.slug) {
    try {
      void onSlugMove({ pageId, fromSlug: existing.slug, toSlug: stash.slug }).catch(() => {
        // Swallowed: slug-move visibility is best-effort (see JSDoc).
      })
    } catch {
      // Swallowed: a synchronously-throwing callback must not break publish.
    }
  }
  const contentChanged =
    existing === undefined ||
    existing.slug !== stash.slug ||
    (existing.title ?? '') !== (stash.title ?? '') ||
    existing.fp !== stash.fp
  // Image counts (task 2.4): a count-only difference happens exactly once
  // per record — the post-upgrade backfill of pre-2.4 records (content
  // changes flip `fp` anyway). It rewrites the record WITHOUT bumping
  // lastmod and WITHOUT queueing IndexNow: no visitor-visible content
  // changed, so re-pinging engines for a bookkeeping backfill is wrong.
  // A stash WITHOUT image fields (audit failed / older caller) preserves
  // the stored counts rather than wiping them (review B2#8).
  const imgTotal = stash.imgTotal ?? existing?.imgTotal
  const imgFindings = stash.imgFindings ?? existing?.imgFindings
  const imgChanged =
    !contentChanged &&
    existing !== undefined &&
    (existing.imgTotal !== imgTotal || existing.imgFindings !== imgFindings)
  if (!contentChanged && !imgChanged) return { action: 'none' }
  const entry: SitemapEntry = {
    pageId,
    slug: stash.slug,
    fp: stash.fp,
    pending: contentChanged ? true : existing?.pending === true,
  }
  const lastmod = contentChanged ? nowIso : existing?.lastmod
  if (lastmod !== undefined) entry.lastmod = lastmod
  if (stash.title) entry.title = stash.title
  if (imgTotal !== undefined) entry.imgTotal = imgTotal
  if (imgFindings !== undefined) entry.imgFindings = imgFindings
  return { action: 'write', data: serializeSitemapEntry(entry), submit: contentChanged }
}

// ---------------------------------------------------------------------------
// URL building + XML rendering — pure, testable
// ---------------------------------------------------------------------------

/**
 * W3C-datetime check for <lastmod> (sitemaps.org requires W3C Datetime).
 * Stored values are server-written ISO strings, but records are storage
 * data — validate at the emission boundary anyway (review #12).
 */
const LASTMOD_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/

export function isValidLastmod(value: string): boolean {
  return LASTMOD_RE.test(value)
}

/** Escape the five XML-significant characters for element text. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Absolute public URL for a page slug — the SHARED helper (task 2.3):
 * `server/lib/pageUrl.ts` is the single (siteOrigin, slug) → URL mapping,
 * consumed by BOTH this sitemap builder and the schema.org graph wiring
 * so the two can never disagree about a page's URL. Re-exported here so
 * existing consumers (index.ts, tests) keep their import path.
 */
export { pageUrl }

export interface SitemapXmlOptions {
  /** True when the storage read may have been truncated (list-cap hit). */
  truncatedLoad?: boolean
  urlCap?: number
  /** Per-entry slug length bound (default SITEMAP_ENTRY_MAX_CHARS). */
  entryMaxChars?: number
  /** Aggregate encoded-URL budget (default SITEMAP_URL_BUDGET_CHARS). */
  urlBudgetChars?: number
}

/**
 * Render the <urlset> document. Deterministic output: entries are sorted
 * by URL. Caps are LOUD — an XML comment records cap truncation, entries
 * dropped for an over-long slug, and a possibly-truncated storage read
 * (silent caps forbidden).
 */
export function buildSitemapXml(
  entries: readonly SitemapEntry[],
  siteUrl: string,
  options: SitemapXmlOptions = {},
): string {
  const cap = options.urlCap ?? SITEMAP_URL_CAP
  const entryMax = options.entryMaxChars ?? SITEMAP_ENTRY_MAX_CHARS
  // Per-entry length gate BEFORE any URL is built: pageUrl percent-encodes
  // every segment (up to 9x the input), so an oversize slug must never
  // reach it. See SITEMAP_ENTRY_MAX_CHARS.
  const emittable = entries.filter((entry) => isEmittableEntry(entry, entryMax))
  const oversize = entries.length - emittable.length
  // Storage is newest-first, which is not a stable page order. Sort on the
  // already-bounded raw slug before URL mapping so budget survivors do not
  // depend on record order; the mapped survivors are still sorted by URL.
  emittable.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  // AGGREGATE encoded-output budget (round-5 wave-2 O#4): the per-entry
  // gate above bounds one slug, never the whole mapped set. See
  // SITEMAP_URL_BUDGET_CHARS.
  const { mapped, overBudget } = mapEntriesWithinBudget(
    emittable,
    (entry) => pageUrl(siteUrl, entry.slug),
    options.urlBudgetChars ?? SITEMAP_URL_BUDGET_CHARS,
  )
  const sorted = mapped
    .map(({ entry, url }) => ({ entry, loc: url }))
    .sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0))
  const capped = sorted.slice(0, cap)

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ]
  if (sorted.length > cap) {
    lines.push(`<!-- truncated: showing ${cap} of ${sorted.length} URLs (cap ${cap}) -->`)
  }
  if (oversize > 0) {
    lines.push(
      `<!-- skipped: ${oversize} entr${oversize === 1 ? 'y' : 'ies'} with a slug longer than ${entryMax} characters -->`,
    )
  }
  if (overBudget > 0) {
    lines.push(
      `<!-- skipped: ${overBudget} entr${overBudget === 1 ? 'y' : 'ies'} past the ${options.urlBudgetChars ?? SITEMAP_URL_BUDGET_CHARS}-character total URL budget -->`,
    )
  }
  if (options.truncatedLoad === true) {
    lines.push('<!-- warning: page index read hit the storage list cap; the list may be incomplete -->')
  }
  for (const { entry, loc } of capped) {
    const lastmod =
      entry.lastmod !== undefined && isValidLastmod(entry.lastmod)
        ? `<lastmod>${escapeXml(entry.lastmod)}</lastmod>`
        : ''
    lines.push(`<url><loc>${escapeXml(loc)}</loc>${lastmod}</url>`)
  }
  lines.push('</urlset>')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Memoized entry loader — structural collection interface, injectable
// ---------------------------------------------------------------------------

export interface SitemapRecordLike {
  id: string
  data: Record<string, unknown>
}

/** Structural subset of `api.cms.storage.collection('seo-sitemap')`. */
export interface SitemapCollectionLike {
  list: (options?: {
    filter?: Record<string, unknown>
    limit?: number
    offset?: number
  }) => Promise<{ records: SitemapRecordLike[] }>
  create: (data: Record<string, unknown>) => Promise<unknown>
  update: (recordId: string, data: Record<string, unknown>) => Promise<unknown>
  delete: (recordId: string) => Promise<unknown>
}

export interface SitemapLoad {
  entries: SitemapEntry[]
  /** True when the paged read stopped at its cap — the list may be partial. */
  truncated: boolean
}

let cache: { load: SitemapLoad; expiresAt: number; generation: number } | null = null
let cacheGeneration = 0

/** Drop the memoized entry list — call after any seo-sitemap write in this VM. */
export function invalidateSitemapCache(): void {
  cacheGeneration++
  cache = null
}

/**
 * Group raw records newest-first-wins by key into entries. Relies on the
 * repository's default `created_at desc` list order (same contract
 * seoConfig's reader documents). Malformed records are skipped.
 */
export function entriesFromRecords(records: readonly SitemapRecordLike[]): SitemapEntry[] {
  const seen = new Set<string>()
  const entries: SitemapEntry[] = []
  for (const record of records) {
    const entry = deserializeSitemapRecord(record.data)
    if (entry === undefined) continue
    const key = sitemapPageKey(entry.pageId)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(entry)
  }
  return entries
}

/**
 * Load all sitemap entries — READ-ONLY, paged (offset pagination is
 * supported at this pin: StorageListOptionsSchema has `offset`,
 * vendor src/core/plugin-sdk/storageSchemas.ts:85-87), memoized for the
 * public routes so a crawler hammering /sitemap.xml costs one storage
 * sweep per TTL window, not per request.
 */
export async function loadSitemapEntries(
  collection: SitemapCollectionLike,
  now: number = Date.now(),
): Promise<SitemapLoad> {
  if (cache !== null && now < cache.expiresAt) return cache.load

  const generation = cacheGeneration
  const records: SitemapRecordLike[] = []
  let truncated = false
  for (let page = 0; page < SITEMAP_LIST_MAX_PAGES; page++) {
    const { records: batch } = await collection.list({
      limit: SITEMAP_LIST_PAGE_SIZE,
      offset: page * SITEMAP_LIST_PAGE_SIZE,
    })
    records.push(...batch)
    if (batch.length < SITEMAP_LIST_PAGE_SIZE) break
    if (page === SITEMAP_LIST_MAX_PAGES - 1) truncated = true
  }

  const load: SitemapLoad = { entries: entriesFromRecords(records), truncated }
  if (generation === cacheGeneration) {
    cache = { load, expiresAt: now + SITEMAP_CACHE_TTL_MS, generation }
  }
  return load
}

/**
 * Newest stored record for one page key (plus stale duplicates, oldest
 * last) — used by the publish.after writer. Small filtered list; never
 * cached (the writer must see fresh state).
 */
export async function listSitemapRecordsForKey(
  collection: SitemapCollectionLike,
  key: string,
): Promise<SitemapRecordLike[]> {
  const { records } = await collection.list({ filter: { key }, limit: 100 })
  return records
}

// ---------------------------------------------------------------------------
// Stale-record reconcile (schedule handler) — pure per-record verdict
// ---------------------------------------------------------------------------

/** What the reconcile tick needs to know about a page row (or its absence). */
export interface ReconcilePageInfo {
  status: string
  cells: Record<string, unknown>
}

/** Batch of sitemap records reconciled per maintenance tick (cursor-paged). */
export const RECONCILE_BATCH_SIZE = 100

/**
 * Should this sitemap record be pruned, given the page row it points at
 * (`null` = the row no longer exists)? Verdict per record — the tick
 * walks records in cursor-paged batches (review #5) and looks each page
 * up individually via `api.cms.content.table('pages').get(pageId)`
 * (ContentEntry carries `status` + `cells` — vendor contentSchemas.ts:
 * 81-93), so no complete-listing precondition exists any more.
 *
 * Pruned when: the record is malformed; the page is gone; the page is not
 * `published` (published→draft reverts MUST drop out of the sitemap —
 * review blocker #2; status values per ContentListOptionsSchema,
 * contentSchemas.ts:118-123); or the page is a template
 * (`templateEnabled` cell — templates never bake at their own slug).
 */
export function shouldPruneRecord(
  record: SitemapRecordLike,
  page: ReconcilePageInfo | null,
): boolean {
  const entry = deserializeSitemapRecord(record.data)
  if (entry === undefined) return true // malformed/keyless garbage
  if (page === null) return true
  if (page.status !== 'published') return true
  if (page.cells.templateEnabled === true) return true
  return false
}

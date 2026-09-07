// See instatic-plugin.config.ts for why the SDK is imported by absolute path
// instead of '@instatic/plugin-sdk' (no published package at this pin; the
// '@core/plugin-sdk' tsconfig alias only resolves inside the monorepo).
import type { ServerPluginApi, ServerPluginModule } from '../vendor-sdk'
import {
  INDEXNOW_KEY_ROUTE,
  buildIndexNowPayload,
  generateIndexNowKey,
  shouldFlushIndexNow,
  submitIndexNow,
  INDEXNOW_URLS_PER_POST,
  type FetchLike,
} from './indexNow'
import { buildLlmsTxt } from './llmsTxt'
import { composePublishHtml, extractTitleText, normalizeSiteOrigin } from './metaBlock'
import {
  ANALYTICS_PATH_CAP,
  BEACON_RATE_PER_MIN,
  BEACON_ROUTE,
  BeaconAggregator,
  NOTFOUND_BEACON_ROUTE,
  NOTFOUND_PATH_CAP,
  NOTFOUND_RATE_PER_MIN,
  SEO_ANALYTICS_RESOURCE_ID,
  SEO_NOTFOUND_RESOURCE_ID,
  TokenBucket,
  beaconEndpoint,
  beaconPath,
  buildAnalyticsConfigTag,
  buildStatsPayload,
  deserializeDayCounts,
  mergeDayCounts,
  newestDayTotals,
  pruneExpiredDayRecords,
  serializeDayCounts,
  type DayCollectionLike,
  type DrainedDay,
} from './analytics'
import { allowInlineScripts, extractImportmapText, planInlineCsp } from './lib/cspPatch'
import { auditImages } from './lib/imageAudit'
// Codex-worker contract (task 2.4): `server/lib/trackerPayload.ts` lands
// from the tracker worktree at merge and exports
// `parseTrackerBeacon(raw) → {t,u,r,w,s} | null` (validated,
// length-capped). Until it lands, scripts/build.ts stages a loud
// placeholder into the BUILD COPY only, so lint/build stay green; the
// unit suite never loads this entrypoint (tests import the pure modules).
import { MAX_BEACON_RAW_LENGTH, parseTrackerBeacon } from './lib/trackerPayload'
import {
  SEO_CONFIG_RESOURCE_ID,
  analyticsEnabled,
  deserializeSeoConfigRecords,
  hasExplicitConfigSection,
  healSeoConfigDuplicates,
  indexNowEnabled,
  invalidateSeoConfigCache,
  loadSeoConfig,
  planSeoConfigReplace,
  resolveConfigSections,
  serializeSeoConfig,
  isSeoConfigRequestBodyWithinLimit,
  validateSeoConfig,
} from './seoConfig'
import {
  SEO_STATE_RESOURCE_ID,
  clearIndexNowState,
  loadDecorationFailure,
  recordDecorationFailure,
  loadIndexNowState,
  loadReconcileCursor,
  patchIndexNowState,
  saveReconcileCursor,
  type StateCollectionLike,
} from './seoState'
import {
  RECONCILE_BATCH_SIZE,
  SEO_SITEMAP_RESOURCE_ID,
  SITEMAP_CLEANUP_CAP,
  buildSitemapXml,
  contentFingerprint,
  deserializeSitemapRecord,
  invalidateSitemapCache,
  listSitemapRecordsForKey,
  loadSitemapEntries,
  normalizeForFingerprint,
  pageUrl,
  planSitemapWrite,
  shouldPruneRecord,
  sitemapPageKey,
  type PageStash,
  type ReconcilePageInfo,
  type SitemapEntry,
} from './sitemap'
import { getTemplatePageInfo } from './templateDetect'
import {
  SEO_META_RESOURCE_ID,
  SEO_META_CLEANUP_CAP,
  SEO_META_RECONCILE_BATCH_SIZE,
  SEO_META_RECONCILE_STATE_KEY,
  deserializeSeoMeta,
  isEmptySeoMeta,
  parseEntryRef,
  parseJsonBody,
  parseSeoMetaStorageKey,
  seoMetaKey,
  serializeSeoMeta,
  isSeoMetaRequestBodyWithinLimit,
  validateSeoMeta,
  type FieldError,
} from './seoMeta'
// Task 3.2: ALL Pro wiring (MCP endpoint, token routes, job tick) lives in
// ./pro — the free build stages a no-op stub there, so index.ts stays
// tier-agnostic and the free zip carries zero Pro code.
import { registerPro, tickPro } from './pro'
// Task 3.3 FREE tier: host slug-move visibility only. hostMoves.ts is
// deliberately free of store/routes imports so the free bundle never
// carries Pro redirect code (build-split discipline).
import { makeHostMovesHandler, recordSlugMove } from './redirects/hostMoves'

/**
 * Server entrypoint for the Instatic SEO plugin (tasks 1.2 + 1.3).
 *
 * Task 1.3 adds the heart of the plugin: the `publish.html` filter
 * (`api.cms.hooks.filter` — SDK types/hooks.ts:92-104, gated by the
 * `cms.hooks` manifest permission, protocol/targets.ts:49). On every
 * page publish the host dispatches the fully rendered document plus
 * `{ siteId, pageId, slug }` context (publishedHtmlPipeline.ts:61-65,
 * spike G1) and the handler must return the (possibly transformed) HTML
 * string. Pages ARE data rows of the system `pages` table
 * (migrations-sqlite.ts:241; `pageRowId` in repositories/publish.ts:44),
 * so `pageId` doubles as the entryId — per-entry meta for a regular page
 * lives under key `pages:<pageId>`, exactly what the /meta admin routes
 * store for `?table=pages&entry=<pageId>`.
 *
 * Data-row limitation (G1): for data-row routes the filter context
 * carries the entry TEMPLATE's page id/slug (publicRenderer.ts:194), so
 * per-ROW meta is not addressable at this pin — rows get the merge
 * chain's template/site tiers only; first-class per-row overrides wait
 * on the upstream context PR. To keep template-page meta from leaking
 * onto every row, the filter detects template pages (their pages row has
 * `templateEnabled: true`; such pages are never baked at their own slug
 * — publishSite.ts:231,269) via ./templateDetect.ts and SKIPS the
 * per-entry tier for them entirely.
 *
 * Merge chain per page (DESIGN §5.4): per-entry seo-meta record →
 * table title template → site defaults (seo-config), composed by
 * `mergeSeoMeta` + `buildSeoHeadPayload` (server/metaBlock.ts) and
 * applied with `applySeoHead`. With nothing stored anywhere the payload
 * is `{}` and the document passes through BYTE-IDENTICAL. The handler
 * never throws (hookBus would log and keep the unfiltered value —
 * hookBus.ts:178-182 — but a publish must never depend on that): any
 * unexpected error returns the input unchanged.
 *
 * Budget: at most two storage lookups per page (seo-config read is
 * memoized ~5 s in module state — the plugin VM persists across filter
 * calls, one QuickJS VM per plugin reused for every dispatch,
 * pluginWorker.ts:61,129,342 — and invalidated by config writes in this
 * VM), well inside the 5 s per-dispatch eval deadline (G7).
 *
 * Registers the per-entry seo_meta admin API on the authenticated route
 * surface (`api.cms.routes.authenticated.*` — any logged-in admin; the
 * host enforces the session BEFORE dispatching into the sandbox, see
 * vendor/Instatic server/plugins/runtime.ts:237-240). PUBLIC routes
 * (task 2.2 — dispatch with `user: null`, spike G7) serve only
 * public-by-nature documents: sitemap.xml, llms.txt, indexnow-key.txt.
 *
 * Route table (host prefix `/admin/api/cms/plugins/monkeywebs.seo/runtime`;
 * `table`/`entry` are validated query parameters — the host matches plugin
 * routes by exact path string, so there are no `:param` segments):
 *
 *   GET    /meta?table=<tableSlug>&entry=<entryId>
 *          → 200 stored meta payload, or `{}` when none is stored.
 *   POST   /meta?table=<tableSlug>&entry=<entryId>   (raw JSON body = meta)
 *          → full-replace write (PUT semantics; the SDK route surface has
 *            no PUT verb — vendor/Instatic src/core/plugin-sdk/types/
 *            routes.ts:5). 400 `{ errors: [{field,message}] }` for a
 *            missing/malformed/non-object body, validation failures, or an
 *            empty payload (`{}` — clearing is DELETE's job, so a body the
 *            host failed to parse can never destroy stored meta). 200 with
 *            the stored payload on success.
 *   DELETE /meta?table=<tableSlug>&entry=<entryId>
 *          → clears the entry's stored meta (all matching records — see the
 *            duplicate note below). Idempotent; 200 `{}` either way.
 *
 *   GET    /config
 *          → 200 the full config document `{ site?, tables? }` ({} when
 *            nothing is stored).
 *   POST   /config   (raw JSON body = config document)
 *          → SECTION-WISE replace (task 2.3): each top-level section
 *            (`site`/`tables`/`indexNow`/`schema`) whose key is PRESENT
 *            in the raw body replaces the stored one (present-but-empty
 *            = explicit clear of that section); ABSENT sections are
 *            carried forward untouched. 400 with field errors for
 *            malformed/invalid bodies or a body speaking no section at
 *            all (clearing everything is DELETE's job). 200 with the
 *            resolved stored document on success.
 *   DELETE /config
 *          → clears every seo-config record. Idempotent; 200 `{}`.
 *
 * POST parses `req.text()` itself instead of trusting `ctx.body`: the host
 * leaves its pre-parsed body as `{}` for malformed JSON / empty bodies /
 * JSON arrays / non-JSON content types (routeIo.ts:63-78), which is
 * indistinguishable from a real `{}`. All validation/serialization logic
 * lives in ./seoMeta.ts (pure, unit-tested); the handlers stay thin.
 */

function badRequest(errors: FieldError[]) {
  return {
    __response: true,
    status: 400,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ errors }),
  }
}

function seoMetaCollection(api: ServerPluginApi) {
  return api.cms.storage.collection(SEO_META_RESOURCE_ID)
}

function seoConfigCollection(api: ServerPluginApi) {
  return api.cms.storage.collection(SEO_CONFIG_RESOURCE_ID)
}

function sitemapCollection(api: ServerPluginApi) {
  return api.cms.storage.collection(SEO_SITEMAP_RESOURCE_ID)
}

function seoStateCollection(api: ServerPluginApi) {
  return api.cms.storage.collection(SEO_STATE_RESOURCE_ID)
}

function analyticsCollection(api: ServerPluginApi) {
  return api.cms.storage.collection(SEO_ANALYTICS_RESOURCE_ID)
}

function notFoundCollection(api: ServerPluginApi) {
  return api.cms.storage.collection(SEO_NOTFOUND_RESOURCE_ID)
}

export const MAINTENANCE_BUDGET_MS = 9_000

interface MaintenanceDeadline {
  clock: () => number
  expiresAt: number
}

interface MaintenanceRecordLike {
  id: string
  data: Record<string, unknown>
}

interface MaintenanceCollectionLike {
  list: (options?: {
    filter?: Record<string, unknown>
    orderBy?: Record<string, 'asc' | 'desc'>
    limit?: number
    offset?: number
  }) => Promise<{ records: MaintenanceRecordLike[] }>
  create: (data: Record<string, unknown>) => Promise<unknown>
  update: (recordId: string, data: Record<string, unknown>) => Promise<unknown>
  delete: (recordId: string) => Promise<unknown>
}

const MAINTENANCE_DEADLINE_REACHED = {}

function maintenanceHasTime(deadline: MaintenanceDeadline): boolean {
  return deadline.clock() < deadline.expiresAt
}

function requireMaintenanceTime(deadline: MaintenanceDeadline): void {
  if (!maintenanceHasTime(deadline)) throw MAINTENANCE_DEADLINE_REACHED
}

/** Some maintenance helpers issue several RPCs behind one call. Guarding
 * the collection makes the shared deadline apply to every one of them. */
function deadlineCollection(
  collection: MaintenanceCollectionLike,
  deadline: MaintenanceDeadline,
): MaintenanceCollectionLike {
  return {
    list: async (options) => {
      requireMaintenanceTime(deadline)
      return collection.list(options)
    },
    create: async (data) => {
      requireMaintenanceTime(deadline)
      return collection.create(data)
    },
    update: async (recordId, data) => {
      requireMaintenanceTime(deadline)
      return collection.update(recordId, data)
    },
    delete: async (recordId) => {
      requireMaintenanceTime(deadline)
      return collection.delete(recordId)
    },
  }
}

function maintenanceCollection(
  collection: ReturnType<ServerPluginApi['cms']['storage']['collection']>,
): MaintenanceCollectionLike {
  return collection as unknown as MaintenanceCollectionLike
}

// ---------------------------------------------------------------------------
// Task 2.4 module state — beacon aggregation + per-VM rate limiting
// ---------------------------------------------------------------------------

/**
 * In-memory beacon counters (G10: the PUBLIC beacon routes perform ZERO
 * storage writes — anonymous traffic must never drive write load). Counts
 * live here, day-bucketed per path, and the `seo-maintenance` tick drains
 * them into the `seo-analytics` / `seo-notfound` day records. A VM
 * restart loses at most one flush interval of counts (accepted — see
 * server/analytics.ts header). The token buckets are crude per-VM flood
 * gates; over-limit beacons are dropped silently (still 204).
 */
const pageViewCounts = new BeaconAggregator(ANALYTICS_PATH_CAP)
const notFoundCounts = new BeaconAggregator(NOTFOUND_PATH_CAP)
const pendingPageViewDays: DrainedDay[] = []
const pendingNotFoundDays: DrainedDay[] = []
const beaconBucket = new TokenBucket(BEACON_RATE_PER_MIN)
const notFoundBucket = new TokenBucket(NOTFOUND_RATE_PER_MIN)

/** Keep a drained bucket in module state until its write succeeds. The
 * analytics helper normally accepts loss on write failure, but a deliberate
 * deadline stop must be resumable rather than discard the drained counts. */
async function flushDayCountsWithinDeadline(
  aggregator: BeaconAggregator,
  pending: DrainedDay[],
  collection: DayCollectionLike,
  pathCap: number,
  deadline: MaintenanceDeadline,
): Promise<void> {
  if (pending.length === 0 && aggregator.hasCounts()) pending.push(...aggregator.drain())
  while (pending.length > 0) {
    requireMaintenanceTime(deadline)
    const drained = pending[0]!
    const { records } = await collection.list({
      filter: { key: `day:${drained.day}` },
      limit: 10,
    })
    const newest = records[0]
    const existing = newest !== undefined ? deserializeDayCounts(newest.data) : undefined
    const data = serializeDayCounts(mergeDayCounts(existing, drained, pathCap))
    requireMaintenanceTime(deadline)
    if (newest !== undefined) await collection.update(newest.id, data)
    else await collection.create(data)
    pending.shift()
  }
}

/** Beacon routes ALWAYS answer 204 — success, drop, and error alike. */
const NO_CONTENT = { __response: true, status: 204, headers: {}, body: '' }

// ---------------------------------------------------------------------------
// Task 2.2 module state — sitemap dirty tracking + IndexNow flush throttle
// ---------------------------------------------------------------------------

/**
 * publish.html → publish.after hand-off (see server/sitemap.ts header):
 * the FILTER gets `slug` but must not write storage; the `publish.after`
 * EVENT may write but gets no slug (`{ siteId, pageId? }` only —
 * publishedHtmlPipeline.ts:66-69). Both fire back-to-back in the same
 * pipeline, and the plugin VM persists across dispatches, so the filter
 * stashes per-page facts here and the event handler pops them.
 *
 * ACCEPTED RACE (review #4): there is no render correlation id at this
 * pin (folded into the G11 upstream ask), so two overlapping renders of
 * the SAME pageId can interleave filter/after and one after-handler may
 * observe the other render's stash — the damage is bounded to one
 * slightly-stale record write, self-corrected by the next publish. What
 * is NOT accepted (round-5 wave-2 O#1) is an after-handler consuming a
 * stash from an EARLIER, already-superseded render: every filter attempt
 * clears the page's slot before it runs (`clearPageStash`), so a stash
 * can only ever come from the render whose filter most recently ran. A VM
 * restart between filter and event loses the stash; the after-handler
 * no-ops on a missing stash and the page is re-tracked on its next
 * render. Bounded map: oldest entry evicted at the cap (entries are
 * popped by the very next event in the normal flow, so eviction only
 * bites after event loss).
 */
const pageStash = new Map<string, PageStash>()
const PAGE_STASH_CAP = 200

function stashPage(pageId: string, stash: PageStash): void {
  pageStash.delete(pageId) // re-insert at the tail so eviction stays LRU-ish
  if (pageStash.size >= PAGE_STASH_CAP) {
    const oldest = pageStash.keys().next().value
    if (oldest !== undefined) pageStash.delete(oldest)
  }
  pageStash.set(pageId, stash)
}

/**
 * Pages whose SEO decoration threw during this VM's lifetime. The filter
 * is read-only, so it only records the pageId here; `publish.after`
 * persists the count into `seo-state` where the admin can surface it.
 * Bounded like the page stash — a pathological run cannot grow it.
 */
const decorationFailures = new Set<string>()

function stashDecorationFailure(pageId: string): void {
  if (decorationFailures.size >= PAGE_STASH_CAP) return
  decorationFailures.add(pageId)
}

/** Drain the failures recorded since the last drain. */
export function takeDecorationFailures(): string[] {
  const ids = [...decorationFailures]
  decorationFailures.clear()
  return ids
}

function takePageStash(pageId: string): PageStash | undefined {
  const stash = pageStash.get(pageId)
  if (stash !== undefined) pageStash.delete(pageId)
  return stash
}

/**
 * Drop any stash the page is still carrying (round-5 wave-2 O#1).
 *
 * There is no render-correlation id at this pin, so a stash is only
 * trustworthy as "the render whose filter just ran". The filter therefore
 * clears the slot BEFORE it does anything that can throw: without this, a
 * filter that fails (or a render that is skipped for being a template)
 * leaves the PREVIOUS render's facts in place, and the publish.after that
 * follows consumes them as if they described the document just published.
 *
 * The concrete loss that motivated it: publish /old, let its publish.after
 * sitemap write fail (the catch re-stashes for the retry), rename the page
 * to /new, and let the /new filter fail — the /new publish.after would pop
 * the stale /old facts, write /old back into the sitemap and mark it
 * pending, queueing the obsolete URL for IndexNow.
 *
 * Cost, accepted: a failed filter now also discards a re-stashed retry.
 * That is the point — a render that could not be decorated cannot vouch
 * for the previous render's slug/fingerprint either, and the page is
 * re-tracked on its next successful render.
 */
function clearPageStash(pageId: string): void {
  pageStash.delete(pageId)
}

/** Flush throttle + reentrancy guard (per VM; pending-ness itself is durable). */
let indexNowLastFlushAt: number | undefined
let indexNowInFlight = false

/**
 * Batched IndexNow flush — called ONLY from the `seo-maintenance`
 * schedule tick (review #8: the publish path performs no network I/O; it
 * just marks records pending). One POST of up to INDEXNOW_URLS_PER_POST
 * URLs per flush; on success exactly the submitted records are cleared,
 * each re-verified against its CURRENT stored state first (review #6) so
 * a concurrent publish that re-marked a page pending is never un-marked.
 * Key + submission status live in the server-owned `seo-state` collection
 * (review #9/#10) — /config replaces and deletes cannot touch them.
 * Failures log-and-continue; the throttle guard stays as defense in
 * depth against overlapping schedule fires.
 */
async function flushIndexNow(
  api: ServerPluginApi,
  now: number,
  deadline: MaintenanceDeadline,
): Promise<void> {
  if (indexNowInFlight || !shouldFlushIndexNow(indexNowLastFlushAt, now)) return
  indexNowInFlight = true
  try {
    const configCollection = deadlineCollection(
      maintenanceCollection(seoConfigCollection(api)),
      deadline,
    )
    const config = await loadSeoConfig(configCollection)
    const siteUrl = normalizeSiteOrigin(config.site?.siteUrl)
    if (siteUrl === undefined || !indexNowEnabled(config)) return

    const collection = deadlineCollection(maintenanceCollection(sitemapCollection(api)), deadline)
    const { records } = await collection.list({ filter: { pending: true }, limit: 500 })
    const pending: Array<{ record: (typeof records)[number]; entry: SitemapEntry }> = []
    for (const record of records) {
      const entry = deserializeSitemapRecord(record.data)
      if (entry !== undefined && entry.pending === true) pending.push({ record, entry })
    }
    if (pending.length === 0) return
    indexNowLastFlushAt = now

    // Lazy key generation (QuickJS has no CSPRNG — see indexNow.ts header
    // for the Math.random quality caveat). Persisted to seo-state before
    // first use so the public key route serves it from then on;
    // loadIndexNowState also lifts legacy seo-config-embedded state.
    const stateCollection = deadlineCollection(
      maintenanceCollection(seoStateCollection(api)),
      deadline,
    )
    const state = await loadIndexNowState(stateCollection, configCollection)
    let key = state.key
    if (key === undefined) {
      key = generateIndexNowKey()
      await patchIndexNowState(stateCollection, { key })
    }

    const keyLocation = `${siteUrl}/admin/api/cms/plugins/${api.plugin.id}/runtime${INDEXNOW_KEY_ROUTE}`
    // Submit batch = clear batch (review #7): first N pending records.
    const batch = pending.slice(0, INDEXNOW_URLS_PER_POST)
    const urls = batch.map((item) => pageUrl(siteUrl, item.entry.slug))
    const payload = buildIndexNowPayload(siteUrl, key, keyLocation, urls)
    const nowIso = new Date(now).toISOString()
    if (payload === undefined) {
      const error = 'invalid IndexNow key'
      api.plugin.log('indexnow payload error:', error)
      await patchIndexNowState(stateCollection, {
        lastSubmittedAt: nowIso,
        lastStatus: `error: ${error}`,
      })
      return
    }

    requireMaintenanceTime(deadline)
    const result = await submitIndexNow(
      globalThis.fetch as unknown as FetchLike,
      payload,
      Math.max(1, deadline.expiresAt - deadline.clock()),
    )
    if (result.ok) {
      // Review #6: RE-READ before clearing. A publish that landed during
      // the POST re-marked its record (or rewrote slug/fp); clear only
      // records whose current stored state still matches what was
      // submitted — anything newer stays pending for the next flush
      // (IndexNow tolerates duplicate submissions).
      const { records: freshRecords } = await collection.list({
        filter: { pending: true },
        limit: 500,
      })
      const freshByKey = new Map<
        string,
        { record: (typeof freshRecords)[number]; entry: SitemapEntry }
      >()
      for (const record of freshRecords) {
        const entry = deserializeSitemapRecord(record.data)
        if (entry === undefined) continue
        const recordKey = sitemapPageKey(entry.pageId)
        if (!freshByKey.has(recordKey)) freshByKey.set(recordKey, { record, entry })
      }
      for (const item of batch) {
        const current = freshByKey.get(sitemapPageKey(item.entry.pageId))
        if (
          current !== undefined &&
          current.entry.slug === item.entry.slug &&
          current.entry.fp === item.entry.fp
        ) {
          await collection.update(current.record.id, { ...current.record.data, pending: false })
        }
      }
      invalidateSitemapCache()
      await patchIndexNowState(stateCollection, {
        lastSubmittedAt: nowIso,
        lastStatus: `ok ${result.status} (${payload.urlList.length} urls)`,
      })
    } else {
      api.plugin.log('indexnow submission failed:', result.error ?? result.status)
      await patchIndexNowState(stateCollection, {
        lastSubmittedAt: nowIso,
        lastStatus: `error: ${result.error ?? `status ${result.status}`}`.slice(0, 200),
      })
    }
  } catch (err) {
    if (err !== MAINTENANCE_DEADLINE_REACHED) {
      api.plugin.log('indexnow flush error:', err instanceof Error ? err.message : String(err))
    }
  } finally {
    indexNowInFlight = false
  }
}

/**
 * Published-site gate for the public routes (review blocker #1). What a
 * plugin CAN observe at this pin: pages are data rows, and the content
 * surface exposes their publish state — `table('pages').list({ status:
 * 'published' })` (ContentListOptionsSchema `status` enum, vendor
 * src/core/plugin-sdk/contentSchemas.ts:118-123; ContentEntry.status,
 * :85) and per-page `getPublishedSnapshot(pageId)` (serverApi.ts). So
 * "does this site have anything published?" = one status-filtered list.
 * Memoized briefly — crawlers hammer /sitemap.xml.
 */
const PUBLISHED_GATE_TTL_MS = 5_000
let publishedGate: { value: boolean; expiresAt: number } | null = null

async function hasPublishedPages(api: ServerPluginApi, now: number = Date.now()): Promise<boolean> {
  if (publishedGate !== null && now < publishedGate.expiresAt) return publishedGate.value
  const result = await api.cms.content
    .table(PAGES_TABLE_SLUG)
    .list({ status: 'published', limit: 1 })
  const value = result.entries.length > 0
  publishedGate = { value, expiresAt: now + PUBLISHED_GATE_TTL_MS }
  return value
}

/**
 * Table slug of the system table regular pages live in. Pages are data
 * rows of `data_tables` id/slug `pages` (vendor/Instatic
 * server/db/migrations-sqlite.ts:241), and the publish.html context's
 * `pageId` is that row's id (server/repositories/publish.ts:44-45).
 */
const PAGES_TABLE_SLUG = 'pages'

/**
 * All records for one entry's key, newest first. The host's list API has no
 * unique constraint on `data_json.key` and no upsert, so two concurrent
 * writes can race into duplicate records (UPSTREAM GAP, G-list candidate:
 * plugin storage needs a unique-key/upsert primitive — repository insert is
 * unconditional, server/repositories/plugins.ts). Ordering relies on the
 * repository's default `created_at desc` (listPluginRecords' orderBySql
 * default; `orderBy` options can only address data_json fields).
 */
async function listSeoMetaRecords(api: ServerPluginApi, key: string) {
  const { records } = await seoMetaCollection(api).list({ filter: { key }, limit: 100 })
  return records
}

/**
 * DELETE /meta sweeps in list-then-delete passes because the list is
 * capped. Bounded so a pathological key (or a writer racing the delete)
 * can never spin the request: 100 records per pass × 20 passes = 2000,
 * far beyond any real duplicate count, and the response reports honestly
 * if something is still there afterwards.
 */
const META_DELETE_MAX_PASSES = 20

/**
 * READ-ONLY newest-wins resolve for the publish filter: duplicates are
 * tolerated in memory, never deleted — the publish hot path must stay
 * within the 5 s dispatch budget and never issue write traffic.
 */
async function readNewestSeoMetaRecord(api: ServerPluginApi, key: string) {
  const [newest] = await listSeoMetaRecords(api, key)
  return newest ?? null
}

/**
 * Self-healing resolve for the AUTHENTICATED routes: returns the newest
 * record for the key and deletes stale duplicates left behind by a write
 * race (G10: no unique key/upsert at this pin), capped at
 * SEO_META_CLEANUP_CAP deletions per request — leftovers get the next one.
 */
async function resolveSeoMetaRecord(api: ServerPluginApi, key: string) {
  const [newest, ...stale] = await listSeoMetaRecords(api, key)
  for (const record of stale.slice(0, SEO_META_CLEANUP_CAP)) {
    await seoMetaCollection(api).delete(record.id)
  }
  return newest ?? null
}

/**
 * Dedicated seo-meta reconcile cursor in seo-state. Reads are newest-wins
 * and writes are update-else-create, matching the sitemap cursor's G10
 * discipline while keeping the two independently paged collections apart.
 */
async function loadSeoMetaReconcileCursor(collection: StateCollectionLike): Promise<number> {
  const { records } = await collection.list({
    filter: { key: SEO_META_RECONCILE_STATE_KEY },
    limit: 100,
  })
  const value = records[0]?.data.cursor
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0
}

async function saveSeoMetaReconcileCursor(
  collection: StateCollectionLike,
  cursor: number,
): Promise<void> {
  const { records } = await collection.list({
    filter: { key: SEO_META_RECONCILE_STATE_KEY },
    limit: 100,
  })
  const data = {
    key: SEO_META_RECONCILE_STATE_KEY,
    cursor: Math.max(0, Math.floor(cursor)),
  }
  if (records[0]) await collection.update(records[0].id, data)
  else await collection.create(data)
}

export interface MaintenanceTickOptions {
  clock?: () => number
  budgetMs?: number
}

/** One deadline covers the complete scheduled handler. Nine seconds comes
 * from the measured ~11.7 s host ceiling and leaves ~2.7 s for a slow final
 * RPC and handler teardown. IndexNow runs first because prompt submission is
 * correctness-sensitive; bounded local drains/reconciles run before the
 * potentially expensive Pro work so they cannot be starved by it. */
export async function runMaintenanceTick(
  api: ServerPluginApi,
  options: MaintenanceTickOptions = {},
): Promise<void> {
  const clock = options.clock ?? Date.now
  const startedAt = clock()
  const deadline: MaintenanceDeadline = {
    clock,
    expiresAt: startedAt + (options.budgetMs ?? MAINTENANCE_BUDGET_MS),
  }

  try {
    await flushIndexNow(api, startedAt, deadline)
  } catch (err) {
    if (err !== MAINTENANCE_DEADLINE_REACHED) {
      api.plugin.log('indexnow stage error:', err instanceof Error ? err.message : String(err))
    }
  }
  if (!maintenanceHasTime(deadline)) return

  // Drained count buckets remain in module state until their write lands;
  // a deliberate deadline stop therefore resumes instead of losing them.
  try {
    const analytics = deadlineCollection(
      maintenanceCollection(analyticsCollection(api)),
      deadline,
    ) as DayCollectionLike
    const notFound = deadlineCollection(
      maintenanceCollection(notFoundCollection(api)),
      deadline,
    ) as DayCollectionLike
    await flushDayCountsWithinDeadline(
      pageViewCounts,
      pendingPageViewDays,
      analytics,
      ANALYTICS_PATH_CAP,
      deadline,
    )
    await flushDayCountsWithinDeadline(
      notFoundCounts,
      pendingNotFoundDays,
      notFound,
      NOTFOUND_PATH_CAP,
      deadline,
    )
    await pruneExpiredDayRecords(analytics, startedAt)
    await pruneExpiredDayRecords(notFound, startedAt)
  } catch (err) {
    if (err !== MAINTENANCE_DEADLINE_REACHED) {
      api.plugin.log('beacon flush error:', err instanceof Error ? err.message : String(err))
    }
  }
  if (!maintenanceHasTime(deadline)) return

  // Page meta is retained for every existing page row. A partial batch
  // advances only over records whose verdict/write finished; persisted
  // deletes and the cursor arithmetic therefore resume without skipping.
  try {
    const collection = deadlineCollection(
      maintenanceCollection(seoMetaCollection(api)),
      deadline,
    )
    const stateCollection = deadlineCollection(
      maintenanceCollection(seoStateCollection(api)),
      deadline,
    )
    const pages = api.cms.content.table(PAGES_TABLE_SLUG)
    const cursor = await loadSeoMetaReconcileCursor(stateCollection)
    const { records } = await collection.list({
      limit: SEO_META_RECONCILE_BATCH_SIZE,
      offset: cursor,
    })
    if (records.length === 0) {
      if (cursor !== 0) await saveSeoMetaReconcileCursor(stateCollection, 0)
    } else {
      const pageCache = new Map<string, 'exists' | 'missing' | 'ambiguous'>()
      let processed = 0
      let deleted = 0
      let deleteAttempts = 0
      for (const record of records) {
        if (!maintenanceHasTime(deadline) || deleteAttempts >= SEO_META_CLEANUP_CAP) break
        const ref = parseSeoMetaStorageKey(record.data.key)
        if (ref === undefined || ref.tableSlug !== PAGES_TABLE_SLUG) {
          processed++
          continue
        }

        let verdict = pageCache.get(ref.entryId)
        if (verdict === undefined) {
          if (!maintenanceHasTime(deadline)) break
          try {
            const row = await pages.get(ref.entryId)
            verdict = row === null ? 'missing' : row === undefined ? 'ambiguous' : 'exists'
            pageCache.set(ref.entryId, verdict)
          } catch (err) {
            pageCache.set(ref.entryId, 'ambiguous')
            api.plugin.log(
              'seo-meta reconcile page lookup error:',
              err instanceof Error ? err.message : String(err),
            )
            processed++
            continue
          }
        }
        if (verdict === 'missing') {
          if (!maintenanceHasTime(deadline)) break
          deleteAttempts++
          try {
            await collection.delete(record.id)
            deleted++
          } catch (err) {
            if (err === MAINTENANCE_DEADLINE_REACHED) break
            api.plugin.log(
              'seo-meta reconcile delete error:',
              err instanceof Error ? err.message : String(err),
            )
          }
        }
        processed++
      }

      const reachedEnd =
        processed === records.length && records.length < SEO_META_RECONCILE_BATCH_SIZE
      const next = reachedEnd ? 0 : cursor + processed - deleted
      if (next !== cursor) await saveSeoMetaReconcileCursor(stateCollection, next)
    }
  } catch (err) {
    if (err !== MAINTENANCE_DEADLINE_REACHED) {
      api.plugin.log('seo-meta reconcile error:', err instanceof Error ? err.message : String(err))
    }
  }
  if (!maintenanceHasTime(deadline)) return

  try {
    const collection = deadlineCollection(
      maintenanceCollection(sitemapCollection(api)),
      deadline,
    )
    const stateCollection = deadlineCollection(
      maintenanceCollection(seoStateCollection(api)),
      deadline,
    )
    const pages = api.cms.content.table(PAGES_TABLE_SLUG)
    const cursor = await loadReconcileCursor(stateCollection)
    const { records } = await collection.list({
      limit: RECONCILE_BATCH_SIZE,
      offset: cursor,
    })
    if (records.length === 0) {
      if (cursor !== 0) await saveReconcileCursor(stateCollection, 0)
    } else {
      const pageCache = new Map<string, ReconcilePageInfo | null>()
      let processed = 0
      let deleted = 0
      for (const record of records) {
        if (!maintenanceHasTime(deadline) || deleted >= SITEMAP_CLEANUP_CAP) break
        const entry = deserializeSitemapRecord(record.data)
        let page: ReconcilePageInfo | null = null
        if (entry !== undefined) {
          const cached = pageCache.get(entry.pageId)
          if (cached !== undefined) {
            page = cached
          } else {
            if (!maintenanceHasTime(deadline)) break
            const row = await pages.get(entry.pageId)
            page = row ? { status: row.status, cells: row.cells } : null
            pageCache.set(entry.pageId, page)
          }
        }
        if (shouldPruneRecord(record, page)) {
          if (!maintenanceHasTime(deadline)) break
          await collection.delete(record.id)
          deleted++
        }
        processed++
      }
      if (deleted > 0) invalidateSitemapCache()

      const reachedEnd = processed === records.length && records.length < RECONCILE_BATCH_SIZE
      const next = reachedEnd ? 0 : cursor + processed - deleted
      if (next !== cursor) await saveReconcileCursor(stateCollection, next)
    }
  } catch (err) {
    if (err !== MAINTENANCE_DEADLINE_REACHED) {
      api.plugin.log('sitemap reconcile error:', err instanceof Error ? err.message : String(err))
    }
  }
  if (!maintenanceHasTime(deadline)) return

  try {
    await (tickPro as unknown as (
      api: ServerPluginApi,
      deadline: MaintenanceDeadline,
    ) => Promise<void>)(api, deadline)
  } catch (err) {
    // Same shape as every other stage: a deliberate deadline stop is normal
    // control flow, not an error, and logging the sentinel here would print
    // "[object Object]" on every busy tick.
    if (err !== MAINTENANCE_DEADLINE_REACHED) {
      api.plugin.log('pro tick error:', err instanceof Error ? err.message : String(err))
    }
  }
}

const mod: ServerPluginModule = {
  activate(api) {
    // ── publish.html — bake SEO meta into every published page's <head> ──
    api.cms.hooks.filter('publish.html', async (html, { siteId, pageId, slug }) => {
      // Round-5 wave-2 O#1: the hand-off slot describes ONE render, and
      // this filter is the start of that render. Clear it FIRST so a
      // filter that throws (or a template render, which never stashes)
      // cannot leave a previous render's facts for this render's
      // publish.after to consume as fresh. See clearPageStash.
      if (typeof pageId === 'string' && pageId !== '') clearPageStash(pageId)
      try {
        const config = await loadSeoConfig(seoConfigCollection(api))
        // BLOCKER GUARD: when pageId is a TEMPLATE page, this render is a
        // composed data-row (or notFound) document — template pages are
        // never baked at their own slug — and the per-entry tier must be
        // skipped or the template's stored meta (canonical!) would stamp
        // every row rendered through it. See ./templateDetect.ts. For
        // postTypes templates the table tier is redirected to the target
        // table, so `tables.<rowTable>` title templates reach row pages.
        const tpl = await getTemplatePageInfo(api.cms.content.table(PAGES_TABLE_SLUG), pageId)
        const record = tpl.isTemplate
          ? null
          : await readNewestSeoMetaRecord(api, seoMetaKey(PAGES_TABLE_SLUG, pageId))
        const entry = record ? deserializeSeoMeta(record.data) : {}
        // %title% inside title templates = the host-baked <title> text
        // (settings.metaTitle ?? page.title ?? site.name — publisher
        // render.ts:326; row title for data-row renders,
        // publicRenderer.ts:182), slug fallback; composePublishHtml keeps
        // it stable across re-filters via its source-title stash.
        // Task 2.3: arm schema.org JSON-LD emission for regular pages only
        // (template/composed renders carry the TEMPLATE's slug — a graph
        // for it would stamp the wrong URL/breadcrumbs on every row).
        // datePublished/dateModified ride the pages row ALREADY fetched by
        // getTemplatePageInfo (ContentEntry createdAt/updatedAt — zero
        // extra lookups, G10); publishedAt is useless here (overwritten on
        // every publish — see templateDetect.ts). Emission itself remains
        // gated on schema.enabled + a configured site origin inside
        // buildSchemaTag.
        // Task 2.4 — analytics config tag + CSP hash patching. The inline
        // config `<script>` (tracker contract: window.__mwSeoAnalytics set
        // BEFORE the body-end tracker tag) is CSP-blocked on published
        // pages unless script-src carries its sha256 (spike evidence in
        // server/lib/cspPatch.ts header), so the CSP meta is patched FIRST
        // and the tag is injected only when that patch succeeded (or no
        // CSP meta exists at all). On the site's 404-template render
        // (tpl.isNotFound — the 404 body is baked ONCE with a synthetic
        // /404 URL, publicRouter.ts renderNotFoundResponse) the endpoint
        // switches to the 404 beacon route; the tracker reports the real
        // missed path from location. Independently, the page's inline
        // `<script type="importmap">` is re-hashed into script-src — the
        // host's frontend-asset CSP rewrite wipes the importmap's pinned
        // sha256 (upstream gap G14), and OUR manifest assets trigger that
        // rewrite on every page.
        let working = html
        let analyticsTag: string | undefined
        let analyticsScriptText: string | undefined
        if (analyticsEnabled(config)) {
          const route = tpl.isNotFound === true ? NOTFOUND_BEACON_ROUTE : BEACON_ROUTE
          const built = buildAnalyticsConfigTag({
            endpoint: beaconEndpoint(api.plugin.id, route),
            siteId,
            enabled: true,
          })
          analyticsTag = built.tag
          analyticsScriptText = built.scriptText
        }
        const inlineTexts: string[] = []
        const importmapText = extractImportmapText(html)
        if (importmapText !== undefined) inlineTexts.push(importmapText)
        if (analyticsScriptText !== undefined) inlineTexts.push(analyticsScriptText)
        if (inlineTexts.length > 0 && planInlineCsp(html).mode === 'patch') {
          const patched = await allowInlineScripts(html, inlineTexts)
          if (patched === null) {
            // CSP meta unparseable — the config tag could not execute, so
            // never inject it (a blocked inline would just spray console
            // CSP violations on every visit).
            analyticsTag = undefined
          } else {
            working = patched
          }
        }

        const composed = composePublishHtml(working, entry, config, {
          tableSlug: tpl.targetTableSlug ?? PAGES_TABLE_SLUG,
          slug,
          schemaPage: tpl.isTemplate
            ? undefined
            : { datePublished: tpl.createdAt, dateModified: tpl.updatedAt },
          analyticsTag,
        })
        // Task 2.2 sitemap dirty tracking: stash this render's facts for
        // the publish.after event handler (which may write storage but has
        // no slug in its payload — see the module-state comment above).
        // Template pages never enter the sitemap: their pageId only ever
        // appears for composed data-row / notFound renders (G1).
        if (!tpl.isTemplate) {
          try {
            // Task 2.4: image-SEO audit of the composed document. Runs in
            // the FILTER (which holds the HTML) so only two integers ride
            // the stash; publish.after persists them onto the page's
            // sitemap record (new flat fields), where GET /meta joins
            // them for the editor panel.
            const audit = auditImages(composed)
            stashPage(pageId, {
              slug,
              title: extractTitleText(composed),
              noindex: entry.robots?.noindex === true,
              // Version-normalized (review #3): `?v=<publishVersion>` and
              // data-instatic-version stamps change every full publish
              // and must not read as content changes.
              fp: contentFingerprint(normalizeForFingerprint(composed)),
              imgTotal: audit.totalImages,
              imgFindings: audit.findings.length,
            })
          } catch {
            // stash failures never affect the published document
          }
        }
        return composed
      } catch {
        // A publish must never break on SEO decoration: any unexpected
        // failure (storage hiccup, malformed stored data) passes the
        // document through untouched.
        //
        // But it must not be INVISIBLE either (review finding,
        // 2026-08-15): before this, a page could publish with every meta
        // tag, JSON-LD block and analytics tag silently missing, and
        // nothing anywhere said so. The filter cannot write (it is
        // strictly read-only — G10), so record it in the same in-memory
        // stash the sitemap facts use and let publish.after persist it.
        try {
          stashDecorationFailure(pageId)
        } catch {
          // Reporting a failure must never itself break a publish.
        }
        return html
      }
    })

    api.cms.routes.authenticated.get('/meta', async ({ req }) => {
      const ref = parseEntryRef(req.url)
      if (!ref.ok) return badRequest(ref.errors)

      const record = await resolveSeoMetaRecord(api, seoMetaKey(ref.tableSlug, ref.entryId))
      const payload: Record<string, unknown> = record ? deserializeSeoMeta(record.data) : {}
      // Task 2.4 — read-only RESPONSE-ENVELOPE join (never stored meta):
      // published-page image-audit counts from the page's sitemap record
      // (written by publish.after). Pages only — data rows have no
      // per-row sitemap record at this pin (G1). validateSeoMeta ignores
      // the key, so GET→POST round-trips stay safe; the panel strips it
      // before treating the body as a meta payload.
      if (ref.tableSlug === PAGES_TABLE_SLUG) {
        try {
          const [newest] = await listSitemapRecordsForKey(
            sitemapCollection(api),
            sitemapPageKey(ref.entryId),
          )
          const entry = newest ? deserializeSitemapRecord(newest.data) : undefined
          if (entry?.imgTotal !== undefined && entry.imgFindings !== undefined) {
            payload.imageAudit = {
              totalImages: entry.imgTotal,
              findings: entry.imgFindings,
              ...(entry.lastmod !== undefined ? { lastmod: entry.lastmod } : {}),
            }
          }
        } catch {
          // join failures never degrade the meta read
        }
      }
      return payload
    })

    api.cms.routes.authenticated.post('/meta', async ({ req }) => {
      const ref = parseEntryRef(req.url)
      if (!ref.ok) return badRequest(ref.errors)

      const raw = await req.text()
      if (!isSeoMetaRequestBodyWithinLimit(raw)) {
        return badRequest([{ field: '', message: 'request body too large' }])
      }
      const parsed = parseJsonBody(raw)
      if (!parsed.ok) return badRequest(parsed.errors)

      const validated = validateSeoMeta(parsed.value)
      if (!validated.ok) return badRequest(validated.errors)
      if (isEmptySeoMeta(validated.value)) {
        return badRequest([
          { field: '', message: 'empty payload — use DELETE to clear stored meta' },
        ])
      }

      const key = seoMetaKey(ref.tableSlug, ref.entryId)
      const collection = seoMetaCollection(api)
      const existing = await resolveSeoMetaRecord(api, key)

      const data = serializeSeoMeta(key, validated.value)
      const stored = existing
        ? await collection.update(existing.id, data)
        : await collection.create(data)
      return stored ? deserializeSeoMeta(stored.data) : validated.value
    })

    api.cms.routes.authenticated.delete('/meta', async ({ req }) => {
      const ref = parseEntryRef(req.url)
      if (!ref.ok) return badRequest(ref.errors)

      // DELETE means GONE. `listSeoMetaRecords` is capped at 100, so a key
      // that accumulated more duplicates than that (G10 has no unique
      // key, so nothing bounds them) would leave survivors behind — and
      // the next newest-wins READ would resurrect the metadata the user
      // just deleted. Sweep in passes until a list comes back empty
      // (review finding, 2026-08-15).
      const key = seoMetaKey(ref.tableSlug, ref.entryId)
      let deleted = 0
      for (let pass = 0; pass < META_DELETE_MAX_PASSES; pass++) {
        const records = await listSeoMetaRecords(api, key)
        if (records.length === 0) break
        for (const record of records) {
          await seoMetaCollection(api).delete(record.id)
          deleted++
        }
      }
      // If anything could still be there, say so rather than reporting a
      // clean delete: an honest partial beats a silent one.
      // There is no transaction or compare-and-set at this host pin. A POST
      // can still create a record after this final read, so `complete` only
      // reports the state observed by DELETE, not a future guarantee.
      const remaining = (await listSeoMetaRecords(api, key)).length
      return { deleted, remaining, complete: remaining === 0 }
    })

    // ── task 2.6: analytics stats read (authenticated, dashboard widget) ─
    //
    // GET /stats → { days: [{day, views, notFound}], totals, collecting }
    // — the last 7 UTC calendar days (zero-filled, oldest→today) joined
    // from the seo-analytics / seo-notfound day records, plus the CURRENT
    // opt-in state (review C#3: day records outlive a disable for up to
    // 30 days of retention, so the widget must be able to label stale
    // data as historical). STRICTLY READ-ONLY (G10 discipline:
    // newest-wins duplicate resolution in memory, no cleanup — cleanup
    // stays on the maintenance tick). Retention keeps ≤ ~30 records per
    // collection, so a 100-record list is never truncated.
    // Task 3.3 (FREE): observed host slug moves, read-only ("visibility,
    // not management" — DESIGN §4.1). Not pro-gated on purpose.
    api.cms.routes.authenticated.get(
      '/redirects/hostmoves',
      makeHostMovesHandler({ storage: api.cms.storage }),
    )

    api.cms.routes.authenticated.get('/stats', async () => {
      const [config, viewRecords, notFoundRecords] = await Promise.all([
        loadSeoConfig(seoConfigCollection(api)),
        analyticsCollection(api).list({ limit: 100 }),
        notFoundCollection(api).list({ limit: 100 }),
      ])
      return {
        ...buildStatsPayload(
          newestDayTotals(viewRecords.records),
          newestDayTotals(notFoundRecords.records),
          Date.now(),
        ),
        collecting: analyticsEnabled(config),
      }
    })

    // ── seo-config admin routes ──────────────────────────────────────────

    api.cms.routes.authenticated.get('/config', async () => {
      // Duplicate cleanup lives HERE (authenticated, capped), never on
      // the publish filter path (loadSeoConfig is read-only).
      await healSeoConfigDuplicates(seoConfigCollection(api))
      const config = await loadSeoConfig(seoConfigCollection(api))
      // Review 2026-08-15: a publish whose decoration threw shipped a page
      // with NO SEO tags and said nothing. Ride the settings load so the
      // admin can warn without another round-trip. Read-only and
      // best-effort — a reporting failure must not break settings.
      let decorationFailures: { count: number; lastAt?: string; pages: string[] } | undefined
      let indexNowFailure: { lastAt?: string; status: string } | undefined
      try {
        const state = await loadDecorationFailure(seoStateCollection(api))
        if (state.failureCount > 0) {
          decorationFailures = {
            count: state.failureCount,
            ...(state.lastFailureAt !== undefined ? { lastAt: state.lastFailureAt } : {}),
            pages: state.failurePages,
          }
        }
      } catch {
        // no warning is better than no settings page
      }
      try {
        const state = await loadIndexNowState(
          seoStateCollection(api),
          seoConfigCollection(api),
          { migrate: false },
        )
        if (state.lastStatus?.startsWith('error:')) {
          indexNowFailure = {
            status: state.lastStatus,
            ...(state.lastSubmittedAt !== undefined ? { lastAt: state.lastSubmittedAt } : {}),
          }
        }
      } catch {
        // no warning is better than no settings page
      }
      return {
        ...config,
        ...(decorationFailures !== undefined ? { decorationFailures } : {}),
        ...(indexNowFailure !== undefined ? { indexNowFailure } : {}),
      }
    })

    api.cms.routes.authenticated.post('/config', async ({ req }) => {
      const raw = await req.text()
      if (!isSeoConfigRequestBodyWithinLimit(raw)) {
        return badRequest([{ field: '', message: 'request body too large' }])
      }
      const parsed = parseJsonBody(raw)
      if (!parsed.ok) return badRequest(parsed.errors)

      const validated = validateSeoConfig(parsed.value)
      if (!validated.ok) return badRequest(validated.errors)
      // A body that speaks NO section at all has nothing to do — clearing
      // everything is DELETE /config's job. Judged on the RAW body's keys
      // (review round 2 blocker): an explicit `schema: {}` (or any other
      // explicitly-present section, however empty it validates) is a valid
      // section write — including a clear — and must NOT be rejected here.
      if (!hasExplicitConfigSection(parsed.value)) {
        return badRequest([
          { field: '', message: 'empty payload — use DELETE to clear stored config' },
        ])
      }

      const collection = seoConfigCollection(api)
      const { records } = await collection.list({ limit: 1000 })
      // Presence-first section resolution (task 2.3): sections whose key is
      // PRESENT in the raw body replace the stored ones (present-but-empty
      // = explicit clear); ABSENT sections carry forward, so a client
      // built before a section existed (pre-2.3 settings form vs `schema`)
      // can never silently delete it. Existing state is read from the SAME
      // record snapshot the replace plan runs over (newest-first per key),
      // so resolution and plan can never disagree.
      const desired = resolveConfigSections(
        parsed.value,
        validated.value,
        deserializeSeoConfigRecords(records.map((r) => r.data)),
      )
      // TOCTOU (accepted — G10, see docs/SPIKES.md addendum): there is no
      // compare-and-swap at this pin, so two concurrent POST /config
      // writers race between this listing and the writes below.
      // Last-write-wins per record; a client may receive an echo that a
      // concurrent writer immediately superseded. Deliberately NOT
      // serialized — bounded admin-surface exposure, self-corrected by the
      // next save.
      const plan = planSeoConfigReplace(records, serializeSeoConfig(desired))
      if (!plan.ok) {
        // A list at the host cap may be truncated — a "full replace" over
        // a partial view could silently leave hidden records live. Refuse
        // rather than half-run.
        return badRequest([
          { field: '', message: 'config record count at host list cap — cannot guarantee replace' },
        ])
      }

      // Multi-record replace is NON-ATOMIC at this pin (no transactions —
      // G10): a concurrent reader can observe a partially applied
      // document. Invalidate BEFORE the writes (so no pre-write cache
      // outlives them) and AFTER (so anything cached mid-write — guarded
      // additionally by the generation counter — is dropped). The
      // remaining exposure is bounded to readers listing records during
      // the write sequence itself.
      invalidateSeoConfigCache()
      for (const { recordId, data } of plan.updates) {
        await collection.update(recordId, data)
      }
      for (const recordId of plan.deletes) {
        await collection.delete(recordId)
      }
      for (const data of plan.creates) {
        await collection.create(data)
      }
      invalidateSeoConfigCache()
      // Echo what is actually STORED (carried-forward schema included).
      return desired
    })

    // ── task 2.2: sitemap maintenance + IndexNow triggers ────────────────

    // Per-page publish completion (fires for bakes, republishes, AND live
    // renders — publishedHtmlPipeline.ts:66-69). Writes at most one
    // seo-sitemap record, and only when the page actually changed
    // (planSitemapWrite compares slug/title/fingerprint), so live-render
    // traffic never generates write load. Never throws into the publish.
    api.cms.hooks.on('publish.after', async ({ pageId }) => {
      // Persist any decoration failure the read-only filter recorded, so
      // "this page published with no SEO tags" is visible instead of
      // silent (review finding, 2026-08-15). Done before the sitemap work
      // and independently of it: a page that FAILED decoration has no
      // stash, so it would otherwise return below and never be reported.
      // Drained BEFORE the try so the catch can put the ids back: the
      // drain clears the module set, so a failed storage write would
      // otherwise lose the warning for good (round 5 triage C#1).
      const failed = takeDecorationFailures()
      try {
        if (failed.length > 0) {
          await recordDecorationFailure(
            seoStateCollection(api),
            failed,
            new Date().toISOString(),
          )
        }
      } catch {
        // Reporting must never break a publish — but a transient storage
        // failure must not silently swallow the tally either: re-stash so
        // the next publish.after retries these ids. `stashDecorationFailure`
        // is a capped Set, so re-adding is idempotent and still bounded.
        // Accepted narrow window: `recordDecorationFailure` creates BEFORE
        // it compacts (seoState.ts:441-447), so a throw from the COMPACTION
        // re-stashes ids that were already persisted and the next retry
        // counts them twice. Over-counting an advisory tally beats losing
        // it, which is what this catch did before.
        for (const id of failed) stashDecorationFailure(id)
      }

      if (typeof pageId !== 'string' || pageId === '') return
      // Popped BEFORE any write, for the same reason as the failure set —
      // see the catch below (round 5 triage C#2).
      let stash: PageStash | undefined
      try {
        stash = takePageStash(pageId)
        if (stash === undefined) return

        const collection = sitemapCollection(api)
        const key = sitemapPageKey(pageId)
        const allRecords = await listSitemapRecordsForKey(collection, key)
        const [newest, ...stale] = allRecords
        const existing = newest ? deserializeSitemapRecord(newest.data) : undefined
        // Task 3.3: observe slug changes for the free "host redirects"
        // visibility list. Vendor proof (server/redirects/hostMoves.ts
        // header): PAGE slug renames get NO host 301 at this pin — the UI
        // says "URL changed", never "the host serves a 301". Best-effort:
        // recordSlugMove failures are swallowed by planSitemapWrite.
        const plan = planSitemapWrite(existing, pageId, stash, new Date().toISOString(), (move) =>
          recordSlugMove(api.cms.storage, move, new Date()),
        )

        if (plan.action === 'delete') {
          // Noindex clears EVERY record for the page — including a
          // malformed newest one (review #11); no-op when nothing stored.
          for (const record of allRecords.slice(0, SITEMAP_CLEANUP_CAP)) {
            await collection.delete(record.id)
          }
          if (allRecords.length > 0) invalidateSitemapCache()
        } else if (plan.action === 'write') {
          if (newest) await collection.update(newest.id, plan.data)
          else await collection.create(plan.data)
          // Stale duplicates from write races (G10): capped cleanup here on
          // the hook path — never on the filter path.
          for (const record of stale.slice(0, SITEMAP_CLEANUP_CAP)) {
            await collection.delete(record.id)
          }
          invalidateSitemapCache()
          // NO flush here (review #8): the record is marked pending; the
          // seo-maintenance tick performs the actual IndexNow POST with
          // its own fresh eval budget.
        }
      } catch (err) {
        // Put the hand-off back: the pop above happens before any sitemap
        // write, so a transient storage failure would otherwise leave the
        // sitemap/IndexNow queue stale until the page is published again.
        // publish.after fires for bakes, republishes AND live renders
        // (publishedHtmlPipeline.ts:66-69), so the very next one retries.
        // Accepted cost: the retry re-runs planSitemapWrite, so a slug
        // move observed before the failed write is recorded a second time
        // (fire-and-forget callback, keyed by pageId+ms — sitemap.ts:317).
        // A duplicate advisory "URL changed" row beats losing the page's
        // sitemap entry; the moves list is capped and duplicate-tolerant.
        if (stash !== undefined) stashPage(pageId, stash)
        api.plugin.log('sitemap tracking error:', err instanceof Error ? err.message : String(err))
      }
    })

    // Page deletions prune the sitemap and page meta immediately when the
    // host emits the event. NOTE (candidate G-item, see docs/SPIKES.md):
    // editor-driven page deletions may bypass `content.entry.deleted`
    // (pages are Yjs/page-tree managed), so the scheduled reconciles below
    // are the safety net that guarantees eventual pruning either way.
    api.cms.hooks.on('content.entry.deleted', async ({ tableSlug, entryId }) => {
      if (tableSlug !== PAGES_TABLE_SLUG || typeof entryId !== 'string') return
      try {
        const collection = sitemapCollection(api)
        const records = await listSitemapRecordsForKey(collection, sitemapPageKey(entryId))
        for (const record of records.slice(0, SITEMAP_CLEANUP_CAP)) {
          await collection.delete(record.id)
        }
        if (records.length > 0) invalidateSitemapCache()
      } catch (err) {
        api.plugin.log('sitemap prune error:', err instanceof Error ? err.message : String(err))
      }
      try {
        const records = await listSeoMetaRecords(api, seoMetaKey(PAGES_TABLE_SLUG, entryId))
        for (const record of records.slice(0, SEO_META_CLEANUP_CAP)) {
          await seoMetaCollection(api).delete(record.id)
        }
      } catch (err) {
        api.plugin.log('seo-meta prune error:', err instanceof Error ? err.message : String(err))
      }
    })

    // Maintenance tick (cms.schedule permission): performs ALL IndexNow
    // POSTs (review #8 — the publish path only marks records pending),
    // then reconciles cursor-paged seo-meta and sitemap batches against the
    // pages table. Cursor-based (review #5): independent offsets persist in
    // the server-owned seo-state collection across ticks, so ANY site size
    // eventually reconciles fully — no fixed scan cap, no complete-listing
    // precondition. Per record, the page row is looked up individually.
    // Seo-meta is pruned only when the page is gone; sitemap is also pruned
    // when the page is not `published` (published→draft reverts — review
    // blocker #2), or a template. Deletions are capped per tick; a cap-hit
    // leaves the remainder of each batch for the wrap-around pass.
    api.cms.schedule.every(15, 'seo-maintenance', () => runMaintenanceTick(api))

    // ── task 2.2: public routes (user: null — runtime.ts:209-256) ────────
    //
    // Visitor-facing URLs (host prefix, DESIGN §5.5):
    //   /admin/api/cms/plugins/monkeywebs.seo/runtime/sitemap.xml
    //   /admin/api/cms/plugins/monkeywebs.seo/runtime/llms.txt
    //   /admin/api/cms/plugins/monkeywebs.seo/runtime/indexnow-key.txt
    //
    // All three serve only data that is public by nature (published page
    // URLs/titles, the IndexNow key). Gates:
    //   - seo-config siteUrl must be set AND re-validate as a bare origin
    //     at the boundary (review #12 — stored data is still storage
    //     data), else 404 + JSON hint pointing at SEO Settings.
    //   - sitemap/llms.txt additionally 404 while the site has no
    //     published page (review blocker #1 — see hasPublishedPages),
    //     so an unpublished/reverted site never serves a stale page list.

    const siteUrlUnset = {
      __response: true,
      status: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'not available',
        hint: 'Set the Site URL in SEO Settings (General) — absolute URLs require a configured site origin.',
      }),
    }

    const siteNotPublished = {
      __response: true,
      status: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'not available',
        hint: 'The site has no published pages yet — publish the site first.',
      }),
    }

    api.cms.routes.public.get('/sitemap.xml', async () => {
      try {
        const config = await loadSeoConfig(seoConfigCollection(api))
        const siteUrl = normalizeSiteOrigin(config.site?.siteUrl)
        if (siteUrl === undefined) return siteUrlUnset
        if (!(await hasPublishedPages(api))) return siteNotPublished
        const load = await loadSitemapEntries(sitemapCollection(api))
        const listed = load.entries.filter((entry) => entry.slug !== '')
        return {
          __response: true,
          status: 200,
          headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
          },
          body: buildSitemapXml(listed, siteUrl, { truncatedLoad: load.truncated }),
        }
      } catch {
        return {
          __response: true,
          status: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'sitemap generation failed' }),
        }
      }
    })

    api.cms.routes.public.get('/llms.txt', async () => {
      try {
        const config = await loadSeoConfig(seoConfigCollection(api))
        const siteUrl = normalizeSiteOrigin(config.site?.siteUrl)
        if (siteUrl === undefined) return siteUrlUnset
        if (!(await hasPublishedPages(api))) return siteNotPublished
        const load = await loadSitemapEntries(sitemapCollection(api))
        return {
          __response: true,
          status: 200,
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
          },
          body: buildLlmsTxt({
            siteUrl,
            siteName: config.site?.siteName,
            description: config.site?.metaDescription,
            entries: load.entries,
            truncatedLoad: load.truncated,
          }),
        }
      } catch {
        return {
          __response: true,
          status: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'llms.txt generation failed' }),
        }
      }
    })

    // IndexNow key file — its URL is the `keyLocation` sent with every
    // submission. Served from the server-owned seo-state collection
    // (review #9; loadIndexNowState also lifts legacy embedded state).
    // 404s until the first submission generates a key (the engines fetch
    // it only after we submit, so the window is harmless).
    api.cms.routes.public.get(INDEXNOW_KEY_ROUTE, async () => {
      try {
        // migrate:false — a PUBLIC route must never write storage; the
        // merged view still serves a legacy key until the tick lifts it.
        const state = await loadIndexNowState(seoStateCollection(api), seoConfigCollection(api), {
          migrate: false,
        })
        const key = state.key
        if (key === undefined) {
          return {
            __response: true,
            status: 404,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              error: 'no key yet',
              hint: 'The IndexNow key is generated on the first submission after a publish.',
            }),
          }
        }
        return {
          __response: true,
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: key,
        }
      } catch {
        return {
          __response: true,
          status: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'key lookup failed' }),
        }
      }
    })

    // Authenticated operator escape hatch: clear both the current and
    // pre-migration key so the next successful flush generates a fresh one.
    api.cms.routes.authenticated.delete(INDEXNOW_KEY_ROUTE, async () => {
      await clearIndexNowState(seoStateCollection(api), seoConfigCollection(api))
      return {}
    })

    // ── task 2.4: beacon ingest (PUBLIC, anonymous — user: null) ─────────
    //
    // POST text/plain JSON from assets/tracker.js (the DNT/GPC-respecting
    // browser tracker; Codex-worker contract). Hard rules:
    //   - ALWAYS 204, no body — success, rate-limit drop, disabled state
    //     and parse failure are indistinguishable to the sender (an
    //     anonymous endpoint must not be a probing oracle).
    //   - ZERO storage writes in-request (G10): counts go to the in-memory
    //     aggregators; the seo-maintenance tick flushes.
    //   - Crude per-VM token buckets (300/min views, 120/min 404s) drop
    //     floods before any parsing happens.
    //   - The enabled-gate re-checks config on ingest (memoized ~5 s):
    //     stale baked pages keep beaconing after analytics is switched
    //     off — their beacons are dropped here until a republish removes
    //     the config tag.
    api.cms.routes.public.post(BEACON_ROUTE, async ({ req }) => {
      try {
        if (beaconBucket.allow()) {
          const config = await loadSeoConfig(seoConfigCollection(api))
          if (analyticsEnabled(config)) {
            // Length gate BEFORE any parse work (review B2#1): the host
            // already buffered the full anonymous body (routeIo.ts:59-61
            // — G16), so bounding OUR work is the only available defense.
            const raw = await req.text()
            if (raw.length <= MAX_BEACON_RAW_LENGTH) {
              const beacon = parseTrackerBeacon(raw)
              if (beacon !== null) pageViewCounts.record(beaconPath(beacon.u), Date.now())
            }
          }
        }
      } catch {
        // always 204 — never leak errors to anonymous senders
      }
      return NO_CONTENT
    })

    api.cms.routes.public.post(NOTFOUND_BEACON_ROUTE, async ({ req }) => {
      try {
        if (notFoundBucket.allow()) {
          const config = await loadSeoConfig(seoConfigCollection(api))
          if (analyticsEnabled(config)) {
            // Same pre-parse length gate as /beacon (review B2#1).
            const raw = await req.text()
            if (raw.length <= MAX_BEACON_RAW_LENGTH) {
              const beacon = parseTrackerBeacon(raw)
              if (beacon !== null) notFoundCounts.record(beaconPath(beacon.u), Date.now())
            }
          }
        }
      } catch {
        // always 204
      }
      return NO_CONTENT
    })

    api.cms.routes.authenticated.delete('/config', async () => {
      const collection = seoConfigCollection(api)
      invalidateSeoConfigCache()
      // Idempotent clear: a list at the host cap just means leftovers —
      // repeated DELETEs finish the job (no correctness risk, unlike the
      // POST full-replace).
      const { records } = await collection.list({ limit: 1000 })
      for (const record of records) {
        await collection.delete(record.id)
      }
      invalidateSeoConfigCache()
      return {}
    })

    // ── task 3.2: Pro surface (MCP endpoint + token routes; no-op in free).
    registerPro(api)
  },
}

export default mod

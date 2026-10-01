/**
 * analytics — first-party page-view + 404 counting (task 2.4, free tier).
 *
 * Design (spike G6 + G7): the browser tracker (`assets/tracker.js`, shipped
 * as a static manifest `frontend.assets[]` script — vendor
 * server/publish/frontendInjections.ts:106-165; the publish.html filter
 * strips the tag again while analytics is off, see `stripTrackerTag`) POSTs
 * a small text/plain JSON beacon to the plugin's PUBLIC runtime routes:
 *
 *   POST /admin/api/cms/plugins/<id>/runtime/beacon      — page views
 *   POST /admin/api/cms/plugins/<id>/runtime/beacon404   — 404 hits
 *
 * Public routes dispatch with `user: null` (runtime.ts:209-256), so the
 * ingest surface is anonymous and floodable. Discipline (G10 + task
 * decision):
 *
 *   - The route handlers perform ZERO storage writes. Counts aggregate in
 *     MODULE STATE (per QuickJS VM — one VM per plugin, persisted across
 *     dispatches, pluginWorker.ts:61,129,342), day-bucketed per path.
 *   - The `seo-maintenance` schedule tick drains the aggregators into the
 *     `seo-analytics` / `seo-notfound` collections: ONE record per day
 *     (key `day:<YYYY-MM-DD>`), counts as a single JSON map field
 *     (`countsJson`) so a month of data stays ≤ ~60 records — far under
 *     the host's 1000-record list cap. Read-modify-write, newest-wins.
 *   - Distinct-path caps (500/day for views, 200/day for 404s): over-cap
 *     paths bucket into `__other`. Caps apply in memory AND at merge time.
 *   - Crude per-VM token buckets rate-limit each route (300/min views,
 *     120/min 404s). The routes ALWAYS answer 204 regardless.
 *   - Retention: day records older than 30 days are pruned by the tick
 *     (capped deletions per tick).
 *
 * A VM restart loses at most one flush interval of in-memory counts;
 * a failed flush write loses that drain (logged) — accepted for free-tier
 * approximate counts, and far safer than anonymous-triggered writes.
 *
 * Everything here is pure ES2020 with injectable clocks/collections so it
 * unit-tests under plain `bun test` and bundles into the QuickJS sandbox.
 */

// ---------------------------------------------------------------------------
// Constants + resource ids
// ---------------------------------------------------------------------------

/** Manifest resource ids — must match instatic-plugin.config.ts. */
export const SEO_ANALYTICS_RESOURCE_ID = 'seo-analytics'
export const SEO_NOTFOUND_RESOURCE_ID = 'seo-notfound'

/** Record-key prefix: `day:<YYYY-MM-DD>`. */
export const DAY_KEY_PREFIX = 'day:'

/** Flat record-data field ids for BOTH day-count resources. */
export const DAY_COUNT_FIELD_IDS = ['key', 'day', 'total', 'countsJson'] as const

/** Distinct paths tracked per day before bucketing into `__other`. */
export const ANALYTICS_PATH_CAP = 500
export const NOTFOUND_PATH_CAP = 200

/** Overflow bucket for over-cap paths. */
export const OTHER_BUCKET = '__other'

/** Day records older than this are pruned by the maintenance tick. */
export const DAY_RETENTION_DAYS = 30

/** Max day-record deletions per retention pass (same cap style as sitemap). */
export const DAY_PRUNE_CAP = 25

/** Beacon path length cap (stored as JSON-map keys — keep them bounded). */
export const BEACON_PATH_MAX = 200

/** In-memory day buckets kept per aggregator (today + a few pending days). */
const MEMORY_DAY_CAP = 4

// ---------------------------------------------------------------------------
// Day + path normalization
// ---------------------------------------------------------------------------

/** UTC calendar day (`YYYY-MM-DD`) for a timestamp. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Shape AND calendar validity (review B2#7): the regex admits impossible
 * dates like `2026-02-31`, which would sail past string comparisons and
 * never be pruned by retention. Round-tripping through Date.UTC rejects
 * anything the calendar normalizes away.
 */
export function isValidDay(value: string): boolean {
  if (!DAY_RE.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  return utcDay(Date.UTC(year, month - 1, day)) === value
}

export function dayKey(day: string): string {
  return `${DAY_KEY_PREFIX}${day}`
}

/**
 * Inclusive cutoff: days strictly BEFORE this string are expired.
 * Boundary choice (review B2#7): the window is EXACTLY `retentionDays`
 * calendar days INCLUDING today — today counts as day 1, so the cutoff
 * is `retentionDays - 1` days back and the oldest surviving record is
 * the cutoff day itself. (The previous `- retentionDays` kept 31 days.)
 */
export function retentionCutoffDay(now: number, retentionDays: number = DAY_RETENTION_DAYS): string {
  return utcDay(now - (retentionDays - 1) * 24 * 60 * 60 * 1000)
}

/**
 * Normalize a beacon-reported page URL to a countable path bucket.
 *
 * Accepts an absolute http(s) URL or a root-relative path (what the
 * tracker sends as `u`); anything else — or an unusable value — buckets
 * to '/'. Query/fragment are dropped (paths only — no per-query
 * cardinality explosion), control characters rejected, length capped.
 * The ORIGIN IS DISCARDED, never trusted: a forged beacon can inflate a
 * path's count but can never make us store attacker-chosen hostnames.
 */
export function beaconPath(u: unknown): string {
  if (typeof u !== 'string' || u === '') return '/'
  let path = u
  const abs = /^https?:\/\/[^/]*(\/.*)?$/i.exec(u)
  if (abs !== null) path = abs[1] ?? '/'
  if (!path.startsWith('/') || path.startsWith('//')) return '/'
  const queryAt = path.indexOf('?')
  if (queryAt !== -1) path = path.slice(0, queryAt)
  const hashAt = path.indexOf('#')
  if (hashAt !== -1) path = path.slice(0, hashAt)
  // Control characters (or a now-empty path) → the root bucket.
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return '/'
  }
  if (path === '') return '/'
  if (path.length > BEACON_PATH_MAX) path = path.slice(0, BEACON_PATH_MAX)
  return path
}

// ---------------------------------------------------------------------------
// Token bucket — crude per-VM rate limiting for the public routes
// ---------------------------------------------------------------------------

/**
 * Classic token bucket, per VM (the QuickJS VM persists across dispatches;
 * a restart resets the bucket — acceptable for a crude anti-flood gate).
 * `capacity` tokens refill linearly over one minute.
 */
export class TokenBucket {
  private tokens: number
  private lastRefillAt: number
  constructor(
    private readonly capacity: number,
    now: number = Date.now(),
  ) {
    this.tokens = capacity
    this.lastRefillAt = now
  }

  /** Consume one token; false = rate-limited (caller still answers 204). */
  allow(now: number = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.lastRefillAt)
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.capacity) / 60_000)
    this.lastRefillAt = now
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

export const BEACON_RATE_PER_MIN = 300
export const NOTFOUND_RATE_PER_MIN = 120

// ---------------------------------------------------------------------------
// In-memory aggregation (module state; drained by the schedule tick)
// ---------------------------------------------------------------------------

export interface DrainedDay {
  day: string
  counts: Record<string, number>
  total: number
}

/**
 * Day-bucketed path→count map. `record` never writes storage; `drain`
 * snapshots-and-clears for the flush (a failed flush loses that snapshot —
 * documented above). Bounded: `pathCap` distinct paths per day (overflow →
 * `__other`), `MEMORY_DAY_CAP` days total (oldest evicted, counted into
 * the eviction day's `__other`-less total loss — logged by the caller).
 */
export class BeaconAggregator {
  private readonly days = new Map<string, { counts: Map<string, number>; total: number }>()
  constructor(private readonly pathCap: number) {}

  record(path: string, now: number): void {
    const day = utcDay(now)
    let bucket = this.days.get(day)
    if (bucket === undefined) {
      if (this.days.size >= MEMORY_DAY_CAP) {
        const oldest = this.days.keys().next().value
        if (oldest !== undefined) this.days.delete(oldest)
      }
      bucket = { counts: new Map(), total: 0 }
      this.days.set(day, bucket)
    }
    const key =
      bucket.counts.has(path) || bucket.counts.size < this.pathCap ? path : OTHER_BUCKET
    bucket.counts.set(key, (bucket.counts.get(key) ?? 0) + 1)
    bucket.total += 1
  }

  /** True when there is anything to flush (cheap tick pre-check). */
  hasCounts(): boolean {
    return this.days.size > 0
  }

  /** Snapshot-and-clear all buckets for the flush. */
  drain(): DrainedDay[] {
    const out: DrainedDay[] = []
    for (const [day, bucket] of this.days) {
      const counts: Record<string, number> = {}
      for (const [path, count] of bucket.counts) counts[path] = count
      out.push({ day, counts, total: bucket.total })
    }
    this.days.clear()
    return out
  }
}

// ---------------------------------------------------------------------------
// Day-record (de)serialization — defensive, flat scalars only
// ---------------------------------------------------------------------------

export interface DayCountRecord {
  day: string
  total: number
  counts: Record<string, number>
}

/** One stored day record's data → parsed counts, or undefined when malformed. */
export function deserializeDayCounts(data: Record<string, unknown>): DayCountRecord | undefined {
  const key = typeof data.key === 'string' ? data.key : ''
  const day = typeof data.day === 'string' ? data.day : ''
  if (!isValidDay(day) || key !== dayKey(day)) return undefined
  const total =
    typeof data.total === 'number' && Number.isFinite(data.total) && data.total >= 0
      ? Math.floor(data.total)
      : 0
  const counts: Record<string, number> = {}
  if (typeof data.countsJson === 'string' && data.countsJson !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(data.countsJson)
    } catch {
      parsed = undefined
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const path of Object.keys(parsed as Record<string, unknown>)) {
        const count = (parsed as Record<string, unknown>)[path]
        if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue
        if (path === '' || path.length > BEACON_PATH_MAX) continue
        counts[path] = Math.floor(count)
      }
    }
  }
  return { day, total, counts }
}

export function serializeDayCounts(record: DayCountRecord): Record<string, unknown> {
  return {
    key: dayKey(record.day),
    day: record.day,
    total: record.total,
    countsJson: JSON.stringify(record.counts),
  }
}

/**
 * Merge a drained in-memory bucket into a stored day record (or none),
 * re-applying the distinct-path cap: when the union exceeds `pathCap`,
 * the LOWEST-count surplus paths collapse into `__other` (deterministic:
 * count desc, then path asc), so the record can never grow unboundedly
 * across flushes.
 */
export function mergeDayCounts(
  existing: DayCountRecord | undefined,
  drained: DrainedDay,
  pathCap: number,
): DayCountRecord {
  const merged: Record<string, number> = { ...(existing?.counts ?? {}) }
  for (const path of Object.keys(drained.counts)) {
    merged[path] = (merged[path] ?? 0) + drained.counts[path]!
  }
  const paths = Object.keys(merged).filter((p) => p !== OTHER_BUCKET)
  if (paths.length > pathCap) {
    paths.sort((a, b) => merged[b]! - merged[a]! || (a < b ? -1 : 1))
    let other = merged[OTHER_BUCKET] ?? 0
    for (const path of paths.slice(pathCap)) {
      other += merged[path]!
      delete merged[path]
    }
    merged[OTHER_BUCKET] = other
  }
  return {
    day: drained.day,
    total: (existing?.total ?? 0) + drained.total,
    counts: merged,
  }
}

// ---------------------------------------------------------------------------
// Flush + retention — storage access via structural collections
// ---------------------------------------------------------------------------

export interface DayRecordLike {
  id: string
  data: Record<string, unknown>
}

export interface DayCollectionLike {
  list: (options?: {
    filter?: Record<string, unknown>
    limit?: number
  }) => Promise<{ records: DayRecordLike[] }>
  create: (data: Record<string, unknown>) => Promise<unknown>
  update: (recordId: string, data: Record<string, unknown>) => Promise<unknown>
  delete: (recordId: string) => Promise<unknown>
}

/**
 * Drain an aggregator into its collection: per drained day, read the
 * newest stored record for the key (G10 newest-wins), merge, write
 * update-else-create. Schedule-tick use ONLY — never called from routes.
 */
export async function flushDayCounts(
  aggregator: BeaconAggregator,
  collection: DayCollectionLike,
  pathCap: number,
): Promise<void> {
  if (!aggregator.hasCounts()) return
  for (const drained of aggregator.drain()) {
    const { records } = await collection.list({ filter: { key: dayKey(drained.day) }, limit: 10 })
    const newest = records[0]
    const existing = newest !== undefined ? deserializeDayCounts(newest.data) : undefined
    const merged = mergeDayCounts(existing, drained, pathCap)
    const data = serializeDayCounts(merged)
    if (newest !== undefined) await collection.update(newest.id, data)
    else await collection.create(data)
  }
}

/**
 * Delete day records older than the retention window (plus keyless
 * garbage), capped per call. Never runs over a possibly-truncated list
 * (host 1000-record cap) — with ≤ ~60 live records the cap is unreachable
 * unless something is badly wrong, and then we must not guess.
 */
export async function pruneExpiredDayRecords(
  collection: DayCollectionLike,
  now: number,
  maxDeletes: number = DAY_PRUNE_CAP,
): Promise<number> {
  const { records } = await collection.list({ limit: 1000 })
  if (records.length >= 1000) return 0
  const cutoff = retentionCutoffDay(now)
  let deleted = 0
  for (const record of records) {
    if (deleted >= maxDeletes) break
    const parsed = deserializeDayCounts(record.data)
    if (parsed !== undefined && parsed.day >= cutoff) continue
    await collection.delete(record.id)
    deleted++
  }
  return deleted
}

// ---------------------------------------------------------------------------
// Stats read model (task 2.6) — feeds GET /stats + the dashboard widget
// ---------------------------------------------------------------------------

/** Days covered by the dashboard widget's stats window (today inclusive). */
export const STATS_WINDOW_DAYS = 7

export interface StatsDayEntry {
  day: string
  views: number
  notFound: number
}

export interface StatsPayload {
  days: StatsDayEntry[]
  totals: { views: number; notFound: number }
}

/**
 * Newest-wins day→total map over one collection's raw records (G10:
 * duplicate records from write races are tolerated in memory, never
 * deleted here — GET /stats is strictly read-only). `records` must be in
 * the host's default `created_at desc` order, so the FIRST VALID record
 * per day wins.
 *
 * STRICTNESS (review C#4): `deserializeDayCounts` deliberately degrades
 * malformed fields (total → 0, countsJson → {}) because the flush merge
 * must never lose a day over one bad field — but for a READ model that
 * leniency would let a corrupt NEWEST duplicate (e.g. total `"oops"`)
 * zero out a day whose OLDER duplicate is intact. Here a record with an
 * invalid `total` or an unparseable/non-object `countsJson` is SKIPPED
 * entirely, so the older valid duplicate wins instead.
 */
export function newestDayTotals(records: readonly DayRecordLike[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const record of records) {
    const raw = record.data
    if (typeof raw.total !== 'number' || !Number.isFinite(raw.total) || raw.total < 0) continue
    if (typeof raw.countsJson === 'string' && raw.countsJson !== '') {
      let counts: unknown
      try {
        counts = JSON.parse(raw.countsJson)
      } catch {
        continue
      }
      if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) continue
    }
    const parsed = deserializeDayCounts(raw)
    if (parsed === undefined || totals.has(parsed.day)) continue
    totals.set(parsed.day, parsed.total)
  }
  return totals
}

/**
 * The GET /stats response body: the last `windowDays` UTC calendar days
 * (oldest → today, zero-filled — the sparkline needs a gap-free series)
 * with per-day view/404 totals and window totals.
 */
export function buildStatsPayload(
  views: ReadonlyMap<string, number>,
  notFound: ReadonlyMap<string, number>,
  now: number,
  windowDays: number = STATS_WINDOW_DAYS,
): StatsPayload {
  const days: StatsDayEntry[] = []
  let viewTotal = 0
  let notFoundTotal = 0
  for (let back = windowDays - 1; back >= 0; back--) {
    const day = utcDay(now - back * 24 * 60 * 60 * 1000)
    const dayViews = views.get(day) ?? 0
    const dayNotFound = notFound.get(day) ?? 0
    viewTotal += dayViews
    notFoundTotal += dayNotFound
    days.push({ day, views: dayViews, notFound: dayNotFound })
  }
  return { days, totals: { views: viewTotal, notFound: notFoundTotal } }
}

// ---------------------------------------------------------------------------
// Baked config tag — what the publish.html filter injects (spike G6)
// ---------------------------------------------------------------------------

/**
 * Build the inline config `<script>` the tracker contract requires
 * (`window.__mwSeoAnalytics = { endpoint, siteId, enabled }`, set BEFORE
 * the body-end tracker script tag — the seo marker block lives in <head>,
 * so document order guarantees it). `</` is escaped inside the JSON so the
 * payload can never close the wrapping tag or open a comment; the tag is
 * appended to the seo block VERBATIM (same discipline as the JSON-LD tag).
 *
 * Returns both the full tag and the exact SCRIPT TEXT between the tags —
 * the CSP sha256 hash must be computed over precisely those bytes.
 */
export function buildAnalyticsConfigTag(config: {
  endpoint: string
  siteId: string
  enabled: boolean
}): { tag: string; scriptText: string } {
  const json = JSON.stringify({
    endpoint: config.endpoint,
    siteId: config.siteId,
    enabled: config.enabled,
  }).replace(/</g, '\\u003c')
  const scriptText = `window.__mwSeoAnalytics=${json};`
  return { tag: `<script>${scriptText}</script>`, scriptText }
}

// ---------------------------------------------------------------------------
// Tracker tag — removing the host-injected script when analytics is off
// ---------------------------------------------------------------------------

/** Package-relative tracker path — must match `frontend.assets[]` in the manifest. */
export const TRACKER_ASSET_PATH = 'assets/tracker.js'

/** The host's own attribute escape (vendor frontendInjections.ts `escapeAttr`). */
function escapeHostAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * The tracker `<script>` tag EXACTLY as the host renders this plugin's
 * manifest asset (vendor server/publish/frontendInjections.ts `renderAsset`,
 * kind 'script', strategy 'defer', no extra attrs):
 * `<script src="<assetUrl>" defer data-plugin-id="<id>"></script>`.
 * `assetUrl` is `api.plugin.assetUrl(TRACKER_ASSET_PATH)`.
 */
export function trackerScriptTag(assetUrl: string, pluginId: string): string {
  return `<script src="${escapeHostAttr(assetUrl)}" defer data-plugin-id="${escapeHostAttr(pluginId)}"></script>`
}

/**
 * Remove the host-injected tracker tag from a published document.
 *
 * Why: `frontend.assets[]` is manifest-static — the host splices the tag
 * into EVERY page of every site whether or not analytics is on (spike G6;
 * it has no per-site or per-page condition). The tracker returns at once
 * without the baked config tag, but the browser still pays one request per
 * page for it. The host runs the `publish.html` filter AFTER that splice
 * (publishedHtmlPipeline.ts stages 2 → 3), so the filter drops the tag
 * whenever it is not also baking the config tag the tracker needs.
 *
 * Exact-string match on the host's rendered tag, for this plugin's id and
 * asset URL only: nothing else in the document can be touched, and a host
 * that ever renders the tag differently simply stops matching — the page
 * keeps the (inert) script, which is the pre-existing behaviour. The host
 * joins tags with `\n`, so one following newline goes with the tag and
 * the spot is byte-identical to a document the host never injected into.
 * The CSP `script-src 'self'` the host added for the asset is left alone.
 */
export function stripTrackerTag(html: string, assetUrl: string, pluginId: string): string {
  if (assetUrl === '' || pluginId === '') return html
  const tag = trackerScriptTag(assetUrl, pluginId)
  if (!html.includes(tag)) return html
  return html.split(`${tag}\n`).join('').split(tag).join('')
}

/** Public beacon route paths (registered in server/index.ts). */
export const BEACON_ROUTE = '/beacon'
export const NOTFOUND_BEACON_ROUTE = '/beacon404'

/** Root-relative endpoint URL for a beacon route (same-origin fetch). */
export function beaconEndpoint(pluginId: string, route: string): string {
  return `/admin/api/cms/plugins/${pluginId}/runtime${route}`
}

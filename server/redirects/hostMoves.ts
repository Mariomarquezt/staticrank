/**
 * Host slug-move observations (wave 3.3, slice A — FREE tier:
 * "visibility, not management"). Written from the publish.after path via
 * sitemap.ts's `onSlugMove` callback when the stored seo-sitemap slug
 * differs from the freshly published one.
 *
 * ── VENDOR VERIFICATION: do PAGE slug renames get a host 301? ── NO. ──
 * At pin 6b055cf78, PAGE slug renames do NOT insert into
 * `data_row_redirects` and are NOT served host 301s:
 *
 * 1. Pages are rows of the system `pages` data table
 *    (vendor server/repositories/publish.ts:4 — "Pages are stored in
 *    `data_rows` (table_id = 'pages')"), but pages publish through the
 *    FULL-SITE path: handlers/cms/publish.ts:25,49 → `publishDraftSite` →
 *    `persistSitePublish` (server/repositories/publish.ts:241), whose
 *    transaction contains NO `data_row_redirects` write (grep of that
 *    file: zero matches).
 * 2. The ONLY publish-time redirect insert lives in
 *    `persistDataRowPublish` (server/repositories/data/publish.ts:180-194),
 *    reached exclusively from the single-ROW publish path
 *    (server/publish/publishRow.ts:67) — the data-row endpoint, not the
 *    site/page publish.
 * 3. Even a hypothetical redirect row for a page would be UNSERVABLE:
 *    `resolvePublicRoute` (server/publish/publicRouter.ts:148) only
 *    reaches its redirect arm (line 183) via `contentRouteFromPath`
 *    (publicRouter.ts:104-107), which returns null for one-segment paths
 *    — and the pages table's `route_base` is '' (migrations-sqlite.ts:241),
 *    so no `/table/slug`-shaped URL can ever match it either.
 *
 * DATA-ROW slug renames DO get automatic host 301s (the G3 evidence).
 * UI copy for the records stored here must therefore say "URL changed"
 * for pages — NOT "the host serves a 301".
 *
 * G10 discipline: append-only create per observed move; retention prune
 * (oldest beyond MAX_SLUGMOVE_RECORDS) runs on the same publish.after
 * path — hooks only fire for admin actions (authenticated-equivalent) —
 * with deletes capped at SLUGMOVE_DELETE_CAP per pass and refused over a
 * possibly-truncated list. Reads resolve duplicates newest-wins by key.
 */

import {
  MAX_SLUGMOVE_RECORDS,
  SLUGMOVES_RESOURCE_ID,
  type SlugMoveRecord,
} from './types'

// ---------------------------------------------------------------------------
// Storage shapes — structural, injectable (house *Like style). Declared
// locally (NOT imported from store.ts): this module is FREE-tier and must
// never pull the pro-only store into the free bundle.
// ---------------------------------------------------------------------------

export interface SlugMoveRecordRowLike {
  id: string
  data: Record<string, unknown>
}

export interface SlugMoveCollectionLike {
  list: (options?: {
    filter?: Record<string, unknown>
    limit?: number
  }) => Promise<{ records: SlugMoveRecordRowLike[] }>
  create: (data: Record<string, unknown>) => Promise<unknown>
  update: (recordId: string, data: Record<string, unknown>) => Promise<unknown>
  delete: (recordId: string) => Promise<unknown>
}

export interface SlugMoveStorageLike {
  collection: (resourceId: string) => SlugMoveCollectionLike
}

/** Host storage list cap (StorageListOptionsSchema caps limit at 1000). */
const SLUGMOVE_LIST_LIMIT = 1000

/** Max record deletions per prune pass (house capped-cleanup style). */
export const SLUGMOVE_DELETE_CAP = 25

/** GET /redirects/hostmoves response cap (contract in ./types.ts). */
export const SLUGMOVE_READ_CAP = 200

// ---------------------------------------------------------------------------
// (De)serialization — defensive (records are storage data)
// ---------------------------------------------------------------------------

function readString(data: Record<string, unknown>, field: string): string | undefined {
  const value = data[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** One record's data → move, or undefined when malformed (skip, never throw). */
export function parseSlugMoveRecordData(data: unknown): SlugMoveRecord | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const raw = data as Record<string, unknown>
  const key = readString(raw, 'key')
  const pageId = readString(raw, 'pageId')
  const fromSlug = readString(raw, 'fromSlug')
  const toSlug = readString(raw, 'toSlug')
  const at = readString(raw, 'at')
  if (key === undefined || pageId === undefined || at === undefined) return undefined
  if (fromSlug === undefined || toSlug === undefined) return undefined
  if (!key.startsWith(`move:${pageId}:`)) return undefined
  return { key, pageId, fromSlug, toSlug, at }
}

/** Flat record data — exactly SLUGMOVE_FIELD_IDS (host drops the rest). */
export function serializeSlugMoveRecord(record: SlugMoveRecord): Record<string, unknown> {
  return {
    key: record.key,
    pageId: record.pageId,
    fromSlug: record.fromSlug,
    toSlug: record.toSlug,
    at: record.at,
  }
}

/** Per-VM monotonic counter for key uniqueness (G12: no CSPRNG in the
 * sandbox, and none needed — uniqueness, not unpredictability). */
let slugMoveCounter = 0

/**
 * Contract key shape: `move:<pageId>:<base36 time><counter><random>`.
 *
 * The time alone collided: two publish.after hooks for the SAME page inside
 * one millisecond produced identical keys, and `listSlugMoves` dedupes by
 * key — so one of the two observations silently disappeared from the read.
 * The counter + random tail is the `generateRuleId` shape (store.ts), and
 * the `move:<pageId>:` prefix stays intact so `parseSlugMoveRecordData`'s
 * prefix check is unaffected. Base36 time keeps a fixed width until the
 * year 5188, so key ordering still tracks creation order (the prune
 * tie-break relies on that).
 */
export function slugMoveKey(pageId: string, now: number): string {
  slugMoveCounter = (slugMoveCounter + 1) % 46656 // 36^3
  const counter = slugMoveCounter.toString(36).padStart(3, '0')
  const rand = Math.floor(Math.random() * 2821109907456) // 36^8
    .toString(36)
    .padStart(8, '0')
  return `move:${pageId}:${now.toString(36)}${counter}${rand}`
}

function slugMovesCollection(storage: SlugMoveStorageLike): SlugMoveCollectionLike {
  return storage.collection(SLUGMOVES_RESOURCE_ID)
}

// ---------------------------------------------------------------------------
// Record + prune (publish.after path) and read (free route)
// ---------------------------------------------------------------------------

/**
 * Append one observed move, then prune the oldest records beyond
 * MAX_SLUGMOVE_RECORDS (by `at` ascending; deletes capped, truncated
 * lists refused). Callers on the publish path must swallow failures —
 * the observation must never break a publish (sitemap.ts guarantees it).
 */
export async function recordSlugMove(
  storage: SlugMoveStorageLike,
  move: { pageId: string; fromSlug: string; toSlug: string },
  now: Date,
): Promise<SlugMoveRecord> {
  const collection = slugMovesCollection(storage)
  const record: SlugMoveRecord = {
    key: slugMoveKey(move.pageId, now.getTime()),
    pageId: move.pageId,
    fromSlug: move.fromSlug,
    toSlug: move.toSlug,
    at: now.toISOString(),
  }
  await collection.create(serializeSlugMoveRecord(record))

  // Retention prune — oldest first, capped, never over a truncated list.
  const { records } = await collection.list({ limit: SLUGMOVE_LIST_LIMIT })
  if (records.length >= SLUGMOVE_LIST_LIMIT) return record
  const parsed: Array<{ id: string; key: string; at: string }> = []
  for (const row of records) {
    const parsedRecord = parseSlugMoveRecordData(row.data)
    if (parsedRecord !== undefined) {
      parsed.push({ id: row.id, key: parsedRecord.key, at: parsedRecord.at })
    }
  }
  const excess = parsed.length - MAX_SLUGMOVE_RECORDS
  if (excess > 0) {
    // Review fix (wave 3.3, #9): NEVER prune the record this call just
    // created — a burst of same-`at` moves must not eat the freshest
    // observation. Order deterministically: `at` desc, then `key` desc
    // (keys embed base36 time, so key order tracks creation order), and
    // prune strictly from the TAIL (the oldest entries).
    const candidates = parsed.filter((row) => row.key !== record.key)
    candidates.sort((a, b) =>
      a.at < b.at ? 1 : a.at > b.at ? -1 : a.key < b.key ? 1 : a.key > b.key ? -1 : 0,
    )
    const victimCount = Math.min(excess, SLUGMOVE_DELETE_CAP, candidates.length)
    const victims = candidates.slice(candidates.length - victimCount).reverse() // oldest first
    for (const victim of victims) {
      await collection.delete(victim.id)
    }
  }
  return record
}

/**
 * All stored moves — newest-wins by key (G10 duplicate tolerance), `at`
 * descending, capped at SLUGMOVE_READ_CAP. Read-only, no cleanup.
 */
export async function listSlugMoves(storage: SlugMoveStorageLike): Promise<SlugMoveRecord[]> {
  const { records } = await slugMovesCollection(storage).list({ limit: SLUGMOVE_LIST_LIMIT })
  const seen = new Set<string>()
  const moves: SlugMoveRecord[] = []
  for (const row of records) {
    const move = parseSlugMoveRecordData(row.data)
    if (move === undefined || seen.has(move.key)) continue
    seen.add(move.key)
    moves.push(move)
  }
  moves.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key < b.key ? -1 : 1))
  return moves.slice(0, SLUGMOVE_READ_CAP)
}

// ---------------------------------------------------------------------------
// Route handler — FREE (registered in server/index.ts, NOT pro-gated).
// Lives here so index.ts can import it without touching the pro-only
// routes/store modules; routes.ts re-exports it for the pro bundle.
// ---------------------------------------------------------------------------

/** GET /redirects/hostmoves → { moves } (at desc, cap 200). */
export function makeHostMovesHandler(deps: { storage: SlugMoveStorageLike }) {
  return async (): Promise<{ moves: SlugMoveRecord[] }> => {
    return { moves: await listSlugMoves(deps.storage) }
  }
}

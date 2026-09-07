/**
 * seoState — SERVER-OWNED runtime state (task 2.2 review fix #9/#10).
 *
 * Lives in its own `seo-state` storage collection, deliberately OUTSIDE
 * the `seo-config` collection: POST /config is a FULL REPLACE and
 * DELETE /config wipes every seo-config record, so any server-owned value
 * stored there (the IndexNow key!) would be destroyed by ordinary admin
 * saves. Admin-facing config keeps only `indexNow.enabled`; everything
 * the server writes lives here:
 *
 *   key `indexnow`   — indexNowKey, lastSubmittedAt, lastStatus
 *   key `reconcile`  — cursor (offset of the next sitemap-record batch the
 *                      maintenance tick will reconcile — review fix #5)
 *
 * Migration: pre-review builds embedded the key/status in the seo-config
 * `indexnow` record. `loadIndexNowState` lifts that legacy state into
 * `seo-state` once (first read that finds no state key but a legacy one)
 * and thereafter ignores the legacy record — the next /config full
 * replace or DELETE clears it harmlessly.
 *
 * Same G10 discipline as every other collection: no upsert/unique key —
 * newest-wins reads, update-else-create writes, and status writes RE-READ
 * and merge before writing (review fix #10) so a concurrent key write is
 * never clobbered by a status write built from a stale snapshot. Decoration
 * failures are append-only event records because their tally has no CAS, then
 * compacted to a bounded aggregate once the event ceiling is reached.
 */

import { INDEXNOW_KEY_RE } from './indexNow'
import { HOST_LIST_LIMIT, INDEXNOW_CONFIG_KEY } from './seoConfig'

// ---------------------------------------------------------------------------
// Constants + shapes
// ---------------------------------------------------------------------------

/** Manifest resource id — must match instatic-plugin.config.ts. */
export const SEO_STATE_RESOURCE_ID = 'seo-state'

export const INDEXNOW_STATE_KEY = 'indexnow'
export const RECONCILE_STATE_KEY = 'reconcile'
/** Task 3.9 — operator-chosen AI model id (Pro). Lives HERE, not in
 * seo-config, for two reasons: (1) the host's plugin-settings form cannot
 * render a searchable 400-entry picker, so the choice is made in OUR AI
 * tab and must be written by a plugin route; (2) keeping it out of
 * seo-config leaves POST /config's presence-first section semantics
 * untouched (the 2.3 lost-toggle class of bug). It OVERRIDES the host
 * `aiModel` setting; clearing it falls back to that setting, then to the
 * provider default. */
export const AI_STATE_KEY = 'ai'

/** Key holding the "a publish shipped without its SEO tags" tally. */
export const DECORATION_STATE_KEY = 'decoration'

/** Flat record-data field ids (manifest `seo-state` resource). */
export const SEO_STATE_FIELD_IDS = [
  'key',
  'indexNowKey',
  'lastSubmittedAt',
  'lastStatus',
  'cursor',
  'aiModel',
  // Task: publish decoration failures (review 2026-08-15) — key
  // `decoration`. The publish filter is read-only, so it records failures
  // in memory and publish.after persists the tally here.
  'lastFailureAt',
  'failureCount',
  'failurePages',
] as const

/** Task 3.9 — bound on a stored model id. Provider model ids are short
 * (`openai/gpt-4o-mini`, `claude-haiku-4-5-20251001`); anything longer is
 * junk and is refused before it can reach a provider request body. */
export const AI_MODEL_MAX_LENGTH = 200

/** Printable, whitespace-free model ids only — preserve the old printable
 * ASCII surface, except for markup and obvious credential prefixes. */
export const AI_MODEL_RE = /^(?!.*[<>&"'])(?!(?:sk|GOCSPX)[-_]|AIza|1\/\/)[\x21-\x7e]+$/

export interface IndexNowState {
  key?: string
  lastSubmittedAt?: string
  lastStatus?: string
}

// ---------------------------------------------------------------------------
// (De)serialization — defensive, pure
// ---------------------------------------------------------------------------

export function deserializeIndexNowState(data: Record<string, unknown>): IndexNowState {
  const state: IndexNowState = {}
  if (typeof data.indexNowKey === 'string' && INDEXNOW_KEY_RE.test(data.indexNowKey)) {
    state.key = data.indexNowKey
  }
  if (typeof data.lastSubmittedAt === 'string' && data.lastSubmittedAt !== '') {
    state.lastSubmittedAt = data.lastSubmittedAt
  }
  if (typeof data.lastStatus === 'string' && data.lastStatus !== '') {
    state.lastStatus = data.lastStatus
  }
  return state
}

export function serializeIndexNowState(state: IndexNowState): Record<string, unknown> {
  const data: Record<string, unknown> = { key: INDEXNOW_STATE_KEY }
  if (state.key) data.indexNowKey = state.key
  if (state.lastSubmittedAt) data.lastSubmittedAt = state.lastSubmittedAt
  if (state.lastStatus) data.lastStatus = state.lastStatus
  return data
}

/** Reconcile cursor from a record's data; 0 for anything malformed. */
export function deserializeReconcileCursor(data: Record<string, unknown>): number {
  const value = data.cursor
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0
}

// ---------------------------------------------------------------------------
// Storage access — structural collections, injectable in tests
// ---------------------------------------------------------------------------

export interface StateRecordLike {
  id: string
  data: Record<string, unknown>
}

export interface StateCollectionLike {
  list: (options?: {
    filter?: Record<string, unknown>
    limit?: number
  }) => Promise<{ records: StateRecordLike[] }>
  create: (data: Record<string, unknown>) => Promise<unknown>
  update: (recordId: string, data: Record<string, unknown>) => Promise<unknown>
  delete: (recordId: string) => Promise<unknown>
}

/** Newest record for a state key (G10 newest-wins; duplicates tolerated). */
async function newestStateRecord(
  collection: StateCollectionLike,
  key: string,
): Promise<StateRecordLike | undefined> {
  const { records } = await collection.list({ filter: { key }, limit: 100 })
  return records[0]
}

/**
 * Read the IndexNow state, lifting LEGACY seo-config-embedded state on
 * first contact (see module header). `legacyConfigCollection` is the
 * seo-config collection; only its raw `indexnow` record is inspected —
 * reads of undeclared legacy fields work because the host validates
 * record fields at WRITE time only (vendor src/core/plugins/
 * resourceRecords.ts `validatePluginRecordData` — called from the record
 * CRUD handlers, never on list/read).
 */
export async function loadIndexNowState(
  collection: StateCollectionLike,
  legacyConfigCollection: StateCollectionLike,
  options: { migrate?: boolean } = {},
): Promise<IndexNowState> {
  const stateRecord = await newestStateRecord(collection, INDEXNOW_STATE_KEY)
  const state = stateRecord ? deserializeIndexNowState(stateRecord.data) : {}
  if (state.key !== undefined) return state

  // No usable key in seo-state — check for legacy embedded state once.
  const legacy = await newestStateRecord(legacyConfigCollection, INDEXNOW_CONFIG_KEY)
  if (legacy === undefined) return state
  const lifted = deserializeIndexNowState(legacy.data)
  if (lifted.key === undefined) return state

  const merged: IndexNowState = { ...lifted, ...state, key: lifted.key }
  // `migrate: false` (public-route callers) returns the merged VIEW
  // without persisting — anonymous requests never trigger storage writes;
  // the flush path (schedule tick) performs the actual one-time lift.
  if (options.migrate !== false) {
    await writeStateRecord(collection, stateRecord, serializeIndexNowState(merged))
  }
  return merged
}

/**
 * In-VM mutation fence for the IndexNow state records (round-6 glmflash-10
 * and glmflash-11). The re-read below narrows the read-modify-write window
 * but does NOT close it: `update` is a full replace and this host pin has
 * no compare-and-set (G10), so between the read and the write another
 * writer in the SAME VM could interleave and lose fields.
 *
 * There is exactly ONE VM per plugin for its whole uptime, so chaining the
 * mutators here really does serialize them on this host — the same
 * reasoning, and the same shape, as `withRedirectMutationLock` in
 * server/redirects/store.ts. Cross-HOST interleaving stays G10 and is not
 * fixable from inside the sandbox.
 *
 * Only the two MUTATORS take the fence. `loadIndexNowState` deliberately
 * does not: it is called from a public route, and making anonymous reads
 * queue behind a write is a denial-of-service lever, not a safety gain.
 */
let indexNowStateChain: Promise<unknown> = Promise.resolve()

function withIndexNowStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexNowStateChain.then(fn, fn)
  // Swallow rejections on the CHAIN only; `run` still rejects to the caller.
  indexNowStateChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Merge-write the IndexNow state: RE-READS the newest record and applies
 * the patch over what is stored NOW (not over a caller snapshot), so a
 * status write racing a key write never erases the key (#10). The read and
 * the write are held under the in-VM fence so a concurrent patch or clear
 * cannot interleave between them.
 */
export async function patchIndexNowState(
  collection: StateCollectionLike,
  patch: IndexNowState,
): Promise<IndexNowState> {
  return withIndexNowStateLock(async () => {
    const record = await newestStateRecord(collection, INDEXNOW_STATE_KEY)
    const current = record ? deserializeIndexNowState(record.data) : {}
    const next: IndexNowState = { ...current, ...patch }
    await writeStateRecord(collection, record, serializeIndexNowState(next))
    return next
  })
}

/** Clear the current and legacy IndexNow keys so the next flush rotates them. */
export async function clearIndexNowState(
  collection: StateCollectionLike,
  legacyConfigCollection: StateCollectionLike,
): Promise<void> {
  return withIndexNowStateLock(async () => {
    const stateRecords = (
      await collection.list({ filter: { key: INDEXNOW_STATE_KEY }, limit: HOST_LIST_LIMIT })
    ).records
    for (const record of stateRecords) {
      // IndexNowState is exactly key + lastSubmittedAt + lastStatus. Rotation
      // deliberately replaces the record to clear all three; pending/in-flight
      // submission state lives on sitemap records and in the tick, not here.
      await collection.update(record.id, { key: INDEXNOW_STATE_KEY })
    }

    // The legacy record is owned by the seo-config MODULE, and `update` is a
    // full replace. Building the replacement from a snapshot taken before
    // the state writes above meant a config save landing in that gap was
    // silently clobbered (round-6 glmflash-11). Re-read immediately before
    // each write so the replacement is built from the freshest data this VM
    // can see.
    //
    // HONEST LIMIT: the seo-config writer is a different code path and does
    // NOT take this fence, so a config save can still land between this read
    // and this update. Closing that needs either a compare-and-set (G10, not
    // available at this pin) or one lock shared with seoConfig.ts. What is
    // removed here is the stale-SNAPSHOT part of the defect, not the race.
    const legacyRecords = (
      await legacyConfigCollection.list({
        filter: { key: INDEXNOW_CONFIG_KEY },
        limit: HOST_LIST_LIMIT,
      })
    ).records
    for (const record of legacyRecords) {
      const fresh = (
        await legacyConfigCollection.list({
          filter: { key: INDEXNOW_CONFIG_KEY },
          limit: HOST_LIST_LIMIT,
        })
      ).records.find((candidate) => candidate.id === record.id)
      // Gone since the first list: nothing to strip, and re-creating it
      // would resurrect a record someone just deleted.
      if (fresh === undefined) continue
      const data = { ...fresh.data }
      delete data.indexNowKey
      delete data.lastSubmittedAt
      delete data.lastStatus
      await legacyConfigCollection.update(record.id, data)
    }
  })
}

/** Validate an operator-supplied model id (shared by route + storage). */
export function isValidAiModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.length <= AI_MODEL_MAX_LENGTH &&
    AI_MODEL_RE.test(value)
  )
}

/** Read the operator's chosen AI model (undefined when unset/malformed —
 * a junk stored value is IGNORED, never surfaced to a provider call). */
export async function loadAiModelOverride(
  collection: StateCollectionLike,
): Promise<string | undefined> {
  const record = await newestStateRecord(collection, AI_STATE_KEY)
  if (record === undefined) return undefined
  const value = record.data.aiModel
  return isValidAiModelId(value) ? value : undefined
}

/** Persist (or clear, with `undefined`) the operator's chosen AI model.
 * Update-else-create, same G10 discipline as the cursor. */
export async function saveAiModelOverride(
  collection: StateCollectionLike,
  model: string | undefined,
): Promise<void> {
  const record = await newestStateRecord(collection, AI_STATE_KEY)
  const data: Record<string, unknown> = { key: AI_STATE_KEY }
  if (model !== undefined && isValidAiModelId(model)) data.aiModel = model
  await writeStateRecord(collection, record, data)
}

/** How many failed page ids the record keeps (newest first). */
export const DECORATION_PAGES_CAP = 20

/**
 * Read gate for deserializeDecorationFailure: worst-case serialized
 * failurePages JSON — DECORATION_PAGES_CAP ids of ≤256 fully-escaped
 * chars (host page ids are UUID-sized; 256 is a generous ceiling), plus
 * array/quote/comma overhead.
 */
export const DECORATION_PAGES_JSON_MAX = 2 + DECORATION_PAGES_CAP * (2 + 256 * 6 + 1)

/** Physical decoration-event ceiling; older events are folded into one record. */
export const DECORATION_RECORDS_CAP = 25

/** A stalled host delete must not consume an unbounded number of storage calls. */
const DECORATION_COMPACTION_MAX_PASSES = 2

export interface DecorationFailureState {
  lastFailureAt?: string
  failureCount: number
  failurePages: string[]
}

export function deserializeDecorationFailure(
  data: Record<string, unknown>,
): DecorationFailureState {
  const count = data.failureCount
  const pagesRaw = data.failurePages
  let pages: string[] = []
  // Raw-length gate BEFORE JSON.parse (same posture as seoMeta's focus-
  // keywords gate): serializeDecorationFailure writes at most
  // DECORATION_PAGES_CAP ids, so anything far past that worst case is a
  // hand-edited record and must not burn the eval budget. Like the catch
  // below, an over-long list must not hide the count.
  if (
    typeof pagesRaw === 'string' &&
    pagesRaw !== '' &&
    pagesRaw.length <= DECORATION_PAGES_JSON_MAX
  ) {
    try {
      const parsed = JSON.parse(pagesRaw)
      if (Array.isArray(parsed)) pages = parsed.filter((p): p is string => typeof p === 'string')
    } catch {
      // A corrupt list must not hide the count.
    }
  }
  return {
    ...(typeof data.lastFailureAt === 'string' && data.lastFailureAt !== ''
      ? { lastFailureAt: data.lastFailureAt }
      : {}),
    failureCount:
      typeof count === 'number' && Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
    failurePages: pages.slice(0, DECORATION_PAGES_CAP),
  }
}

function serializeDecorationFailure(state: DecorationFailureState): Record<string, unknown> {
  return {
    key: DECORATION_STATE_KEY,
    ...(state.lastFailureAt !== undefined ? { lastFailureAt: state.lastFailureAt } : {}),
    failureCount: state.failureCount,
    failurePages: JSON.stringify(state.failurePages.slice(0, DECORATION_PAGES_CAP)),
  }
}

function aggregateDecorationFailures(
  records: readonly StateRecordLike[],
): { state: DecorationFailureState; keeper: StateRecordLike } {
  const parsed = records.map((record) => ({ record, state: deserializeDecorationFailure(record.data) }))
  let failureCount = 0
  let lastFailureAt: string | undefined
  for (const { state } of parsed) {
    failureCount += state.failureCount
    if (
      state.lastFailureAt !== undefined &&
      (lastFailureAt === undefined || state.lastFailureAt > lastFailureAt)
    ) {
      lastFailureAt = state.lastFailureAt
    }
  }

  const ordered = [...parsed].sort((left, right) =>
    (right.state.lastFailureAt ?? '').localeCompare(left.state.lastFailureAt ?? ''),
  )
  const failurePages = ordered
    .flatMap(({ state }) => state.failurePages)
    .slice(0, DECORATION_PAGES_CAP)
  const keeper = ordered[0]!.record
  return {
    state: {
      ...(lastFailureAt !== undefined ? { lastFailureAt } : {}),
      failureCount,
      failurePages,
    },
    keeper,
  }
}

/** Fold old decoration events so this shared collection cannot grow without bound. */
async function compactDecorationFailures(collection: StateCollectionLike): Promise<void> {
  let keeperId: string | undefined
  for (let pass = 0; pass < DECORATION_COMPACTION_MAX_PASSES; pass++) {
    const { records } = await collection.list({
      filter: { key: DECORATION_STATE_KEY },
      limit: HOST_LIST_LIMIT,
    })
    if (records.length <= DECORATION_RECORDS_CAP) return

    const firstPass = keeperId === undefined
    const keeper = firstPass
      ? aggregateDecorationFailures(records).keeper
      : records.find((record) => record.id === keeperId)
    if (keeper === undefined) return
    if (firstPass) keeperId = keeper.id

    for (const record of records) {
      if (record.id !== keeperId) await collection.delete(record.id)
    }

    // Do not fold a record until the host confirms that its old copy is gone;
    // otherwise a no-op delete would count that event again on the next pass.
    const { records: remaining } = await collection.list({
      filter: { key: DECORATION_STATE_KEY },
      limit: HOST_LIST_LIMIT,
    })
    const remainingIds = new Set(remaining.map((record) => record.id))
    const deleted = records.filter(
      (record) => record.id !== keeperId && !remainingIds.has(record.id),
    )
    if (deleted.length > 0) {
      const { state } = aggregateDecorationFailures([keeper, ...deleted])
      await collection.update(keeperId, serializeDecorationFailure(state))
    }
  }
  // If the host did not remove the stale records, leave the backlog for the
  // next call to retry rather than spinning here forever.
}

function summarizeDecorationFailures(
  records: readonly StateRecordLike[],
): DecorationFailureState {
  let failureCount = 0
  let lastFailureAt: string | undefined
  let failurePages: string[] = []
  for (const record of records) {
    const state = deserializeDecorationFailure(record.data)
    failureCount += state.failureCount
    if (
      state.lastFailureAt !== undefined &&
      (lastFailureAt === undefined || state.lastFailureAt > lastFailureAt)
    ) {
      lastFailureAt = state.lastFailureAt
    }
    failurePages = [...failurePages, ...state.failurePages].slice(0, DECORATION_PAGES_CAP)
  }
  return {
    ...(lastFailureAt !== undefined ? { lastFailureAt } : {}),
    failureCount,
    failurePages,
  }
}

/** Read the "publishes that shipped without SEO tags" tally. */
export async function loadDecorationFailure(
  collection: StateCollectionLike,
): Promise<DecorationFailureState> {
  const beforeCompaction = await collection.list({
    filter: { key: DECORATION_STATE_KEY },
    limit: HOST_LIST_LIMIT,
  })
  // Also repairs an unbounded backlog left by older plugin versions before
  // reading it, so the shared seo-state list is usable after an upgrade.
  try {
    await compactDecorationFailures(collection)
  } catch {
    // The tally is advisory: a failed repair must not prevent this read from
    // answering. The next call can retry the incomplete compaction.
    return summarizeDecorationFailures(beforeCompaction.records)
  }
  const { records } = await collection.list({
    filter: { key: DECORATION_STATE_KEY },
    limit: HOST_LIST_LIMIT,
  })
  return summarizeDecorationFailures(records)
}

/**
 * Add failed page ids as an append-only event. A read-merge-write would lose
 * one of two simultaneous publish.after failures; loading sums the events.
 * Once the bounded event budget is exceeded, the events are folded into one
 * aggregate record and the older physical records are deleted.
 */
export async function recordDecorationFailure(
  collection: StateCollectionLike,
  pageIds: readonly string[],
  atIso: string,
): Promise<void> {
  if (pageIds.length === 0) return
  await collection.create({
    key: DECORATION_STATE_KEY,
    lastFailureAt: atIso,
    failureCount: pageIds.length,
    failurePages: JSON.stringify(pageIds.slice(0, DECORATION_PAGES_CAP)),
  })
  await compactDecorationFailures(collection)
}

/** Read the maintenance-tick reconcile cursor (0 when unset). */
export async function loadReconcileCursor(collection: StateCollectionLike): Promise<number> {
  const record = await newestStateRecord(collection, RECONCILE_STATE_KEY)
  return record ? deserializeReconcileCursor(record.data) : 0
}

/** Persist the reconcile cursor (update-else-create). */
export async function saveReconcileCursor(
  collection: StateCollectionLike,
  cursor: number,
): Promise<void> {
  const record = await newestStateRecord(collection, RECONCILE_STATE_KEY)
  await writeStateRecord(collection, record, {
    key: RECONCILE_STATE_KEY,
    cursor: Math.max(0, Math.floor(cursor)),
  })
}

async function writeStateRecord(
  collection: StateCollectionLike,
  existing: StateRecordLike | undefined,
  data: Record<string, unknown>,
): Promise<void> {
  if (existing) await collection.update(existing.id, data)
  else await collection.create(data)
}

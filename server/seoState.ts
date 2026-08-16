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
 * never clobbered by a status write built from a stale snapshot.
 */

import { INDEXNOW_KEY_RE } from './indexNow'
import { INDEXNOW_CONFIG_KEY } from './seoConfig'

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

/** Flat record-data field ids (manifest `seo-state` resource). */
export const SEO_STATE_FIELD_IDS = [
  'key',
  'indexNowKey',
  'lastSubmittedAt',
  'lastStatus',
  'cursor',
  'aiModel',
] as const

/** Task 3.9 — bound on a stored model id. Provider model ids are short
 * (`openai/gpt-4o-mini`, `claude-haiku-4-5-20251001`); anything longer is
 * junk and is refused before it can reach a provider request body. */
export const AI_MODEL_MAX_LENGTH = 200

/** Printable, whitespace-free model ids only — a stored value flows into
 * a provider request body, so newlines/controls are rejected outright. */
export const AI_MODEL_RE = /^[\x21-\x7e]+$/

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
 * Merge-write the IndexNow state: RE-READS the newest record and applies
 * the patch over what is stored NOW (not over a caller snapshot), so a
 * status write racing a key write never erases the key (#10).
 */
export async function patchIndexNowState(
  collection: StateCollectionLike,
  patch: IndexNowState,
): Promise<IndexNowState> {
  const record = await newestStateRecord(collection, INDEXNOW_STATE_KEY)
  const current = record ? deserializeIndexNowState(record.data) : {}
  const next: IndexNowState = { ...current, ...patch }
  await writeStateRecord(collection, record, serializeIndexNowState(next))
  return next
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

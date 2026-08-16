import { describe, expect, test } from 'bun:test'
import { INDEXNOW_CONFIG_KEY } from '../seoConfig'
import {
  INDEXNOW_STATE_KEY,
  RECONCILE_STATE_KEY,
  deserializeIndexNowState,
  deserializeReconcileCursor,
  loadIndexNowState,
  loadReconcileCursor,
  patchIndexNowState,
  saveReconcileCursor,
  serializeIndexNowState,
  type StateCollectionLike,
  type StateRecordLike,
} from '../seoState'

const KEY = 'abcd1234abcd1234'

// ---------------------------------------------------------------------------
// Mock collection (same conventions as the other suites)
// ---------------------------------------------------------------------------

class MockCollection implements StateCollectionLike {
  records: StateRecordLike[] = []
  updates: Array<{ id: string; data: Record<string, unknown> }> = []

  async list(options: { filter?: Record<string, unknown>; limit?: number } = {}) {
    let matched = this.records
    if (options.filter !== undefined) {
      matched = matched.filter((r) =>
        Object.entries(options.filter!).every(([field, value]) => r.data[field] === value),
      )
    }
    return { records: matched.slice(0, options.limit ?? 50) }
  }

  async create(data: Record<string, unknown>) {
    const record = { id: `r${this.records.length}`, data }
    this.records.unshift(record) // newest first (created_at desc)
    return record
  }

  async update(recordId: string, data: Record<string, unknown>) {
    this.updates.push({ id: recordId, data })
    const record = this.records.find((r) => r.id === recordId)
    if (record) record.data = data
    return record ?? null
  }
}

// ---------------------------------------------------------------------------
// (De)serialization
// ---------------------------------------------------------------------------

describe('serialize/deserialize IndexNow state', () => {
  test('round-trips a full state', () => {
    const state = {
      key: KEY,
      lastSubmittedAt: '2026-08-14T00:00:00.000Z',
      lastStatus: 'ok 200 (3 urls)',
    }
    const data = serializeIndexNowState(state)
    expect(data.key).toBe(INDEXNOW_STATE_KEY)
    expect(deserializeIndexNowState(data)).toEqual(state)
  })

  test('malformed keys and empty fields are dropped', () => {
    expect(deserializeIndexNowState({ indexNowKey: 'bad key!', lastStatus: '' })).toEqual({})
    expect(deserializeIndexNowState({})).toEqual({})
  })
})

describe('deserializeReconcileCursor', () => {
  test('reads a non-negative integer, defaults 0 for garbage', () => {
    expect(deserializeReconcileCursor({ cursor: 300 })).toBe(300)
    expect(deserializeReconcileCursor({ cursor: 2.9 })).toBe(2)
    expect(deserializeReconcileCursor({ cursor: -5 })).toBe(0)
    expect(deserializeReconcileCursor({ cursor: 'x' })).toBe(0)
    expect(deserializeReconcileCursor({})).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// loadIndexNowState + legacy migration (review #9)
// ---------------------------------------------------------------------------

describe('loadIndexNowState', () => {
  test('reads the newest seo-state record', async () => {
    const state = new MockCollection()
    await state.create({ key: INDEXNOW_STATE_KEY, indexNowKey: KEY, lastStatus: 'ok' })
    const legacy = new MockCollection()
    expect(await loadIndexNowState(state, legacy)).toEqual({ key: KEY, lastStatus: 'ok' })
  })

  test('MIGRATION: lifts a legacy seo-config-embedded key into seo-state once', async () => {
    const state = new MockCollection()
    const legacy = new MockCollection()
    await legacy.create({
      key: INDEXNOW_CONFIG_KEY,
      indexNowKey: KEY,
      lastStatus: 'ok 200 (2 urls)',
      indexNowEnabled: false, // toggle stays in seo-config — not lifted
    })

    const lifted = await loadIndexNowState(state, legacy)
    expect(lifted).toEqual({ key: KEY, lastStatus: 'ok 200 (2 urls)' })
    // Persisted into seo-state:
    expect(state.records).toHaveLength(1)
    expect(state.records[0]!.data).toEqual({
      key: INDEXNOW_STATE_KEY,
      indexNowKey: KEY,
      lastStatus: 'ok 200 (2 urls)',
    })
    // Second read comes straight from seo-state (legacy untouched).
    expect(await loadIndexNowState(state, new MockCollection())).toEqual(lifted)
  })

  test('migrate:false returns the merged view WITHOUT writing (public routes)', async () => {
    const state = new MockCollection()
    const legacy = new MockCollection()
    await legacy.create({ key: INDEXNOW_CONFIG_KEY, indexNowKey: KEY })

    const view = await loadIndexNowState(state, legacy, { migrate: false })
    expect(view).toEqual({ key: KEY })
    expect(state.records).toHaveLength(0) // no write from the public path
  })

  test('no state, no legacy → empty state', async () => {
    expect(await loadIndexNowState(new MockCollection(), new MockCollection())).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// patchIndexNowState (review #10 — merge over what is stored NOW)
// ---------------------------------------------------------------------------

describe('patchIndexNowState', () => {
  test('a status patch never erases a concurrently-written key', async () => {
    const state = new MockCollection()
    // Key written by another path AFTER the (stale) caller snapshot was taken:
    await state.create({ key: INDEXNOW_STATE_KEY, indexNowKey: KEY })

    const next = await patchIndexNowState(state, {
      lastSubmittedAt: '2026-08-14T00:00:00.000Z',
      lastStatus: 'ok 200 (1 urls)',
    })
    expect(next.key).toBe(KEY) // survived — patch merged over the re-read
    expect(state.records[0]!.data.indexNowKey).toBe(KEY)
    expect(state.records[0]!.data.lastStatus).toBe('ok 200 (1 urls)')
  })

  test('creates the record when none exists', async () => {
    const state = new MockCollection()
    await patchIndexNowState(state, { key: KEY })
    expect(state.records).toHaveLength(1)
    expect(state.records[0]!.data).toEqual({ key: INDEXNOW_STATE_KEY, indexNowKey: KEY })
  })

  test('SCENARIO (review #9): /config DELETE wipes seo-config but the key survives in seo-state', async () => {
    const state = new MockCollection()
    const config = new MockCollection()
    await config.create({ key: 'site', siteName: 'Acme' })
    await patchIndexNowState(state, { key: KEY })

    // DELETE /config clears every seo-config record — a different collection.
    config.records = []
    expect(await loadIndexNowState(state, config)).toEqual({ key: KEY })
  })
})

// ---------------------------------------------------------------------------
// Reconcile cursor persistence (review #5)
// ---------------------------------------------------------------------------

describe('reconcile cursor', () => {
  test('round-trips across ticks, defaults 0', async () => {
    const state = new MockCollection()
    expect(await loadReconcileCursor(state)).toBe(0)
    await saveReconcileCursor(state, 300)
    expect(await loadReconcileCursor(state)).toBe(300)
    await saveReconcileCursor(state, 0)
    expect(await loadReconcileCursor(state)).toBe(0)
    // One record updated in place, keyed independently of the indexnow state.
    expect(state.records.filter((r) => r.data.key === RECONCILE_STATE_KEY)).toHaveLength(1)
  })

  test('coexists with the indexnow state record', async () => {
    const state = new MockCollection()
    await patchIndexNowState(state, { key: KEY })
    await saveReconcileCursor(state, 42)
    expect(await loadIndexNowState(state, new MockCollection())).toEqual({ key: KEY })
    expect(await loadReconcileCursor(state)).toBe(42)
  })
})

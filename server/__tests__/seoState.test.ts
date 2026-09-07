import { describe, expect, test } from 'bun:test'
import { HOST_LIST_LIMIT, INDEXNOW_CONFIG_KEY } from '../seoConfig'
import {
  DECORATION_PAGES_CAP,
  DECORATION_PAGES_JSON_MAX,
  DECORATION_RECORDS_CAP,
  DECORATION_STATE_KEY,
  INDEXNOW_STATE_KEY,
  isValidAiModelId,
  clearIndexNowState,
  RECONCILE_STATE_KEY,
  deserializeIndexNowState,
  deserializeReconcileCursor,
  loadDecorationFailure,
  loadIndexNowState,
  loadReconcileCursor,
  patchIndexNowState,
  recordDecorationFailure,
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

  async delete(recordId: string) {
    const index = this.records.findIndex((record) => record.id === recordId)
    if (index !== -1) this.records.splice(index, 1)
    return true
  }
}

class NoOpDeleteCollection extends MockCollection {
  deleteCalls = 0

  override async delete(_recordId: string) {
    this.deleteCalls++
    return true
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

describe('AI model id validation', () => {
  test('accepts real provider ids, including case, underscores, and fine-tune punctuation', () => {
    const ids = [
      'gpt-4o-mini',
      'openai/gpt-4o-mini:free',
      'ft:gpt-4o-mini-2024-07-18:AcmeCorp::9xyzAbc',
      'meta-llama/Llama-3.3-70B-Instruct',
      'Qwen/Qwen2.5-72B-Instruct',
      'gpt_4_turbo',
    ]
    for (const id of ids) expect(isValidAiModelId(id)).toBe(true)
  })

  test('rejects pasted provider credentials', () => {
    for (const credential of [
      'sk-proj-synthetic-key',
      'GOCSPX-synthetic-secret',
      // Split so the free-source secret scan never sees a contiguous
      // AIza… token in this file (it is a NEGATIVE fixture, not a key).
      'AIzaSy' + 'SyntheticGoogleApiKey',
      '1//synthetic-google-refresh-token',
    ]) {
      expect(isValidAiModelId(credential)).toBe(false)
    }
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

describe('clearIndexNowState', () => {
  test('clears server and legacy keys while retaining the legacy toggle', async () => {
    const state = new MockCollection()
    const legacy = new MockCollection()
    await state.create({
      key: INDEXNOW_STATE_KEY,
      indexNowKey: KEY,
      lastSubmittedAt: '2026-08-14T00:00:00.000Z',
      lastStatus: 'ok 200 (1 urls)',
    })
    await legacy.create({
      key: INDEXNOW_CONFIG_KEY,
      indexNowKey: KEY,
      lastSubmittedAt: '2026-08-14T00:00:00.000Z',
      lastStatus: 'ok 200 (1 urls)',
      indexNowEnabled: false,
    })

    await clearIndexNowState(state, legacy)

    expect(state.records[0]!.data).toEqual({ key: INDEXNOW_STATE_KEY })
    expect(legacy.records[0]!.data).toEqual({ key: INDEXNOW_CONFIG_KEY, indexNowEnabled: false })
    expect(await loadIndexNowState(state, legacy)).toEqual({})
  })

  test('clears more than 100 duplicate state records up to the host list cap', async () => {
    const state = new MockCollection()
    const legacy = new MockCollection()
    for (let i = 0; i < HOST_LIST_LIMIT; i++) {
      await state.create({
        key: INDEXNOW_STATE_KEY,
        indexNowKey: KEY,
        lastSubmittedAt: `2026-08-14T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        lastStatus: 'ok 200 (1 urls)',
      })
    }

    await clearIndexNowState(state, legacy)

    expect(state.records).toHaveLength(HOST_LIST_LIMIT)
    expect(state.records.every((record) => record.data)).toBe(true)
    expect(state.records.every((record) => Object.keys(record.data).every((key) => key === 'key'))).toBe(
      true,
    )
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

// ---------------------------------------------------------------------------
// Decoration failures (review 2026-08-15) — a publish that shipped a page
// with no SEO tags must be visible, not silent.
// ---------------------------------------------------------------------------

describe('decoration failure tally', () => {
  const AT = '2026-08-15T12:00:00.000Z'

  test('nothing recorded reads as a clean zero', async () => {
    const c = new MockCollection()
    expect(await loadDecorationFailure(c)).toEqual({ failureCount: 0, failurePages: [] })
  })

  test('recording accumulates the count and remembers the pages', async () => {
    const c = new MockCollection()
    await Promise.all([
      recordDecorationFailure(c, ['p1'], AT),
      recordDecorationFailure(c, ['p2', 'p3'], '2026-08-15T13:00:00.000Z'),
    ])
    const state = await loadDecorationFailure(c)
    expect(state.failureCount).toBe(3)
    // Newest first, so the admin sees what just broke.
    expect(state.failurePages).toEqual(['p2', 'p3', 'p1'])
    expect(state.lastFailureAt).toBe('2026-08-15T13:00:00.000Z')
    // Append-only events preserve both concurrent writes; reads aggregate them.
    expect(c.records.filter((r) => r.data.key === DECORATION_STATE_KEY).length).toBe(2)
  })

  test('an over-long hand-edited failurePages list is refused before JSON.parse but never hides the count (round 5 wave 2 O#6a)', async () => {
    const c = new MockCollection()
    // Legitimate worst case still parses…
    const maximalPages = JSON.stringify(Array.from({ length: DECORATION_PAGES_CAP }, (_, i) => `p${i}`))
    await c.create({ key: DECORATION_STATE_KEY, failureCount: 2, failurePages: maximalPages })
    expect((await loadDecorationFailure(c)).failurePages).toHaveLength(DECORATION_PAGES_CAP)
    // …a record bloated past the serializer's worst case is not parsed,
    // yet the count survives (same posture as the corrupt-JSON catch).
    const bloated = `["p1","${'x'.repeat(DECORATION_PAGES_JSON_MAX)}"]`
    const c2 = new MockCollection()
    await c2.create({ key: DECORATION_STATE_KEY, failureCount: 7, failurePages: bloated })
    const state = await loadDecorationFailure(c2)
    expect(state.failurePages).toEqual([])
    expect(state.failureCount).toBe(7)
  })

  test('BLOCKER regression: decoration records stay below the shared-state ceiling', async () => {
    const c = new MockCollection()
    for (let i = 0; i < DECORATION_RECORDS_CAP + 5; i++) {
      await recordDecorationFailure(
        c,
        [`p${i}`],
        `2026-08-15T12:${String(i).padStart(2, '0')}:00.000Z`,
      )
    }

    expect(c.records.filter((r) => r.data.key === DECORATION_STATE_KEY).length).toBeLessThanOrEqual(
      DECORATION_RECORDS_CAP,
    )
    expect((await loadDecorationFailure(c)).failureCount).toBe(DECORATION_RECORDS_CAP + 5)
  })

  test('returns when storage delete makes no progress', async () => {
    const c = new NoOpDeleteCollection()
    for (let i = 0; i < DECORATION_RECORDS_CAP + 5; i++) {
      await c.create({
        key: DECORATION_STATE_KEY,
        failureCount: 1,
        failurePages: JSON.stringify([`p${i}`]),
      })
    }

    const state = await loadDecorationFailure(c)

    expect(state.failureCount).toBe(DECORATION_RECORDS_CAP + 5)
    expect(c.records).toHaveLength(DECORATION_RECORDS_CAP + 5)
    expect(c.deleteCalls).toBeGreaterThan(0)
  })

  test('read still returns the tally when compaction storage fails', async () => {
    const c = new MockCollection()
    for (let i = 0; i < DECORATION_RECORDS_CAP + 5; i++) {
      await c.create({
        key: DECORATION_STATE_KEY,
        failureCount: 1,
        failurePages: JSON.stringify([`p${i}`]),
      })
    }
    c.delete = async () => {
      throw new Error('storage unavailable')
    }

    await expect(loadDecorationFailure(c)).resolves.toMatchObject({
      failureCount: DECORATION_RECORDS_CAP + 5,
    })
  })

  test('lastFailureAt is the maximum timestamp, not the first listed record', async () => {
    const c = new MockCollection()
    await c.create({
      key: DECORATION_STATE_KEY,
      lastFailureAt: '2026-08-15T13:00:00.000Z',
      failureCount: 1,
      failurePages: '["new"]',
    })
    await c.create({
      key: DECORATION_STATE_KEY,
      lastFailureAt: '2026-08-15T12:00:00.000Z',
      failureCount: 1,
      failurePages: '["old"]',
    })

    expect((await loadDecorationFailure(c)).lastFailureAt).toBe('2026-08-15T13:00:00.000Z')
  })

  test('an empty batch writes nothing at all', async () => {
    const c = new MockCollection()
    await recordDecorationFailure(c, [], AT)
    expect(c.records.length).toBe(0)
  })

  test('the page list is capped but the count keeps counting', async () => {
    const c = new MockCollection()
    const many = Array.from({ length: DECORATION_PAGES_CAP + 15 }, (_, i) => `p${i}`)
    await recordDecorationFailure(c, many, AT)
    const state = await loadDecorationFailure(c)
    expect(state.failurePages.length).toBe(DECORATION_PAGES_CAP)
    expect(state.failureCount).toBe(many.length)
  })

  test('a corrupt page list never hides the count', async () => {
    const c = new MockCollection()
    await c.create({ key: DECORATION_STATE_KEY, failureCount: 7, failurePages: 'not json' })
    const state = await loadDecorationFailure(c)
    expect(state.failureCount).toBe(7)
    expect(state.failurePages).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Round 6, glmflash-10 / glmflash-11 — the in-VM mutation fence
//
// The re-read inside patchIndexNowState narrows the read-modify-write window
// but cannot close it: `update` is a full replace and this pin has no
// compare-and-set (G10). With one VM per plugin, chaining the mutators DOES
// serialize them on this host. These tests interleave two mutators by making
// `list` yield, which is exactly what an await on a real storage RPC does.
// ---------------------------------------------------------------------------

/**
 * MockCollection that yields to the macrotask queue on EVERY operation.
 *
 * Yielding only in `list` is not enough: a `setTimeout` drains the whole
 * microtask queue before the next timer, so the first caller would run to
 * completion before the second ever resumed and no interleaving could occur.
 * A test that cannot fail proves nothing, so every operation yields — which
 * is also the honest model of a real storage RPC.
 */
class YieldingCollection extends MockCollection {
  private async yield(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  override async list(options: { filter?: Record<string, unknown>; limit?: number } = {}) {
    await this.yield()
    return super.list(options)
  }

  override async create(data: Record<string, unknown>) {
    await this.yield()
    return super.create(data)
  }

  override async update(recordId: string, data: Record<string, unknown>) {
    await this.yield()
    return super.update(recordId, data)
  }
}

describe('IndexNow state mutation fence', () => {
  test('two concurrent patches do not lose each other\'s fields', async () => {
    const state = new YieldingCollection()

    // Fired together, both read-modify-write the same record. Unfenced, both
    // read the empty state, and whichever writes last erases the other field.
    await Promise.all([
      patchIndexNowState(state, { key: KEY }),
      patchIndexNowState(state, { lastStatus: 'ok 200 (1 urls)' }),
    ])

    const stored = deserializeIndexNowState(state.records[0]!.data)
    expect(stored.key).toBe(KEY)
    expect(stored.lastStatus).toBe('ok 200 (1 urls)')
  })

  test('a clear racing a patch does not resurrect the cleared key', async () => {
    const state = new YieldingCollection()
    const legacy = new YieldingCollection()
    await state.create({ key: INDEXNOW_STATE_KEY, indexNowKey: KEY })

    // The admin presses "clear key" while the maintenance tick is writing a
    // submission status. Serialized, the clear is last and wins outright.
    const patching = patchIndexNowState(state, { lastStatus: 'ok 200 (1 urls)' })
    const clearing = clearIndexNowState(state, legacy)
    await Promise.all([patching, clearing])

    const stored = deserializeIndexNowState(state.records[0]!.data)
    expect(stored.key).toBeUndefined()
  })

  test('clearing rebuilds the legacy record from a re-read, not a stale snapshot', async () => {
    const state = new YieldingCollection()
    const legacy = new YieldingCollection()
    await legacy.create({
      key: INDEXNOW_CONFIG_KEY,
      indexNowKey: KEY,
      indexNowEnabled: true,
      version: 1,
    })

    await clearIndexNowState(state, legacy)

    const data = legacy.records[0]!.data
    expect(data.indexNowKey).toBeUndefined()
    expect(data.lastSubmittedAt).toBeUndefined()
    expect(data.lastStatus).toBeUndefined()
    // Fields the config module owns must survive the strip untouched.
    expect(data.indexNowEnabled).toBe(true)
    expect(data.version).toBe(1)
  })
})

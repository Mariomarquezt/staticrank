import { describe, expect, test } from 'bun:test'

import {
  listSlugMoves,
  makeHostMovesHandler,
  parseSlugMoveRecordData,
  recordSlugMove,
  serializeSlugMoveRecord,
  SLUGMOVE_DELETE_CAP,
  SLUGMOVE_READ_CAP,
  slugMoveKey,
} from '../hostMoves'
import { MAX_SLUGMOVE_RECORDS, SLUGMOVES_RESOURCE_ID, type SlugMoveRecord } from '../types'
import { makeMockStorage, NOW } from './harness'

function makeMove(overrides: Partial<SlugMoveRecord> = {}): SlugMoveRecord {
  const at = overrides.at ?? '2026-08-01T00:00:00.000Z'
  const pageId = overrides.pageId ?? 'p1'
  return {
    key: slugMoveKey(pageId, Date.parse(at)),
    pageId,
    fromSlug: 'old-slug',
    toSlug: 'new-slug',
    at,
    ...overrides,
  }
}

describe('recordSlugMove', () => {
  test('writes the contract record shape', async () => {
    const storage = makeMockStorage()
    const record = await recordSlugMove(
      storage,
      { pageId: 'page9', fromSlug: 'about', toSlug: 'about-us' },
      NOW,
    )
    expect(record).toEqual({
      key: expect.stringMatching(
        new RegExp(`^move:page9:${NOW.getTime().toString(36)}[0-9a-z]{11}$`),
      ) as unknown as string,
      pageId: 'page9',
      fromSlug: 'about',
      toSlug: 'about-us',
      at: NOW.toISOString(),
    })
    expect(storage.get(SLUGMOVES_RESOURCE_ID).creates).toEqual([serializeSlugMoveRecord(record)])
  })

  // Review 2026-08-23: the key was `move:<pageId>:<ms base36>` with no tail,
  // so two moves of the SAME page inside one millisecond produced the same
  // key — and `listSlugMoves` dedupes by key, so one observation vanished
  // from the read. Re-breaking check: drop the counter/random tail and this
  // fails on both the key compare and the surviving-move count.
  test('two same-millisecond moves of one page keep distinct keys and both stay readable', async () => {
    const storage = makeMockStorage()
    const first = await recordSlugMove(storage, { pageId: 'p1', fromSlug: 'a', toSlug: 'b' }, NOW)
    const second = await recordSlugMove(storage, { pageId: 'p1', fromSlug: 'b', toSlug: 'c' }, NOW)
    expect(second.key).not.toBe(first.key)
    expect(second.key.startsWith('move:p1:')).toBe(true)
    expect(parseSlugMoveRecordData(serializeSlugMoveRecord(second))).toEqual(second)
    const moves = await listSlugMoves(storage)
    expect(moves).toHaveLength(2)
    expect(moves.map((move) => move.toSlug).sort()).toEqual(['b', 'c'])
  })

  test('prunes the oldest records beyond MAX_SLUGMOVE_RECORDS, capped', async () => {
    const storage = makeMockStorage()
    const collection = storage.get(SLUGMOVES_RESOURCE_ID)
    const seeded: string[] = []
    for (let i = 0; i < MAX_SLUGMOVE_RECORDS + SLUGMOVE_DELETE_CAP + 10; i++) {
      const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()
      const row = collection.seed(
        serializeSlugMoveRecord(makeMove({ pageId: `p${i}`, at })),
      )
      seeded.push(row.id)
    }
    await recordSlugMove(storage, { pageId: 'fresh', fromSlug: 'a', toSlug: 'b' }, NOW)
    // Deletes exactly the cap, oldest `at` first.
    expect(collection.deletes).toEqual(seeded.slice(0, SLUGMOVE_DELETE_CAP))
  })

  // Wave 3.3 review fix #9 — prune tie-break + just-created protection.
  test('never prunes the record it just created, even on `at` ties', async () => {
    const storage = makeMockStorage()
    const collection = storage.get(SLUGMOVES_RESOURCE_ID)
    // Every seeded record shares the SAME `at` as the new record — the
    // worst tie case for the old sort.
    const seededIds: string[] = []
    for (let i = 0; i < MAX_SLUGMOVE_RECORDS; i++) {
      const row = collection.seed(
        serializeSlugMoveRecord(makeMove({ pageId: `p${String(i).padStart(3, '0')}`, at: NOW.toISOString() })),
      )
      seededIds.push(row.id)
    }
    const record = await recordSlugMove(storage, { pageId: 'fresh', fromSlug: 'a', toSlug: 'b' }, NOW)
    expect(collection.deletes).toHaveLength(1) // excess of exactly 1
    expect(seededIds).toContain(collection.deletes[0]!) // a seeded victim…
    // …and the just-created record is still stored.
    const stored = collection.records.map((r) => r.data.key)
    expect(stored).toContain(record.key)
  })

  test('tie-break is deterministic: at desc then key desc, pruned from the tail', async () => {
    const storage = makeMockStorage()
    const collection = storage.get(SLUGMOVES_RESOURCE_ID)
    const at = '2026-08-01T00:00:00.000Z'
    const rows = new Map<string, string>() // pageId → record id
    for (let i = 0; i < MAX_SLUGMOVE_RECORDS; i++) {
      const pageId = `p${String(i).padStart(3, '0')}`
      const row = collection.seed(serializeSlugMoveRecord(makeMove({ pageId, at })))
      rows.set(pageId, row.id)
    }
    await recordSlugMove(storage, { pageId: 'zz-fresh', fromSlug: 'a', toSlug: 'b' }, NOW)
    // All candidates tie on nothing (fresh record has a newer `at`), so
    // among the seeded rows (same `at`) the SMALLEST key sorts last under
    // `key desc` and is the one pruned from the tail.
    expect(collection.deletes).toEqual([rows.get('p000')!])
  })

  test('does not prune under the cap', async () => {
    const storage = makeMockStorage()
    const collection = storage.get(SLUGMOVES_RESOURCE_ID)
    collection.seed(serializeSlugMoveRecord(makeMove()))
    await recordSlugMove(storage, { pageId: 'p2', fromSlug: 'a', toSlug: 'b' }, NOW)
    expect(collection.deletes).toEqual([])
  })
})

describe('listSlugMoves', () => {
  test('sorts at desc, dedupes newest-wins by key, skips corrupt records', async () => {
    const storage = makeMockStorage()
    const collection = storage.get(SLUGMOVES_RESOURCE_ID)
    const older = makeMove({ pageId: 'p1', at: '2026-08-01T00:00:00.000Z' })
    const newer = makeMove({ pageId: 'p2', at: '2026-08-02T00:00:00.000Z' })
    // Duplicate key for `older` (host order newest-created first wins).
    collection.seed(serializeSlugMoveRecord({ ...older, toSlug: 'winner' }))
    collection.seed(serializeSlugMoveRecord({ ...older, toSlug: 'stale-duplicate' }))
    collection.seed(serializeSlugMoveRecord(newer))
    collection.seed({ garbage: true })
    collection.seed(serializeSlugMoveRecord({ ...older, key: 'move:WRONG:xyz' })) // key/pageId mismatch

    const moves = await listSlugMoves(storage)
    expect(moves).toHaveLength(2)
    expect(moves[0]).toEqual(newer)
    expect(moves[1]!.toSlug).toBe('winner')
    expect(collection.deletes).toEqual([]) // read-only
  })

  test('caps the response at SLUGMOVE_READ_CAP', async () => {
    const storage = makeMockStorage()
    const collection = storage.get(SLUGMOVES_RESOURCE_ID)
    for (let i = 0; i < SLUGMOVE_READ_CAP + 20; i++) {
      const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()
      collection.seed(serializeSlugMoveRecord(makeMove({ pageId: `p${i}`, at })))
    }
    const moves = await listSlugMoves(storage)
    expect(moves).toHaveLength(SLUGMOVE_READ_CAP)
    // Newest survives the cap.
    expect(moves[0]!.pageId).toBe(`p${SLUGMOVE_READ_CAP + 19}`)
  })
})

describe('parseSlugMoveRecordData', () => {
  test('round-trips and rejects corrupt shapes', () => {
    const move = makeMove()
    expect(parseSlugMoveRecordData(serializeSlugMoveRecord(move))).toEqual(move)
    expect(parseSlugMoveRecordData(null)).toBeUndefined()
    expect(parseSlugMoveRecordData({ ...serializeSlugMoveRecord(move), at: '' })).toBeUndefined()
    expect(parseSlugMoveRecordData({ ...serializeSlugMoveRecord(move), fromSlug: 42 })).toBeUndefined()
  })
})

describe('makeHostMovesHandler', () => {
  test('returns { moves } from storage', async () => {
    const storage = makeMockStorage()
    const move = makeMove()
    storage.get(SLUGMOVES_RESOURCE_ID).seed(serializeSlugMoveRecord(move))
    const handler = makeHostMovesHandler({ storage })
    expect(await handler()).toEqual({ moves: [move] })
  })
})

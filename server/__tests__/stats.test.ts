/**
 * Task 2.6 — GET /stats read model: newest-wins day totals + the
 * zero-filled 7-day window payload.
 */
import { describe, expect, test } from 'bun:test'
import {
  STATS_WINDOW_DAYS,
  buildStatsPayload,
  dayKey,
  newestDayTotals,
  serializeDayCounts,
  utcDay,
} from '../analytics'

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0) // 2026-08-14T12:00Z
const DAY_MS = 24 * 60 * 60 * 1000

function dayRecord(id: string, day: string, total: number) {
  return { id, data: serializeDayCounts({ day, total, counts: { '/': total } }) }
}

describe('newestDayTotals', () => {
  test('maps each day to its total', () => {
    const totals = newestDayTotals([
      dayRecord('a', '2026-08-14', 5),
      dayRecord('b', '2026-08-13', 3),
    ])
    expect(totals.get('2026-08-14')).toBe(5)
    expect(totals.get('2026-08-13')).toBe(3)
    expect(totals.size).toBe(2)
  })

  test('newest wins on duplicate days (list order = created_at desc)', () => {
    const totals = newestDayTotals([
      dayRecord('newest', '2026-08-14', 9),
      dayRecord('stale', '2026-08-14', 2),
    ])
    expect(totals.get('2026-08-14')).toBe(9)
    expect(totals.size).toBe(1)
  })

  test('skips malformed records (bad day, key mismatch, garbage)', () => {
    const totals = newestDayTotals([
      { id: 'bad-day', data: { key: dayKey('2026-02-31'), day: '2026-02-31', total: 7 } },
      { id: 'key-mismatch', data: { key: 'day:2026-08-01', day: '2026-08-02', total: 7 } },
      { id: 'garbage', data: { nope: true } },
      dayRecord('good', '2026-08-10', 1),
    ])
    expect([...totals.keys()]).toEqual(['2026-08-10'])
  })

  test('a corrupt NEWEST duplicate is skipped — the older valid one wins (C#4)', () => {
    // The reviewer's exact scenario: newest record for the day carries
    // total "oops"; an older duplicate holds the real 12. The read model
    // must report 12 — never a zeroed-out day.
    const totals = newestDayTotals([
      {
        id: 'newest-corrupt',
        data: { key: dayKey('2026-08-14'), day: '2026-08-14', total: 'oops', countsJson: '{}' },
      },
      dayRecord('older-valid', '2026-08-14', 12),
    ])
    expect(totals.get('2026-08-14')).toBe(12)
    expect(totals.size).toBe(1)
  })

  test('invalid totals variants are skipped, not zeroed (C#4)', () => {
    for (const total of ['12', NaN, Infinity, -1, null, undefined]) {
      const totals = newestDayTotals([
        { id: 'bad', data: { key: dayKey('2026-08-14'), day: '2026-08-14', total } },
        dayRecord('good', '2026-08-14', 5),
      ])
      expect(totals.get('2026-08-14')).toBe(5)
    }
  })

  test('unparseable or non-object countsJson skips the record (C#4)', () => {
    for (const countsJson of ['{broken', '[1,2]', '"str"', 'null']) {
      const totals = newestDayTotals([
        {
          id: 'bad-counts',
          data: { key: dayKey('2026-08-14'), day: '2026-08-14', total: 99, countsJson },
        },
        dayRecord('good', '2026-08-14', 3),
      ])
      expect(totals.get('2026-08-14')).toBe(3)
    }
    // empty-string countsJson stays acceptable (matches serializer absence)
    const ok = newestDayTotals([
      { id: 'empty', data: { key: dayKey('2026-08-14'), day: '2026-08-14', total: 4, countsJson: '' } },
    ])
    expect(ok.get('2026-08-14')).toBe(4)
  })

  test('empty input → empty map', () => {
    expect(newestDayTotals([]).size).toBe(0)
  })
})

describe('buildStatsPayload', () => {
  test('produces a gap-free ascending 7-day window ending today', () => {
    const payload = buildStatsPayload(new Map(), new Map(), NOW)
    expect(payload.days).toHaveLength(STATS_WINDOW_DAYS)
    expect(payload.days[0]!.day).toBe(utcDay(NOW - 6 * DAY_MS))
    expect(payload.days[6]!.day).toBe('2026-08-14')
    // strictly ascending calendar days
    for (let i = 1; i < payload.days.length; i++) {
      expect(payload.days[i]!.day > payload.days[i - 1]!.day).toBe(true)
    }
  })

  test('zero-fills missing days and joins both collections', () => {
    const views = new Map([
      ['2026-08-14', 10],
      ['2026-08-12', 4],
    ])
    const notFound = new Map([['2026-08-13', 2]])
    const payload = buildStatsPayload(views, notFound, NOW)
    const byDay = new Map(payload.days.map((d) => [d.day, d]))
    expect(byDay.get('2026-08-14')).toEqual({ day: '2026-08-14', views: 10, notFound: 0 })
    expect(byDay.get('2026-08-13')).toEqual({ day: '2026-08-13', views: 0, notFound: 2 })
    expect(byDay.get('2026-08-12')).toEqual({ day: '2026-08-12', views: 4, notFound: 0 })
    expect(byDay.get('2026-08-11')).toEqual({ day: '2026-08-11', views: 0, notFound: 0 })
  })

  test('totals sum only the window — older days are excluded', () => {
    const views = new Map([
      ['2026-08-14', 10],
      ['2026-08-08', 5], // oldest in-window day (today - 6)
      ['2026-08-07', 100], // outside the 7-day window
    ])
    const notFound = new Map([
      ['2026-08-10', 3],
      ['2026-07-01', 50], // far outside
    ])
    const payload = buildStatsPayload(views, notFound, NOW)
    expect(payload.totals).toEqual({ views: 15, notFound: 3 })
  })

  test('window size is configurable', () => {
    const payload = buildStatsPayload(new Map(), new Map(), NOW, 3)
    expect(payload.days.map((d) => d.day)).toEqual(['2026-08-12', '2026-08-13', '2026-08-14'])
  })
})

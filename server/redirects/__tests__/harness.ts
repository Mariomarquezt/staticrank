/**
 * Shared mock harness for the redirects suites — same structural-mock
 * house style as server/license/__tests__/harness.ts (newest-first record
 * lists mirroring the host's `created_at desc` default order).
 * Not a test file: bun only collects *.test.ts.
 */

import type { RedirectRule } from '../types'

export interface MockRecordRow {
  id: string
  data: Record<string, unknown>
}

export class MockCollection {
  records: MockRecordRow[] = []
  creates: Array<Record<string, unknown>> = []
  updates: Array<{ id: string; data: Record<string, unknown> }> = []
  deletes: string[] = []
  listCalls = 0
  private nextId = 0

  async list(options: { filter?: Record<string, unknown>; limit?: number } = {}) {
    this.listCalls++
    let matched = this.records
    if (options.filter !== undefined) {
      matched = matched.filter((r) =>
        Object.entries(options.filter!).every(([field, value]) => r.data[field] === value),
      )
    }
    return { records: matched.slice(0, options.limit ?? 50) }
  }

  async create(data: Record<string, unknown>) {
    this.creates.push(data)
    const record = { id: `rec${this.nextId++}`, data }
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
    this.deletes.push(recordId)
    this.records = this.records.filter((r) => r.id !== recordId)
    return null
  }

  /** Seed a record as if created earlier (appended = older). */
  seed(data: Record<string, unknown>): MockRecordRow {
    const record = { id: `rec${this.nextId++}`, data }
    this.records.push(record)
    return record
  }

  /** Seed a record as the NEWEST. */
  seedNewest(data: Record<string, unknown>): MockRecordRow {
    const record = { id: `rec${this.nextId++}`, data }
    this.records.unshift(record)
    return record
  }
}

export interface MockStorage {
  collections: Map<string, MockCollection>
  get: (resourceId: string) => MockCollection
  collection: (resourceId: string) => MockCollection
}

export function makeMockStorage(): MockStorage {
  const collections = new Map<string, MockCollection>()
  const get = (resourceId: string): MockCollection => {
    let c = collections.get(resourceId)
    if (c === undefined) {
      c = new MockCollection()
      collections.set(resourceId, c)
    }
    return c
  }
  return { collections, get, collection: get }
}

export const NOW = new Date('2026-08-15T12:00:00.000Z')

/** A fully-populated stored rule for tests; override what matters. */
export function makeRule(overrides: Partial<RedirectRule> = {}): RedirectRule {
  return {
    key: 'r1aaa',
    fromPath: '/old',
    toPath: '/new',
    status: '301',
    isRegex: false,
    enabled: true,
    note: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Route ctx with a raw request body (house `req.text()` parsing). */
export function ctxWithBody(body: string) {
  return { req: { url: 'http://x/redirects', text: async () => body } }
}

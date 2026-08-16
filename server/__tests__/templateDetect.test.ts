import { beforeEach, describe, expect, test } from 'bun:test'
import {
  TEMPLATE_FLAG_CACHE_TTL_MS,
  getTemplatePageInfo,
  invalidateTemplateFlagCache,
  isTemplatePageId,
  type PagesTableLike,
} from '../templateDetect'

function fakePagesTable(rows: Record<string, Record<string, unknown> | null>) {
  const calls = { get: 0 }
  const table: PagesTableLike = {
    async get(entryId: string) {
      calls.get++
      const cells = rows[entryId]
      if (cells === undefined || cells === null) return null
      return { cells }
    },
  }
  return { table, calls }
}

describe('getTemplatePageInfo', () => {
  beforeEach(() => {
    invalidateTemplateFlagCache()
  })

  test('regular page (templateEnabled absent or false) is not a template', async () => {
    const { table } = fakePagesTable({
      plain: { title: 'About' },
      explicit: { templateEnabled: false },
    })
    expect(await getTemplatePageInfo(table, 'plain')).toEqual({ isTemplate: false })
    expect(await getTemplatePageInfo(table, 'explicit')).toEqual({ isTemplate: false })
  })

  test('postTypes template reports the primary target table slug', async () => {
    const { table } = fakePagesTable({
      tpl: {
        templateEnabled: true,
        templateTarget: { kind: 'postTypes', tableSlugs: ['posts', 'docs'] },
      },
    })
    expect(await getTemplatePageInfo(table, 'tpl')).toEqual({
      isTemplate: true,
      targetTableSlug: 'posts',
    })
  })

  test('everywhere / notFound templates are templates without a target table', async () => {
    const { table } = fakePagesTable({
      layout: { templateEnabled: true, templateTarget: { kind: 'everywhere' } },
      notfound: { templateEnabled: true, templateTarget: { kind: 'notFound' } },
      malformed: { templateEnabled: true, templateTarget: 'bogus' },
    })
    expect(await getTemplatePageInfo(table, 'layout')).toEqual({ isTemplate: true })
    // Task 2.4: notFound templates additionally flag isNotFound (the 404
    // beacon's endpoint switch keys off it).
    expect(await getTemplatePageInfo(table, 'notfound')).toEqual({
      isTemplate: true,
      isNotFound: true,
    })
    expect(await getTemplatePageInfo(table, 'malformed')).toEqual({ isTemplate: true })
  })

  test('CONSERVATIVE: missing row and read errors classify as template (skip per-entry tier)', async () => {
    const { table } = fakePagesTable({})
    expect(await getTemplatePageInfo(table, 'gone')).toEqual({ isTemplate: true })

    const throwing: PagesTableLike = {
      get: async () => {
        throw new Error('permission revoked')
      },
    }
    invalidateTemplateFlagCache()
    expect(await getTemplatePageInfo(throwing, 'any')).toEqual({ isTemplate: true })
  })

  test('memoizes per pageId within the TTL window and refetches after expiry', async () => {
    const { table, calls } = fakePagesTable({
      a: { title: 'A' },
      b: { templateEnabled: true },
    })
    await getTemplatePageInfo(table, 'a', 1000)
    await getTemplatePageInfo(table, 'a', 1000)
    expect(calls.get).toBe(1)
    await getTemplatePageInfo(table, 'b', 1000)
    expect(calls.get).toBe(2)
    // TTL expiry drops the whole map.
    await getTemplatePageInfo(table, 'a', 1000 + TEMPLATE_FLAG_CACHE_TTL_MS)
    expect(calls.get).toBe(3)
  })

  test('isTemplatePageId is the boolean view', async () => {
    const { table } = fakePagesTable({ tpl: { templateEnabled: true }, page: {} })
    expect(await isTemplatePageId(table, 'tpl')).toBe(true)
    expect(await isTemplatePageId(table, 'page')).toBe(false)
  })
})

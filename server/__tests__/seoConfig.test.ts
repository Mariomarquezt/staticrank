import { beforeEach, describe, expect, test } from 'bun:test'
import {
  HOST_LIST_LIMIT,
  INDEXNOW_CONFIG_KEY,
  indexNowEnabled,
  MAX_CLEANUP_DELETES,
  PUBLISHER_NAME_MAX,
  CONFIG_TABLES_MAX,
  SEO_CONFIG_CACHE_TTL_MS,
  SEO_CONFIG_REQUEST_BODY_MAX,
  SEPARATOR_MAX,
  SITE_NAME_MAX,
  TITLE_TEMPLATE_MAX,
  VERIFICATION_TOKEN_MAX,
  SITE_CONFIG_KEY,
  SAME_AS_MAX,
  TABLE_CONFIG_KEY_PREFIX,
  deserializeSeoConfigRecords,
  healSeoConfigDuplicates,
  invalidateSeoConfigCache,
  isEmptySeoConfig,
  loadSeoConfig,
  planSeoConfigReplace,
  serializeSeoConfig,
  validateSeoConfig,
  type SeoConfigCollectionLike,
  type SeoConfigData,
  type StoredRecordLike,
  isSeoConfigRequestBodyWithinLimit,
} from '../seoConfig'
import { DESCRIPTION_MAX, URL_MAX } from '../seoMeta'

function errorFields(input: unknown): string[] {
  const result = validateSeoConfig(input)
  if (result.ok) throw new Error('expected validation to fail')
  return result.errors.map((e) => e.field)
}

function maxAbsoluteUrl(): string {
  const prefix = 'https://a/'
  return `${prefix}${'x'.repeat(URL_MAX - prefix.length)}`
}

function maxVerificationInput(): string {
  const prefix = '<meta content="'
  const suffix = '">'
  const token = 'x'.repeat(VERIFICATION_TOKEN_MAX)
  return `${prefix}${token}${suffix}${'x'.repeat(URL_MAX - prefix.length - token.length - suffix.length)}`
}

function maxTitleTemplate(): string {
  const prefix = '%title%'
  return `${prefix}${'x'.repeat(TITLE_TEMPLATE_MAX - prefix.length)}`
}

function maxSeoConfigPayload(): SeoConfigData {
  const url = maxAbsoluteUrl()
  const tables = Object.fromEntries(
    Array.from({ length: CONFIG_TABLES_MAX }, (_, index) => [
      `table${index}`,
      { titleTemplate: maxTitleTemplate() },
    ]),
  )
  return {
    site: {
      siteName: 'x'.repeat(SITE_NAME_MAX),
      separator: 'x'.repeat(SEPARATOR_MAX),
      siteUrl: 'https://example.com',
      titleTemplate: maxTitleTemplate(),
      metaDescription: 'x'.repeat(DESCRIPTION_MAX),
    },
    tables,
    indexNow: { enabled: false },
    schema: {
      enabled: false,
      publisherKind: 'organization',
      publisherName: 'x'.repeat(PUBLISHER_NAME_MAX),
      publisherLogoUrl: `/${'x'.repeat(URL_MAX - 1)}`,
      sameAs: Array.from({ length: SAME_AS_MAX }, () => url),
    },
    analytics: { enabled: true },
    verification: {
      google: maxVerificationInput(),
      bing: maxVerificationInput(),
      pinterest: maxVerificationInput(),
    },
  }
}

describe('validateSeoConfig', () => {
  test('accepts a full valid document', () => {
    const config: SeoConfigData = {
      site: {
        siteName: 'Acme',
        separator: '|',
        siteUrl: 'https://example.com',
        titleTemplate: '%title% %sep% %site%',
        metaDescription: 'Default description.',
      },
      tables: { posts: { titleTemplate: '%title% %sep% Blog' } },
    }
    const result = validateSeoConfig(config)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(config)
  })

  test('rejects non-objects and unknown top-level fields', () => {
    expect(validateSeoConfig(null).ok).toBe(false)
    expect(validateSeoConfig([]).ok).toBe(false)
    expect(errorFields({ bogus: 1 })).toEqual(['bogus'])
  })

  test('rejects unknown site fields and wrong types', () => {
    expect(errorFields({ site: { bogus: 1 } })).toEqual(['site.bogus'])
    expect(errorFields({ site: { siteName: 42 } })).toEqual(['site.siteName'])
    expect(errorFields({ site: 'nope' })).toEqual(['site'])
  })

  test('siteUrl must be a bare http(s) origin', () => {
    expect(errorFields({ site: { siteUrl: '/relative' } })).toEqual(['site.siteUrl'])
    expect(errorFields({ site: { siteUrl: 'ftp://example.com' } })).toEqual(['site.siteUrl'])
    expect(errorFields({ site: { siteUrl: 'https://' } })).toEqual(['site.siteUrl'])
    // Review finding 5: userinfo, empty host with port, and origins that
    // carry a path/query must all be rejected.
    expect(errorFields({ site: { siteUrl: 'https://@/' } })).toEqual(['site.siteUrl'])
    expect(errorFields({ site: { siteUrl: 'https://:443/' } })).toEqual(['site.siteUrl'])
    expect(errorFields({ site: { siteUrl: 'https://example.com/base?x=1' } })).toEqual([
      'site.siteUrl',
    ])
    expect(errorFields({ site: { siteUrl: 'https://user@example.com' } })).toEqual([
      'site.siteUrl',
    ])
    expect(validateSeoConfig({ site: { siteUrl: 'https://example.com:8443' } }).ok).toBe(true)
  })

  test('siteUrl trailing slash is accepted and normalized away', () => {
    const result = validateSeoConfig({ site: { siteUrl: 'https://example.com/' } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.site?.siteUrl).toBe('https://example.com')
  })

  test('separator must contain a non-whitespace character', () => {
    expect(errorFields({ site: { separator: '   ' } })).toEqual(['site.separator'])
    expect(validateSeoConfig({ site: { separator: ' — ' } }).ok).toBe(true)
  })

  test('templates reject unknown variables', () => {
    expect(errorFields({ site: { titleTemplate: '%title% %bogus%' } })).toEqual([
      'site.titleTemplate',
    ])
    expect(
      errorFields({ tables: { posts: { titleTemplate: '%nope%' } } }),
    ).toEqual(['tables.posts.titleTemplate'])
    // %% escape and all supported vars pass.
    expect(
      validateSeoConfig({ site: { titleTemplate: '100%% %title% %site% %sep% %slug%' } }).ok,
    ).toBe(true)
  })

  test('table slugs must be colon-free slug-shaped', () => {
    expect(errorFields({ tables: { 'bad:slug': { titleTemplate: '%title%' } } })).toEqual([
      'tables.bad:slug',
    ])
    expect(errorFields({ tables: { posts: { bogus: 1 } } })).toEqual(['tables.posts.bogus'])
  })

  test('empty strings and empty sub-objects are treated as absent', () => {
    const result = validateSeoConfig({
      site: { siteName: '', titleTemplate: '' },
      tables: { posts: {} },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({})
      expect(isEmptySeoConfig(result.value)).toBe(true)
    }
  })
})

describe('POST /config request-body contract', () => {
  test('accepts a payload at every validator field cap and rejects an oversize body', () => {
    const payload = maxSeoConfigPayload()
    const validated = validateSeoConfig(payload)
    expect(validated.ok).toBe(true)

    const raw = JSON.stringify(payload)
    expect(raw.length).toBeLessThanOrEqual(SEO_CONFIG_REQUEST_BODY_MAX)
    expect(isSeoConfigRequestBodyWithinLimit(raw)).toBe(true)

    const oversize = `${raw}${' '.repeat(SEO_CONFIG_REQUEST_BODY_MAX - raw.length + 1)}`
    expect(isSeoConfigRequestBodyWithinLimit(oversize)).toBe(false)
  })
})

describe('serialize / deserialize round-trip', () => {
  test('splits into one record per key and round-trips exactly', () => {
    const config: SeoConfigData = {
      version: 1,
      site: { siteName: 'Acme', siteUrl: 'https://example.com' },
      tables: { posts: { titleTemplate: '%title%' }, docs: { titleTemplate: '%slug%' } },
    }
    const records = serializeSeoConfig(config)
    expect(records.map((r) => r.key).sort()).toEqual(['site', 'table:docs', 'table:posts'])
    expect(deserializeSeoConfigRecords(records)).toEqual(config)
  })

  test('emits no records for an empty document', () => {
    expect(serializeSeoConfig({})).toEqual([])
  })

  test('deserialize is defensive: bad keys, bad types, duplicates', () => {
    const config = deserializeSeoConfigRecords([
      { key: SITE_CONFIG_KEY, siteName: 'First' },
      { key: SITE_CONFIG_KEY, siteName: 'Older duplicate (ignored)' },
      { key: `${TABLE_CONFIG_KEY_PREFIX}bad:slug`, titleTemplate: '%title%' },
      { key: `${TABLE_CONFIG_KEY_PREFIX}posts`, titleTemplate: 42 },
      { key: `${TABLE_CONFIG_KEY_PREFIX}docs`, titleTemplate: '%title%' },
      { siteName: 'no key at all' },
      { key: 'unrelated', siteName: 'unknown key form' },
    ])
    expect(config).toEqual({
      site: { siteName: 'First' },
      tables: { docs: { titleTemplate: '%title%' } },
    })
  })

  test('read validation trims and drops forged site/table fields', () => {
    expect(
      deserializeSeoConfigRecords([
        {
          key: SITE_CONFIG_KEY,
          version: 1,
          siteName: '  Acme  ',
          separator: ' | ',
          siteUrl: ' https://example.com/ ',
          titleTemplate: ' %title% %sep% ',
          metaDescription: '  Description  ',
        },
        {
          key: `${TABLE_CONFIG_KEY_PREFIX}posts`,
          version: 1,
          titleTemplate: '%bogus%',
        },
      ]),
    ).toEqual({
      version: 1,
      site: {
        siteName: 'Acme',
        separator: '|',
        siteUrl: 'https://example.com',
        titleTemplate: '%title% %sep%',
        metaDescription: 'Description',
      },
    })
  })

  test('versioned toggles fail closed when their records are partial', () => {
    const config = deserializeSeoConfigRecords([
      { key: SITE_CONFIG_KEY, version: 1, siteName: 'Acme' },
      { key: INDEXNOW_CONFIG_KEY, version: 1 },
      { key: SCHEMA_CONFIG_KEY, version: 1 },
    ])
    expect(indexNowEnabled(config)).toBe(false)
    expect(schemaEnabled(config)).toBe(false)
    expect(deserializeSeoConfigRecords([{ key: SITE_CONFIG_KEY, version: 99 }]).version).toBe(0)
  })

  test('BLOCKER regression: upgrading a legacy site-name save preserves both default-ON toggles', () => {
    const legacy = { site: { siteName: 'Acme' } }
    expect(indexNowEnabled(legacy)).toBe(true)
    expect(schemaEnabled(legacy)).toBe(true)

    const upgradedRecords = serializeSeoConfig({ site: { siteName: 'Acme 2' } })
    const upgraded = deserializeSeoConfigRecords(upgradedRecords)

    expect(upgradedRecords).toEqual([
      { key: SITE_CONFIG_KEY, version: 1, siteName: 'Acme 2' },
      { key: INDEXNOW_CONFIG_KEY, version: 1, indexNowEnabled: true },
      { key: SCHEMA_CONFIG_KEY, version: 1, schemaEnabled: true },
    ])
    expect(indexNowEnabled(upgraded)).toBe(true)
    expect(schemaEnabled(upgraded)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// loadSeoConfig — memoization + self-healing
// ---------------------------------------------------------------------------

function fakeCollection(initial: StoredRecordLike[]) {
  const records = [...initial]
  const calls = { list: 0, delete: 0 }
  const collection: SeoConfigCollectionLike = {
    async list() {
      calls.list++
      return { records: [...records] }
    },
    async delete(id: string) {
      calls.delete++
      const i = records.findIndex((r) => r.id === id)
      if (i !== -1) records.splice(i, 1)
      return true
    },
  }
  return { collection, records, calls }
}

describe('loadSeoConfig', () => {
  beforeEach(() => {
    invalidateSeoConfigCache()
  })

  test('reads, deserializes, and memoizes within the TTL', async () => {
    const { collection, calls } = fakeCollection([
      { id: 'a', data: { key: 'site', siteName: 'Acme' } },
    ])
    const first = await loadSeoConfig(collection, 1000)
    expect(first).toEqual({ site: { siteName: 'Acme' } })
    const second = await loadSeoConfig(collection, 1000 + SEO_CONFIG_CACHE_TTL_MS - 1)
    expect(second).toEqual(first)
    expect(calls.list).toBe(1)
  })

  test('expires after the TTL and after invalidation', async () => {
    const { collection, calls } = fakeCollection([])
    await loadSeoConfig(collection, 1000)
    await loadSeoConfig(collection, 1000 + SEO_CONFIG_CACHE_TTL_MS)
    expect(calls.list).toBe(2)
    invalidateSeoConfigCache()
    await loadSeoConfig(collection, 1000 + SEO_CONFIG_CACHE_TTL_MS)
    expect(calls.list).toBe(3)
  })

  test('is READ-ONLY: duplicates resolve newest-wins in memory, nothing deleted', async () => {
    const { collection, records, calls } = fakeCollection([
      { id: 'new', data: { key: 'site', siteName: 'Newest' } },
      { id: 'old', data: { key: 'site', siteName: 'Stale' } },
      { id: 'keep', data: { key: 'table:posts', titleTemplate: '%title%' } },
      { id: 'garbage', data: { note: 'no key' } },
    ])
    const config = await loadSeoConfig(collection, 1000)
    expect(config).toEqual({
      site: { siteName: 'Newest' },
      tables: { posts: { titleTemplate: '%title%' } },
    })
    // Review finding 6: the publish hot path never issues deletes.
    expect(calls.delete).toBe(0)
    expect(records.length).toBe(4)
  })

  test('an in-flight fill that started before an invalidation cannot populate the cache', async () => {
    let resolveList!: (result: { records: StoredRecordLike[] }) => void
    let listCalls = 0
    const collection: SeoConfigCollectionLike = {
      list: () => {
        listCalls++
        if (listCalls === 1) return new Promise((resolve) => (resolveList = resolve))
        return Promise.resolve({ records: [{ id: 'b', data: { key: 'site', siteName: 'New' } }] })
      },
      delete: async () => true,
    }
    const inFlight = loadSeoConfig(collection, 1000)
    // A config write lands while the read is in flight.
    invalidateSeoConfigCache()
    resolveList({ records: [{ id: 'a', data: { key: 'site', siteName: 'Old' } }] })
    expect(await inFlight).toEqual({ site: { siteName: 'Old' } })
    // The stale fill must NOT have been cached: the next load re-lists
    // and sees the post-write state.
    expect(await loadSeoConfig(collection, 1000)).toEqual({ site: { siteName: 'New' } })
    expect(listCalls).toBe(2)
  })
})

describe('healSeoConfigDuplicates', () => {
  beforeEach(() => {
    invalidateSeoConfigCache()
  })

  test('deletes stale duplicates only, keeping the newest per key', async () => {
    const { collection, records } = fakeCollection([
      { id: 'new', data: { key: 'site', siteName: 'Newest' } },
      { id: 'old', data: { key: 'site', siteName: 'Stale' } },
      { id: 'keep', data: { key: 'table:posts', titleTemplate: '%title%' } },
      { id: 'garbage', data: { note: 'no key — untouched by heal' } },
    ])
    const deleted = await healSeoConfigDuplicates(collection)
    expect(deleted).toBe(1)
    expect(records.map((r) => r.id).sort()).toEqual(['garbage', 'keep', 'new'])
  })

  test('caps deletions per request; leftovers wait for the next call', async () => {
    const dupes: StoredRecordLike[] = [{ id: 'newest', data: { key: 'site', siteName: 'keep' } }]
    for (let i = 0; i < MAX_CLEANUP_DELETES + 5; i++) {
      dupes.push({ id: `stale-${i}`, data: { key: 'site', siteName: `s${i}` } })
    }
    const { collection, records } = fakeCollection(dupes)
    expect(await healSeoConfigDuplicates(collection)).toBe(MAX_CLEANUP_DELETES)
    expect(records.length).toBe(1 + 5)
    expect(await healSeoConfigDuplicates(collection)).toBe(5)
    expect(records.map((r) => r.id)).toEqual(['newest'])
  })

  test('skips entirely when the list may be truncated (host cap)', async () => {
    const atCap: StoredRecordLike[] = []
    for (let i = 0; i < HOST_LIST_LIMIT; i++) {
      atCap.push({ id: `r${i}`, data: { key: 'site', siteName: `s${i}` } })
    }
    const { collection, calls } = fakeCollection(atCap)
    expect(await healSeoConfigDuplicates(collection)).toBe(0)
    expect(calls.delete).toBe(0)
  })
})

describe('planSeoConfigReplace', () => {
  const desired = () =>
    serializeSeoConfig({
      site: { siteName: 'Acme' },
      tables: { posts: { titleTemplate: '%title%' } },
    })

  test('updates newest per desired key, creates missing, deletes removed + stale + garbage', () => {
    const plan = planSeoConfigReplace(
      [
        { id: 'site-new', data: { key: 'site', siteName: 'Old name' } },
        { id: 'site-old', data: { key: 'site', siteName: 'Older dup' } },
        { id: 'removed', data: { key: 'table:docs', titleTemplate: '%slug%' } },
        { id: 'junk', data: { note: 'keyless' } },
      ],
      desired(),
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.updates).toEqual([
      { recordId: 'site-new', data: { key: 'site', version: 1, siteName: 'Acme' } },
    ])
    expect(plan.creates).toEqual([
      { key: 'table:posts', version: 1, titleTemplate: '%title%' },
      { key: INDEXNOW_CONFIG_KEY, version: 1, indexNowEnabled: true },
      { key: SCHEMA_CONFIG_KEY, version: 1, schemaEnabled: true },
    ])
    expect(plan.deletes.sort()).toEqual(['junk', 'removed', 'site-old'])
  })

  test('required deletions (removed keys) are never capped; cleanup deletions are', () => {
    const records: StoredRecordLike[] = []
    for (let i = 0; i < 30; i++) {
      records.push({ id: `removed-${i}`, data: { key: `table:t${i}`, titleTemplate: '%title%' } })
    }
    for (let i = 0; i < 30; i++) {
      records.push({ id: `junk-${i}`, data: { note: 'keyless' } })
    }
    const plan = planSeoConfigReplace(records, desired(), 25)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const removed = plan.deletes.filter((id) => id.startsWith('removed-'))
    const junk = plan.deletes.filter((id) => id.startsWith('junk-'))
    expect(removed.length).toBe(30) // required — full replace correctness
    expect(junk.length).toBe(25) // cleanup — capped
  })

  test('refuses to plan over a possibly-truncated list (host cap)', () => {
    const records: StoredRecordLike[] = []
    for (let i = 0; i < HOST_LIST_LIMIT; i++) {
      records.push({ id: `r${i}`, data: { key: `table:t${i}`, titleTemplate: '%title%' } })
    }
    expect(planSeoConfigReplace(records, desired())).toEqual({ ok: false, reason: 'list-cap' })
  })
})

// ---------------------------------------------------------------------------
// Task 2.2 — indexNow section
// ---------------------------------------------------------------------------

describe('validateSeoConfig — indexNow (toggle only, review #9)', () => {
  test('accepts the disabled toggle', () => {
    const config: SeoConfigData = { indexNow: { enabled: false } }
    const result = validateSeoConfig(config)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(config)
  })

  test('enabled: true is preserved for versioned fail-closed configs', () => {
    const result = validateSeoConfig({ indexNow: { enabled: true } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ indexNow: { enabled: true } })
  })

  test('server-owned fields are REJECTED here — they live in seo-state now', () => {
    expect(errorFields({ indexNow: { key: 'abcd1234abcd1234' } })).toEqual(['indexNow.key'])
    expect(errorFields({ indexNow: { lastStatus: 'ok' } })).toEqual(['indexNow.lastStatus'])
    expect(errorFields({ indexNow: { bogus: 1 } })).toEqual(['indexNow.bogus'])
    expect(errorFields({ indexNow: { enabled: 'yes' } })).toEqual(['indexNow.enabled'])
    expect(errorFields({ indexNow: 'nope' })).toEqual(['indexNow'])
  })

  test('a document with only indexNow is not empty', () => {
    const result = validateSeoConfig({ indexNow: { enabled: false } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(isEmptySeoConfig(result.value)).toBe(false)
    const empty = validateSeoConfig({})
    if (empty.ok) expect(isEmptySeoConfig(empty.value)).toBe(true)
  })

  test('indexNowEnabled defaults ON, only explicit false disables', () => {
    expect(indexNowEnabled({})).toBe(true)
    expect(indexNowEnabled({ indexNow: {} })).toBe(true)
    expect(indexNowEnabled({ indexNow: { enabled: false } })).toBe(false)
  })
})

describe('serialize/deserialize — indexNow record (toggle only)', () => {
  test('round-trips the disabled toggle through the flat `indexnow` record', () => {
    const config: SeoConfigData = { indexNow: { enabled: false } }
    const records = serializeSeoConfig(config)
    expect(records).toEqual([
      { key: INDEXNOW_CONFIG_KEY, version: 1, indexNowEnabled: false },
      { key: SCHEMA_CONFIG_KEY, version: 1, schemaEnabled: true },
    ])
    expect(deserializeSeoConfigRecords(records)).toEqual({
      ...config,
      schema: { enabled: true },
      version: 1,
    })
  })

  test('legacy default-ON toggles are materialized during upgrade', () => {
    expect(serializeSeoConfig({ site: { siteName: 'Acme' } })).toEqual([
      { key: SITE_CONFIG_KEY, version: 1, siteName: 'Acme' },
      { key: INDEXNOW_CONFIG_KEY, version: 1, indexNowEnabled: true },
      { key: SCHEMA_CONFIG_KEY, version: 1, schemaEnabled: true },
    ])
  })

  test('LEGACY embedded server state deserializes to the toggle only (lift is seoState.ts business)', () => {
    const legacy = {
      key: INDEXNOW_CONFIG_KEY,
      indexNowKey: 'abcd1234abcd1234',
      lastSubmittedAt: '2026-08-14T00:00:00.000Z',
      lastStatus: 'ok 200 (3 urls)',
      indexNowEnabled: false,
    }
    expect(deserializeSeoConfigRecords([legacy])).toEqual({ indexNow: { enabled: false } })
    // Legacy record WITHOUT the toggle contributes nothing to the document.
    expect(
      deserializeSeoConfigRecords([{ key: INDEXNOW_CONFIG_KEY, indexNowKey: 'abcd1234abcd1234' }]),
    ).toEqual({})
  })

  test('coexists with site and table records', () => {
    const config: SeoConfigData = {
      site: { siteName: 'Acme' },
      tables: { posts: { titleTemplate: '%title%' } },
      indexNow: { enabled: false },
    }
    expect(deserializeSeoConfigRecords(serializeSeoConfig(config))).toEqual({
      ...config,
      schema: { enabled: true },
      version: 1,
    })
  })
})

// ---------------------------------------------------------------------------
// Task 2.3 — schema section
// ---------------------------------------------------------------------------

import {
  SCHEMA_CONFIG_KEY,
  hasExplicitConfigSection,
  SAME_AS_JSON_MAX,
  parseStoredSameAs,
  resolveConfigSections,
  schemaEnabled,
} from '../seoConfig'

describe('validateSeoConfig — schema section', () => {
  test('accepts a full valid schema section', () => {
    const result = validateSeoConfig({
      schema: {
        enabled: false,
        publisherKind: 'organization',
        publisherName: 'Acme Inc',
        publisherLogoUrl: '/logo.png',
        sameAs: ['https://x.com/acme', 'https://github.com/acme'],
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.schema).toEqual({
        enabled: false,
        publisherKind: 'organization',
        publisherName: 'Acme Inc',
        publisherLogoUrl: '/logo.png',
        sameAs: ['https://x.com/acme', 'https://github.com/acme'],
      })
    }
  })

  test('enabled: true is preserved for versioned fail-closed configs', () => {
    const result = validateSeoConfig({ schema: { enabled: true } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.schema).toEqual({ enabled: true })
    expect(schemaEnabled({})).toBe(true)
    expect(schemaEnabled({ schema: { enabled: false } })).toBe(false)
  })

  test('rejects unknown fields and wrong types', () => {
    expect(errorFields({ schema: 'nope' })).toEqual(['schema'])
    expect(errorFields({ schema: { bogus: 1 } })).toEqual(['schema.bogus'])
    expect(errorFields({ schema: { enabled: 'yes' } })).toEqual(['schema.enabled'])
    expect(errorFields({ schema: { publisherKind: 'company' } })).toEqual([
      'schema.publisherKind',
    ])
    expect(errorFields({ schema: { publisherName: 'x'.repeat(201) } })).toEqual([
      'schema.publisherName',
    ])
  })

  test('publisherLogoUrl follows the ogImage URL rules', () => {
    expect(validateSeoConfig({ schema: { publisherLogoUrl: 'https://a.example/l.png' } }).ok).toBe(true)
    expect(validateSeoConfig({ schema: { publisherLogoUrl: '/logo.png' } }).ok).toBe(true)
    expect(errorFields({ schema: { publisherLogoUrl: '//evil.example/x' } })).toEqual([
      'schema.publisherLogoUrl',
    ])
    expect(errorFields({ schema: { publisherLogoUrl: 'javascript:alert(1)' } })).toEqual([
      'schema.publisherLogoUrl',
    ])
  })

  test('sameAs: absolute http(s) only, at most 10, empty array = absent', () => {
    expect(errorFields({ schema: { sameAs: 'https://a.example' } })).toEqual(['schema.sameAs'])
    expect(errorFields({ schema: { sameAs: ['/relative'] } })).toEqual(['schema.sameAs.0'])
    expect(errorFields({ schema: { sameAs: [42] } })).toEqual(['schema.sameAs.0'])
    const eleven = Array.from({ length: SAME_AS_MAX + 1 }, (_, i) => `https://a.example/${i}`)
    expect(errorFields({ schema: { sameAs: eleven } })).toEqual(['schema.sameAs'])
    const empty = validateSeoConfig({ schema: { sameAs: [] } })
    expect(empty.ok).toBe(true)
    if (empty.ok) expect(empty.value.schema).toBeUndefined()
  })

  test('isEmptySeoConfig counts a schema section as data', () => {
    expect(isEmptySeoConfig({ schema: { enabled: false } })).toBe(false)
  })
})

describe('serialize/deserialize — schema record', () => {
  test('round-trips through the flat record shape (sameAs as JSON string)', () => {
    const config: SeoConfigData = {
      schema: {
        enabled: false,
        publisherKind: 'person',
        publisherName: 'Jane Doe',
        publisherLogoUrl: 'https://a.example/j.png',
        sameAs: ['https://x.com/jane'],
      },
    }
    const records = serializeSeoConfig(config)
    expect(records).toHaveLength(2)
    expect(records[0]!.key).toBe(INDEXNOW_CONFIG_KEY)
    expect(records[1]!.key).toBe(SCHEMA_CONFIG_KEY)
    expect(records[1]!.sameAsJson).toBe('["https://x.com/jane"]')
    expect(deserializeSeoConfigRecords(records)).toEqual({
      ...config,
      indexNow: { enabled: true },
      version: 1,
    })
  })

  test('default-ON toggle: enabled absent is materialized during upgrade', () => {
    const records = serializeSeoConfig({ schema: { publisherName: 'Acme' } })
    expect(records).toHaveLength(2)
    expect(records[0]).toEqual({ key: INDEXNOW_CONFIG_KEY, version: 1, indexNowEnabled: true })
    expect(records[1]).toEqual({
      key: SCHEMA_CONFIG_KEY,
      version: 1,
      schemaEnabled: true,
      publisherName: 'Acme',
    })
  })

  test('an explicit empty schema section still carries materialized toggle values', () => {
    expect(serializeSeoConfig({ schema: {} })).toEqual([
      { key: INDEXNOW_CONFIG_KEY, version: 1, indexNowEnabled: true },
      { key: SCHEMA_CONFIG_KEY, version: 1, schemaEnabled: true },
    ])
  })

  test('malformed stored values are dropped defensively', () => {
    const config = deserializeSeoConfigRecords([
      {
        key: SCHEMA_CONFIG_KEY,
        publisherKind: 'company',
        publisherLogoUrl: '//evil.example/x',
        sameAsJson: 'not json',
      },
    ])
    expect(config.schema).toBeUndefined()
  })

  test('parseStoredSameAs keeps only valid unique absolute URLs, capped', () => {
    expect(parseStoredSameAs('["https://a.example","/rel","https://a.example",42]')).toEqual([
      'https://a.example',
    ])
    expect(parseStoredSameAs('{"a":1}')).toBeUndefined()
    const overflow = JSON.stringify(
      Array.from({ length: SAME_AS_MAX + 5 }, (_, i) => `https://a.example/${i}`),
    )
    expect(parseStoredSameAs(overflow)).toHaveLength(SAME_AS_MAX)
  })

  test('parseStoredSameAs refuses to parse an over-long raw string (round 5 wave 2 O#6a)', () => {
    // Maximal legitimate serialization still round-trips…
    const maximal = JSON.stringify(
      Array.from({ length: SAME_AS_MAX }, (_, i) => `https://a.example/${'x'.repeat(1980)}${i}`),
    )
    expect(maximal.length).toBeLessThanOrEqual(SAME_AS_JSON_MAX)
    expect(parseStoredSameAs(maximal)).toHaveLength(SAME_AS_MAX)
    // …but a hand-edited multi-megabyte record is refused BEFORE JSON.parse.
    const bloated = `["https://a.example","${'x'.repeat(SAME_AS_JSON_MAX)}"]`
    expect(parseStoredSameAs(bloated)).toBeUndefined()
  })
})

describe('resolveConfigSections — POST /config presence-first resolution', () => {
  const existing: SeoConfigData = {
    site: { siteName: 'Old' },
    tables: { posts: { titleTemplate: '%title%' } },
    schema: { publisherName: 'Acme', enabled: false },
  }

  test('raw body WITHOUT a schema key keeps the stored section', () => {
    const validated: SeoConfigData = { site: { siteName: 'New' } }
    expect(resolveConfigSections({ site: { siteName: 'New' } }, validated, existing)).toEqual({
      site: { siteName: 'New' },
      tables: { posts: { titleTemplate: '%title%' } },
      schema: { publisherName: 'Acme', enabled: false },
    })
  })

  test('raw body WITH a schema key replaces the stored section', () => {
    const validated: SeoConfigData = {
      site: { siteName: 'New' },
      schema: { publisherName: 'Other' },
    }
    expect(
      resolveConfigSections(
        { site: { siteName: 'New' }, schema: { publisherName: 'Other' } },
        validated,
        existing,
      ),
    ).toEqual({ ...validated, tables: existing.tables })
  })

  test('BLOCKER regression: `{"schema":{}}` clears schema while site/tables carry forward', () => {
    // validation normalizes `schema: {}` to undefined, but the RAW body
    // carries the key — the client speaks schema, so empty means clear.
    const raw = { schema: {} }
    const result = validateSeoConfig(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(hasExplicitConfigSection(raw)).toBe(true) // route must NOT 400
    expect(resolveConfigSections(raw, result.value, existing)).toEqual({
      site: { siteName: 'Old' },
      tables: { posts: { titleTemplate: '%title%' } },
    })
  })

  test('BLOCKER regression: schema-only clear works when nothing else is stored', () => {
    const raw = { schema: { enabled: true } }
    const result = validateSeoConfig(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(hasExplicitConfigSection(raw)).toBe(true)
    // Explicit true is data in the versioned shape, not an implicit clear.
    expect(
      resolveConfigSections(raw, result.value, { schema: { publisherName: 'Acme' } }),
    ).toEqual({ schema: { enabled: true } })
  })

  test('BLOCKER regression: a body with NO explicit section keys still 400s', () => {
    // The route rejects on hasExplicitConfigSection BEFORE resolving.
    expect(hasExplicitConfigSection({})).toBe(false)
    expect(hasExplicitConfigSection('nope')).toBe(false)
    expect(hasExplicitConfigSection({ site: {} })).toBe(true)
    expect(hasExplicitConfigSection({ indexNow: {} })).toBe(true)
  })

  test('an explicitly empty site section clears site; omitted sections survive', () => {
    const raw = { site: {} }
    const result = validateSeoConfig(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(resolveConfigSections(raw, result.value, existing)).toEqual({
      tables: existing.tables,
      schema: existing.schema,
    })
  })

  test('no stored schema → nothing to carry forward', () => {
    const validated: SeoConfigData = { site: { siteName: 'New' } }
    expect(
      resolveConfigSections({ site: { siteName: 'New' } }, validated, {
        site: { siteName: 'Old' },
      }),
    ).toEqual(validated)
  })

  test('carries a stored version marker so versioned absent toggles stay off', () => {
    const existingVersioned: SeoConfigData = {
      version: 1,
      site: { siteName: 'Old' },
    }
    const raw = { site: { siteName: 'New' } }
    const validated: SeoConfigData = { site: { siteName: 'New' } }
    const resolved = resolveConfigSections(raw, validated, existingVersioned)

    expect(resolved.version).toBe(1)
    const roundTripped = deserializeSeoConfigRecords(serializeSeoConfig(resolved))
    expect(roundTripped).toEqual({ version: 1, site: { siteName: 'New' } })
    expect(indexNowEnabled(roundTripped)).toBe(false)
    expect(schemaEnabled(roundTripped)).toBe(false)
  })

  test('clearing indexNow does not materialize its legacy default on a versioned save', () => {
    const existingVersioned: SeoConfigData = {
      version: 1,
      site: { siteName: 'Old' },
      indexNow: { enabled: false },
      schema: { enabled: false },
    }
    const raw = { indexNow: {} }
    const validated = validateSeoConfig(raw)
    expect(validated.ok).toBe(true)
    if (!validated.ok) return

    const resolved = resolveConfigSections(raw, validated.value, existingVersioned)
    expect(resolved).toEqual({
      version: 1,
      site: { siteName: 'Old' },
      schema: { enabled: false },
    })
    expect(serializeSeoConfig(resolved)).toEqual([
      { key: SITE_CONFIG_KEY, version: 1, siteName: 'Old' },
      { key: SCHEMA_CONFIG_KEY, version: 1, schemaEnabled: false },
    ])
  })
})

describe('validation trims string fields (host trims on store — echo must match)', () => {
  test('site fields are stored trimmed; whitespace-only values error', () => {
    const result = validateSeoConfig({
      site: {
        siteName: '  Acme  ',
        separator: ' — ',
        siteUrl: ' https://example.com/ ',
        titleTemplate: ' %title% %sep% %site% ',
        metaDescription: '  Desc.  ',
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.site).toEqual({
        siteName: 'Acme',
        separator: '—',
        siteUrl: 'https://example.com',
        titleTemplate: '%title% %sep% %site%',
        metaDescription: 'Desc.',
      })
    }
    expect(errorFields({ site: { siteName: '   ' } })).toEqual(['site.siteName'])
    expect(errorFields({ site: { titleTemplate: '   ' } })).toEqual(['site.titleTemplate'])
  })

  test('table templates and schema fields trim too', () => {
    const result = validateSeoConfig({
      tables: { posts: { titleTemplate: ' %title% ' } },
      schema: {
        publisherName: '  Acme Inc  ',
        publisherLogoUrl: ' /logo.png ',
        sameAs: [' https://x.com/acme '],
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tables).toEqual({ posts: { titleTemplate: '%title%' } })
      expect(result.value.schema).toEqual({
        publisherName: 'Acme Inc',
        publisherLogoUrl: '/logo.png',
        sameAs: ['https://x.com/acme'],
      })
    }
    expect(errorFields({ schema: { publisherName: '   ' } })).toEqual(['schema.publisherName'])
  })
})

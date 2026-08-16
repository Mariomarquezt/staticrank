import { describe, expect, test } from 'bun:test'
import {
  CUSTOM_SCHEMA_JSON_MAX,
  DESCRIPTION_MAX,
  ENTRY_ID_RE,
  SEO_META_FIELD_IDS,
  TABLE_SLUG_RE,
  TITLE_MAX,
  URL_MAX,
  customSchemaJsonProblem,
  deserializeSeoMeta,
  isEmptySeoMeta,
  parseEntryRef,
  parseJsonBody,
  parseQueryParams,
  seoMetaKey,
  serializeSeoMeta,
  validateSeoMeta,
  type SeoMetaPayload,
} from '../seoMeta'

function errorFields(input: unknown): string[] {
  const result = validateSeoMeta(input)
  if (result.ok) throw new Error('expected validation to fail')
  return result.errors.map((e) => e.field)
}

describe('validateSeoMeta', () => {
  test('accepts a valid full payload', () => {
    const payload: SeoMetaPayload = {
      title: 'My page',
      metaDescription: 'A description of my page.',
      canonical: 'https://example.com/my-page',
      robots: { noindex: true, nofollow: false },
      ogTitle: 'My page (OG)',
      ogDescription: 'OG description.',
      ogImage: '/uploads/og.png',
      twitterCard: 'summary_large_image',
    }
    const result = validateSeoMeta(payload)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(payload)
  })

  test('accepts an empty payload', () => {
    const result = validateSeoMeta({})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({})
      expect(isEmptySeoMeta(result.value)).toBe(true)
    }
  })

  test('rejects non-object payloads', () => {
    for (const input of [null, undefined, 'meta', 42, true, ['title']]) {
      const result = validateSeoMeta(input)
      expect(result.ok).toBe(false)
    }
  })

  test('rejects unknown keys, listing each one', () => {
    const fields = errorFields({ title: 'ok', bogus: 1, alsoBogus: 'x' })
    expect(fields).toContain('bogus')
    expect(fields).toContain('alsoBogus')
    expect(fields).not.toContain('title')
  })

  test('title: wrong type and over-length rejected', () => {
    expect(errorFields({ title: 42 })).toEqual(['title'])
    expect(errorFields({ title: 'x'.repeat(TITLE_MAX + 1) })).toEqual(['title'])
    const ok = validateSeoMeta({ title: 'x'.repeat(TITLE_MAX) })
    expect(ok.ok).toBe(true)
  })

  test('metaDescription: wrong type and over-length rejected', () => {
    expect(errorFields({ metaDescription: {} })).toEqual(['metaDescription'])
    expect(errorFields({ metaDescription: 'x'.repeat(DESCRIPTION_MAX + 1) })).toEqual([
      'metaDescription',
    ])
    expect(validateSeoMeta({ metaDescription: 'x'.repeat(DESCRIPTION_MAX) }).ok).toBe(true)
  })

  test('canonical: must be absolute http(s) URL or /-path', () => {
    expect(validateSeoMeta({ canonical: 'https://example.com/a' }).ok).toBe(true)
    expect(validateSeoMeta({ canonical: 'http://example.com' }).ok).toBe(true)
    expect(validateSeoMeta({ canonical: '/relative/path' }).ok).toBe(true)
    expect(errorFields({ canonical: 'example.com/a' })).toEqual(['canonical'])
    expect(errorFields({ canonical: 'ftp://example.com' })).toEqual(['canonical'])
    expect(errorFields({ canonical: 'relative/path' })).toEqual(['canonical'])
    expect(errorFields({ canonical: 'https://' })).toEqual(['canonical'])
    expect(errorFields({ canonical: 'https://exa mple.com' })).toEqual(['canonical'])
    expect(errorFields({ canonical: 42 })).toEqual(['canonical'])
    const tooLong = `https://example.com/${'x'.repeat(URL_MAX)}`
    expect(errorFields({ canonical: tooLong })).toEqual(['canonical'])
  })

  test('canonical: protocol-relative and hostless URLs rejected', () => {
    expect(errorFields({ canonical: '//evil.example/path' })).toEqual(['canonical'])
    expect(errorFields({ canonical: '//' })).toEqual(['canonical'])
    expect(errorFields({ canonical: 'http:///path' })).toEqual(['canonical'])
    expect(errorFields({ canonical: 'https://?q=1' })).toEqual(['canonical'])
    expect(errorFields({ canonical: 'https://#frag' })).toEqual(['canonical'])
    expect(validateSeoMeta({ canonical: 'https://example.com/x' }).ok).toBe(true)
    expect(validateSeoMeta({ canonical: '/local/path' }).ok).toBe(true)
  })

  test('ogImage: protocol-relative and hostless URLs rejected too', () => {
    expect(errorFields({ ogImage: '//evil.example/img.png' })).toEqual(['ogImage'])
    expect(errorFields({ ogImage: 'https:///img.png' })).toEqual(['ogImage'])
  })

  test('robots: object with boolean noindex/nofollow only', () => {
    expect(validateSeoMeta({ robots: { noindex: true } }).ok).toBe(true)
    expect(validateSeoMeta({ robots: {} }).ok).toBe(true)
    expect(errorFields({ robots: 'noindex' })).toEqual(['robots'])
    expect(errorFields({ robots: ['noindex'] })).toEqual(['robots'])
    expect(errorFields({ robots: { noindex: 'yes' } })).toEqual(['robots.noindex'])
    expect(errorFields({ robots: { nofollow: 1 } })).toEqual(['robots.nofollow'])
    expect(errorFields({ robots: { maxSnippet: 5 } })).toEqual(['robots.maxSnippet'])
  })

  test('ogTitle / ogDescription: bounded strings', () => {
    expect(errorFields({ ogTitle: false })).toEqual(['ogTitle'])
    expect(errorFields({ ogTitle: 'x'.repeat(TITLE_MAX + 1) })).toEqual(['ogTitle'])
    expect(errorFields({ ogDescription: 3 })).toEqual(['ogDescription'])
    expect(errorFields({ ogDescription: 'x'.repeat(DESCRIPTION_MAX + 1) })).toEqual([
      'ogDescription',
    ])
  })

  test('ogImage: same rules as canonical', () => {
    expect(validateSeoMeta({ ogImage: 'https://cdn.example.com/img.png' }).ok).toBe(true)
    expect(validateSeoMeta({ ogImage: '/uploads/img.png' }).ok).toBe(true)
    expect(errorFields({ ogImage: 'img.png' })).toEqual(['ogImage'])
    expect(errorFields({ ogImage: 7 })).toEqual(['ogImage'])
  })

  test('twitterCard: enum only', () => {
    expect(validateSeoMeta({ twitterCard: 'summary' }).ok).toBe(true)
    expect(validateSeoMeta({ twitterCard: 'summary_large_image' }).ok).toBe(true)
    expect(errorFields({ twitterCard: 'player' })).toEqual(['twitterCard'])
    expect(errorFields({ twitterCard: 1 })).toEqual(['twitterCard'])
  })

  test('collects errors across multiple fields in one pass', () => {
    const fields = errorFields({
      title: 1,
      canonical: 'nope',
      robots: { noindex: 'x' },
      twitterCard: 'huge',
      junk: true,
    })
    expect(fields.sort()).toEqual(
      ['canonical', 'junk', 'robots.noindex', 'title', 'twitterCard'].sort(),
    )
  })

  test('undefined-valued keys are treated as absent', () => {
    const result = validateSeoMeta({ title: undefined, robots: undefined })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({})
  })

  test('rejects payloads with a non-plain prototype (inherited fields)', () => {
    const inherited = Object.create({ title: 'inherited' })
    expect(validateSeoMeta(inherited).ok).toBe(false)
    class Payload {
      title = 'own but classy'
    }
    expect(validateSeoMeta(new Payload()).ok).toBe(false)
  })

  test('accepts null-prototype payloads and reads own properties only', () => {
    const nullProto = Object.assign(Object.create(null), { title: 'ok' })
    const result = validateSeoMeta(nullProto)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ title: 'ok' })
  })
})

describe('seoMetaKey', () => {
  test('joins tableSlug and entryId with a colon', () => {
    expect(seoMetaKey('pages', 'abc123')).toBe('pages:abc123')
  })
})

describe('serialize / deserialize', () => {
  test('round-trips a full payload through flat record data', () => {
    const payload: SeoMetaPayload = {
      title: 'T',
      metaDescription: 'D',
      canonical: '/c',
      robots: { noindex: true, nofollow: false },
      ogTitle: 'OT',
      ogDescription: 'OD',
      ogImage: 'https://example.com/i.png',
      twitterCard: 'summary',
    }
    const data = serializeSeoMeta('pages:e1', payload)
    expect(data.key).toBe('pages:e1')
    expect(data.robotsNoindex).toBe(true)
    expect(data.robotsNofollow).toBe(false)
    expect('robots' in data).toBe(false)
    expect(deserializeSeoMeta(data)).toEqual(payload)
  })

  test('sparse payload omits absent fields entirely', () => {
    const data = serializeSeoMeta('posts:e2', { title: 'Just a title' })
    expect(Object.keys(data).sort()).toEqual(['key', 'title'])
    expect(deserializeSeoMeta(data)).toEqual({ title: 'Just a title' })
  })

  test('deserialize drops malformed stored values instead of propagating them', () => {
    const meta = deserializeSeoMeta({
      key: 'pages:e3',
      title: 42,
      robotsNoindex: 'yes',
      twitterCard: 'player',
      ogImage: '',
    })
    expect(meta).toEqual({})
  })
})

describe('parseQueryParams', () => {
  test('parses simple query strings', () => {
    expect(parseQueryParams('/meta?table=pages&entry=e1')).toEqual({
      table: 'pages',
      entry: 'e1',
    })
  })

  test('returns empty object without a query', () => {
    expect(parseQueryParams('/meta')).toEqual({})
  })

  test('decodes percent-encoding and plus-as-space; first value wins', () => {
    expect(parseQueryParams('/x?a=hello%20world&b=a+b&a=second')).toEqual({
      a: 'hello world',
      b: 'a b',
    })
  })

  test('skips malformed percent-encoding without throwing', () => {
    expect(parseQueryParams('/x?bad=%zz&good=1')).toEqual({ good: '1' })
  })

  test('hostile keys behave as plain data (null-prototype result)', () => {
    const params = parseQueryParams('/x?__proto__=polluted&constructor=c&toString=t')
    expect(Object.getPrototypeOf(params)).toBeNull()
    expect(params.__proto__).toBe('polluted')
    expect(params.constructor).toBe('c')
    expect(params.toString).toBe('t')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('parseEntryRef', () => {
  test('accepts a full ref', () => {
    const ref = parseEntryRef('http://host/admin/api/cms/plugins/p/runtime/meta?table=pages&entry=e9')
    expect(ref).toEqual({ ok: true, tableSlug: 'pages', entryId: 'e9' })
  })

  test('rejects missing table and entry with field errors', () => {
    const ref = parseEntryRef('/meta')
    expect(ref.ok).toBe(false)
    if (!ref.ok) {
      expect(ref.errors.map((e) => e.field).sort()).toEqual(['entry', 'table'])
    }
  })

  test('rejects empty values', () => {
    const ref = parseEntryRef('/meta?table=&entry=e1')
    expect(ref.ok).toBe(false)
    if (!ref.ok) expect(ref.errors.map((e) => e.field)).toEqual(['table'])
  })

  test('rejects ":" in either component (key-collision guard)', () => {
    // table "a" + entry "b:c" must never alias table "a:b" + entry "c".
    const byTable = parseEntryRef('/meta?table=a%3Ab&entry=c')
    expect(byTable.ok).toBe(false)
    if (!byTable.ok) expect(byTable.errors.map((e) => e.field)).toEqual(['table'])
    const byEntry = parseEntryRef('/meta?table=a&entry=b%3Ac')
    expect(byEntry.ok).toBe(false)
    if (!byEntry.ok) expect(byEntry.errors.map((e) => e.field)).toEqual(['entry'])
  })

  test('component charsets match host formats', () => {
    // Table slugs: slugFromTitle output (lowercase alnum + hyphen) accepted,
    // superset allows case + underscore; leading punctuation rejected.
    expect(TABLE_SLUG_RE.test('pages')).toBe(true)
    expect(TABLE_SLUG_RE.test('blog-posts')).toBe(true)
    expect(TABLE_SLUG_RE.test('My_Table')).toBe(true)
    expect(TABLE_SLUG_RE.test('-leading')).toBe(false)
    expect(TABLE_SLUG_RE.test('a b')).toBe(false)
    expect(TABLE_SLUG_RE.test('a/b')).toBe(false)
    // Entry ids: nanoid default alphabet [A-Za-z0-9_-].
    expect(ENTRY_ID_RE.test('V1StGXR8_Z5jdHi6B-myT')).toBe(true)
    expect(ENTRY_ID_RE.test('id.with.dots')).toBe(false)
    expect(ENTRY_ID_RE.test('id with space')).toBe(false)
    const bad = parseEntryRef('/meta?table=pages&entry=e%2F1')
    expect(bad.ok).toBe(false)
  })
})

describe('parseJsonBody', () => {
  test('parses a valid JSON object', () => {
    const result = parseJsonBody('{"title":"T"}')
    expect(result).toEqual({ ok: true, value: { title: 'T' } })
  })

  test('rejects empty and whitespace-only bodies', () => {
    for (const text of ['', '   ', '\n\t']) {
      const result = parseJsonBody(text)
      expect(result.ok).toBe(false)
    }
  })

  test('rejects malformed JSON (truncated body cannot masquerade as {})', () => {
    const result = parseJsonBody('{"title":"cut off')
    expect(result.ok).toBe(false)
  })

  test('arrays/scalars parse but fail payload validation downstream', () => {
    const arr = parseJsonBody('[1,2]')
    expect(arr.ok).toBe(true)
    if (arr.ok) expect(validateSeoMeta(arr.value).ok).toBe(false)
    const scalar = parseJsonBody('"just a string"')
    expect(scalar.ok).toBe(true)
    if (scalar.ok) expect(validateSeoMeta(scalar.value).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Task 2.3 — focusKeywords + schemaType
// ---------------------------------------------------------------------------

describe('validateSeoMeta — focusKeywords', () => {
  test('accepts up to 10 trimmed unique keywords (POST /meta payload shape)', () => {
    const result = validateSeoMeta({ focusKeywords: ['  seo plugin  ', 'instatic'] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.focusKeywords).toEqual(['seo plugin', 'instatic'])
  })

  test('empty array is treated as absent', () => {
    const result = validateSeoMeta({ focusKeywords: [] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.focusKeywords).toBeUndefined()
  })

  test('rejects non-arrays, non-string items, empties, and over-long items', () => {
    expect(errorFields({ focusKeywords: 'seo' })).toEqual(['focusKeywords'])
    expect(errorFields({ focusKeywords: [42] })).toEqual(['focusKeywords.0'])
    expect(errorFields({ focusKeywords: ['ok', '   '] })).toEqual(['focusKeywords.1'])
    expect(errorFields({ focusKeywords: ['x'.repeat(81)] })).toEqual(['focusKeywords.0'])
    // Exactly 80 chars (post-trim) is fine.
    expect(validateSeoMeta({ focusKeywords: [' ' + 'x'.repeat(80) + ' '] }).ok).toBe(true)
  })

  test('CONTRACT: normalized dedupe — NFC + toLowerCase key, first original wins, order kept', () => {
    const result = validateSeoMeta({
      focusKeywords: ['SEO Plugin', ' seo plugin ', 'zeta', 'Café', 'Café', 'alpha'],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // ' seo plugin ' (case dup) and 'Café' (NFD form of Café)
      // are silently dropped; the FIRST occurrence's original trimmed
      // string is the display value; relative order preserved.
      expect(result.value.focusKeywords).toEqual(['SEO Plugin', 'zeta', 'Café', 'alpha'])
    }
  })

  test('the ≤10 cap applies AFTER dedupe', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `kw${i}`)
    // 12 raw items collapsing to 10 unique → fine.
    const result = validateSeoMeta({ focusKeywords: [...ten, 'KW0', ' kw1 '] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.focusKeywords).toEqual(ten)
    // 11 unique after dedupe → error.
    const eleven = Array.from({ length: 11 }, (_, i) => `kw${i}`)
    expect(errorFields({ focusKeywords: eleven })).toEqual(['focusKeywords'])
  })
})

describe('validateSeoMeta — schemaType', () => {
  test('accepts every supported schema.org page type', () => {
    for (const t of ['WebPage', 'AboutPage', 'ContactPage', 'CollectionPage', 'SearchResultsPage']) {
      const result = validateSeoMeta({ schemaType: t })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.schemaType).toBe(t as never)
    }
  })

  test('rejects unknown types and wrong types', () => {
    expect(errorFields({ schemaType: 'FAQPage' })).toEqual(['schemaType'])
    expect(errorFields({ schemaType: 7 })).toEqual(['schemaType'])
  })

  test('unknown-key rejection still holds alongside the new fields', () => {
    expect(errorFields({ schemaType: 'WebPage', bogus: 1 })).toEqual(['bogus'])
  })
})

describe('serialize/deserialize — focusKeywords (JSON-string flat field) + schemaType', () => {
  test('round-trips through the flat record shape', () => {
    const meta: SeoMetaPayload = {
      title: 'T',
      focusKeywords: ['seo plugin', 'instatic'],
      schemaType: 'AboutPage',
    }
    const data = serializeSeoMeta('pages:p1', meta)
    expect(data.focusKeywords).toBe('["seo plugin","instatic"]')
    expect(data.schemaType).toBe('AboutPage')
    expect(deserializeSeoMeta(data)).toEqual(meta)
  })

  test('absent fields serialize to nothing and deserialize to nothing', () => {
    const data = serializeSeoMeta('pages:p1', { title: 'T' })
    expect('focusKeywords' in data).toBe(false)
    expect('schemaType' in data).toBe(false)
    expect(deserializeSeoMeta(data)).toEqual({ title: 'T' })
  })

  test('malformed stored JSON / items are dropped defensively, never thrown', () => {
    expect(deserializeSeoMeta({ key: 'k', focusKeywords: 'not json' })).toEqual({})
    expect(deserializeSeoMeta({ key: 'k', focusKeywords: '{"a":1}' })).toEqual({})
    expect(
      deserializeSeoMeta({ key: 'k', focusKeywords: '["ok", 42, "", "  ", "ok"]' }),
    ).toEqual({ focusKeywords: ['ok'] })
    expect(deserializeSeoMeta({ key: 'k', schemaType: 'FAQPage' })).toEqual({})
  })

  test('stored keyword overflow is capped at 10 on read', () => {
    const twelve = JSON.stringify(Array.from({ length: 12 }, (_, i) => `kw${i}`))
    const meta = deserializeSeoMeta({ key: 'k', focusKeywords: twelve })
    expect(meta.focusKeywords).toHaveLength(10)
  })

  test('isEmptySeoMeta counts the new fields as data', () => {
    expect(isEmptySeoMeta({ focusKeywords: ['a'] })).toBe(false)
    expect(isEmptySeoMeta({ schemaType: 'WebPage' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// customSchemaJson (wave 3.5) — per-entry custom JSON-LD on the free field
// ---------------------------------------------------------------------------

describe('customSchemaJson', () => {
  const validJson = '{"@context":"https://schema.org","@type":"Offer","price":"1"}'

  test('accepts a valid JSON-LD object string', () => {
    const result = validateSeoMeta({ customSchemaJson: validJson })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.customSchemaJson).toBe(validJson)
  })

  test("'' is accepted and treated as absent (clearing)", () => {
    const result = validateSeoMeta({ customSchemaJson: '' })
    expect(result.ok).toBe(true)
    if (result.ok) expect('customSchemaJson' in result.value).toBe(false)
  })

  test('rejects non-strings, malformed JSON, non-objects, and missing/empty @type', () => {
    expect(errorFields({ customSchemaJson: 42 })).toEqual(['customSchemaJson'])
    expect(errorFields({ customSchemaJson: 'not json' })).toEqual(['customSchemaJson'])
    expect(errorFields({ customSchemaJson: '[1,2]' })).toEqual(['customSchemaJson'])
    expect(errorFields({ customSchemaJson: '"scalar"' })).toEqual(['customSchemaJson'])
    expect(errorFields({ customSchemaJson: '{"name":"no type"}' })).toEqual(['customSchemaJson'])
    expect(errorFields({ customSchemaJson: '{"@type":""}' })).toEqual(['customSchemaJson'])
    expect(errorFields({ customSchemaJson: '{"@type":42}' })).toEqual(['customSchemaJson'])
  })

  test('enforces the CUSTOM_SCHEMA_JSON_MAX length cap', () => {
    const atCap = `{"@type":"Thing","pad":"${'x'.repeat(CUSTOM_SCHEMA_JSON_MAX - 30)}"}`
    expect(atCap.length).toBeLessThanOrEqual(CUSTOM_SCHEMA_JSON_MAX)
    expect(validateSeoMeta({ customSchemaJson: atCap }).ok).toBe(true)
    const overCap = `{"@type":"Thing","pad":"${'x'.repeat(CUSTOM_SCHEMA_JSON_MAX)}"}`
    expect(errorFields({ customSchemaJson: overCap })).toEqual(['customSchemaJson'])
  })

  test('customSchemaJsonProblem: shared write/read rule', () => {
    expect(customSchemaJsonProblem(validJson)).toBeUndefined()
    expect(customSchemaJsonProblem('nope')).toContain('valid JSON')
    expect(customSchemaJsonProblem('[]')).toContain('JSON object')
    expect(customSchemaJsonProblem('{"a":1}')).toContain('@type')
  })

  test('serialize/deserialize round-trip through the flat record shape', () => {
    const meta: SeoMetaPayload = { title: 'T', customSchemaJson: validJson }
    const data = serializeSeoMeta('pages:p1', meta)
    expect(data.customSchemaJson).toBe(validJson)
    expect(deserializeSeoMeta(data)).toEqual(meta)
  })

  test('absent field serializes to nothing and deserializes to nothing', () => {
    const data = serializeSeoMeta('pages:p1', { title: 'T' })
    expect('customSchemaJson' in data).toBe(false)
    expect(deserializeSeoMeta(data)).toEqual({ title: 'T' })
  })

  test('forged stored values are dropped defensively on read, never thrown', () => {
    expect(deserializeSeoMeta({ key: 'k', customSchemaJson: 'not json' })).toEqual({})
    expect(deserializeSeoMeta({ key: 'k', customSchemaJson: '[1]' })).toEqual({})
    expect(deserializeSeoMeta({ key: 'k', customSchemaJson: '{"no":"type"}' })).toEqual({})
    expect(deserializeSeoMeta({ key: 'k', customSchemaJson: 42 })).toEqual({})
    const oversized = `{"@type":"Thing","pad":"${'x'.repeat(CUSTOM_SCHEMA_JSON_MAX)}"}`
    expect(deserializeSeoMeta({ key: 'k', customSchemaJson: oversized })).toEqual({})
  })

  test('field-enumeration paths are complete for the new field', () => {
    // The resource field id is declared…
    expect(SEO_META_FIELD_IDS).toContain('customSchemaJson')
    // …the payload key is accepted (no unknown-field error)…
    expect(validateSeoMeta({ customSchemaJson: validJson }).ok).toBe(true)
    // …it counts as data…
    expect(isEmptySeoMeta({ customSchemaJson: validJson })).toBe(false)
    // …and the cap constant mirrors the Pro store's rawJson cap.
    expect(CUSTOM_SCHEMA_JSON_MAX).toBe(20_000)
  })
})

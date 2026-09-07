/**
 * seo_meta storage logic — pure validation + (de)serialization, no SDK
 * imports so it unit-tests under plain `bun test` and bundles into the
 * QuickJS sandbox without ambient dependencies (no `URL`, no Node APIs).
 *
 * Storage model (task 1.2): one plugin-storage record per entry, in the
 * `seo-meta` resource (DESIGN §5.1 names it `seo_meta`, but manifest
 * resource ids must match /^[a-z][a-z0-9-]*$/ — vendor/Instatic
 * src/core/plugins/manifest.ts:31,121 — so the id is kebab-cased). Records
 * are keyed by a `key` data field of the form `${tableSlug}:${entryId}`;
 * the host storage API has no get-by-key, so lookups go through
 * `list({ filter: { key } })` (data_json field filter).
 *
 * The host validates record data against the declared resource fields and
 * SILENTLY DROPS any undeclared field (vendor/Instatic
 * src/core/plugins/resourceRecords.ts:31-62 — only declared fields are
 * copied). Resource fields are flat scalars only ('text' | 'longtext' |
 * 'number' | 'date' | 'boolean'), so the nested `robots` object is
 * flattened to `robotsNoindex` / `robotsNofollow` booleans on write and
 * re-nested on read. Keep `SEO_META_FIELD_IDS` in sync with the resource
 * declaration in instatic-plugin.config.ts.
 */

// ---------------------------------------------------------------------------
// Payload shape
// ---------------------------------------------------------------------------

export interface SeoRobots {
  noindex?: boolean
  nofollow?: boolean
}

export type TwitterCard = 'summary' | 'summary_large_image'

/**
 * Per-entry schema.org page-type override (task 2.3). Values mirror
 * SchemaGraphInput['page']['type'] in server/lib/schemaGraph.ts — the
 * publish filter passes the stored value straight through (default
 * WebPage when absent).
 */
export type SchemaPageType =
  | 'WebPage'
  | 'AboutPage'
  | 'ContactPage'
  | 'CollectionPage'
  | 'SearchResultsPage'

export interface SeoMetaPayload {
  title?: string
  metaDescription?: string
  canonical?: string
  robots?: SeoRobots
  ogTitle?: string
  ogDescription?: string
  ogImage?: string
  twitterCard?: TwitterCard
  /**
   * Focus keywords for editor-side content analysis (task 2.3): ≤10
   * items, each trimmed and ≤80 chars, no duplicates. Stored as ONE
   * JSON-string flat field (host resource fields are flat scalars only).
   */
  focusKeywords?: string[]
  /** schema.org page type override for the JSON-LD graph. */
  schemaType?: SchemaPageType
  /**
   * Per-entry custom JSON-LD (wave 3.5). Same rules as a schema template's
   * rawJson (server/schema/types.ts — mirrored here because this FREE
   * module must not import server/schema/**): a parseable JSON OBJECT with
   * a string `@type`, ≤ CUSTOM_SCHEMA_JSON_MAX chars. The free tier stores
   * it fine — only the Pro publish filter EMITS it.
   */
  customSchemaJson?: string
}

export interface FieldError {
  field: string
  message: string
}

export type SeoMetaValidation =
  | { ok: true; value: SeoMetaPayload }
  | { ok: false; errors: FieldError[] }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Manifest resource id — must match instatic-plugin.config.ts. */
export const SEO_META_RESOURCE_ID = 'seo-meta'

/** Per-invocation cap on orphan/duplicate record deletions. */
export const SEO_META_CLEANUP_CAP = 25

/** Physical seo-meta records inspected per maintenance tick. */
export const SEO_META_RECONCILE_BATCH_SIZE = 50

/** seo-state key for the persisted seo-meta reconcile offset. */
export const SEO_META_RECONCILE_STATE_KEY = 'meta-reconcile'

export const TITLE_MAX = 300
export const DESCRIPTION_MAX = 500
export const URL_MAX = 2000

const TWITTER_CARD_VALUES: readonly TwitterCard[] = ['summary', 'summary_large_image']

const SCHEMA_TYPE_VALUES: readonly SchemaPageType[] = [
  'WebPage',
  'AboutPage',
  'ContactPage',
  'CollectionPage',
  'SearchResultsPage',
]

export const FOCUS_KEYWORD_MAX = 80
export const FOCUS_KEYWORDS_MAX = 10

/**
 * customSchemaJson length cap — numerically equal to the Pro store's
 * RAW_JSON_MAX_LENGTH (server/schema/types.ts: "same rules as rawJson")
 * but declared LOCALLY: this free module must not import server/schema/**.
 */
export const CUSTOM_SCHEMA_JSON_MAX = 20_000

/** Numeric mirror of schema/store.RAW_JSON_MAX_DEPTH. Kept local because
 * this free module must not import server/schema/**. */
export const CUSTOM_SCHEMA_JSON_MAX_DEPTH = 32

/** A JSON string can expand a UTF-16 code unit to at most `\\u0000`. */
const JSON_STRING_MAX_ESCAPED_LENGTH = 6

function maxJsonStringLength(maxCharacters: number): number {
  return 2 + maxCharacters * JSON_STRING_MAX_ESCAPED_LENGTH
}

function maxJsonPropertyLength(key: string, valueLength: number): number {
  return key.length + 3 + valueLength
}

function maxJsonObjectLength(properties: readonly number[]): number {
  return 2 + properties.reduce((total, propertyLength) => total + propertyLength + 1, 0)
}

function maxJsonArrayLength(itemLength: number, itemCount: number): number {
  return 2 + itemCount * (itemLength + 1)
}

const MAX_JSON_BOOLEAN_LENGTH = 'false'.length
const MAX_ROBOTS_JSON_LENGTH = maxJsonObjectLength([
  maxJsonPropertyLength('noindex', MAX_JSON_BOOLEAN_LENGTH),
  maxJsonPropertyLength('nofollow', MAX_JSON_BOOLEAN_LENGTH),
])
/**
 * Worst-case length of the ONE JSON string `serializeSeoMeta` writes for
 * `focusKeywords` (FOCUS_KEYWORDS_MAX items × FOCUS_KEYWORD_MAX chars,
 * each fully `\uXXXX`-escaped). Exported because the READ side gates on
 * it too: `parseStoredFocusKeywords` refuses to parse anything longer,
 * so a hand-edited multi-megabyte record cannot burn the publish
 * deadline before the per-item caps get a chance to apply.
 */
export const MAX_FOCUS_KEYWORDS_JSON_LENGTH = maxJsonArrayLength(
  maxJsonStringLength(FOCUS_KEYWORD_MAX),
  FOCUS_KEYWORDS_MAX,
)
const MAX_TWITTER_CARD_LENGTH = Math.max(...TWITTER_CARD_VALUES.map((value) => value.length))
const MAX_SCHEMA_TYPE_LENGTH = Math.max(...SCHEMA_TYPE_VALUES.map((value) => value.length))

/**
 * Raw JSON character budget for POST /meta. This is a conservative upper
 * bound over every validator cap, including JSON field names, envelopes and
 * worst-case string escaping; it is deliberately independent of the beacon
 * payload budget in trackerPayload.ts.
 */
export const SEO_META_REQUEST_BODY_MAX = maxJsonObjectLength([
  maxJsonPropertyLength('title', maxJsonStringLength(TITLE_MAX)),
  maxJsonPropertyLength('metaDescription', maxJsonStringLength(DESCRIPTION_MAX)),
  maxJsonPropertyLength('canonical', maxJsonStringLength(URL_MAX)),
  maxJsonPropertyLength('robots', MAX_ROBOTS_JSON_LENGTH),
  maxJsonPropertyLength('ogTitle', maxJsonStringLength(TITLE_MAX)),
  maxJsonPropertyLength('ogDescription', maxJsonStringLength(DESCRIPTION_MAX)),
  maxJsonPropertyLength('ogImage', maxJsonStringLength(URL_MAX)),
  maxJsonPropertyLength('twitterCard', maxJsonStringLength(MAX_TWITTER_CARD_LENGTH)),
  maxJsonPropertyLength('focusKeywords', MAX_FOCUS_KEYWORDS_JSON_LENGTH),
  maxJsonPropertyLength('schemaType', maxJsonStringLength(MAX_SCHEMA_TYPE_LENGTH)),
  maxJsonPropertyLength('customSchemaJson', maxJsonStringLength(CUSTOM_SCHEMA_JSON_MAX)),
])

export function isSeoMetaRequestBodyWithinLimit(raw: string): boolean {
  return raw.length <= SEO_META_REQUEST_BODY_MAX
}

/**
 * CROSS-AGENT CONTRACT (task 2.3, review round 2 #4) — focus-keyword
 * duplicate rule, mirrored verbatim by the editor panel
 * (admin/lib/metaForm.ts):
 *
 *   Two keywords are duplicates iff
 *     a.trim().normalize('NFC').toLowerCase()
 *       === b.trim().normalize('NFC').toLowerCase()
 *
 * — plain locale-independent `toLowerCase` (never toLocaleLowerCase).
 * Dedupe is SILENT and first-wins: the FIRST occurrence's trimmed
 * ORIGINAL string (original casing/diacritic form) is kept as the display
 * value, later duplicates are dropped, relative order is preserved, and
 * the ≤FOCUS_KEYWORDS_MAX cap applies AFTER dedupe. `normalize` is
 * guarded for QuickJS builds compiled without Unicode support.
 */
export function focusKeywordKey(keyword: string): string {
  const trimmed = keyword.trim()
  const normalized =
    typeof trimmed.normalize === 'function' ? trimmed.normalize('NFC') : trimmed
  return normalized.toLowerCase()
}

/**
 * Flat record-data field ids, matching the `seo-meta` resource declaration
 * in instatic-plugin.config.ts (plus the lookup `key`).
 */
export const SEO_META_FIELD_IDS = [
  'key',
  'title',
  'metaDescription',
  'canonical',
  'robotsNoindex',
  'robotsNofollow',
  'ogTitle',
  'ogDescription',
  'ogImage',
  'twitterCard',
  'focusKeywords',
  'schemaType',
  'customSchemaJson',
] as const

// ---------------------------------------------------------------------------
// Key
// ---------------------------------------------------------------------------

/** Storage key for one entry's meta: `${tableSlug}:${entryId}` (DESIGN §5.1). */
export function seoMetaKey(tableSlug: string, entryId: string): string {
  return `${tableSlug}:${entryId}`
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Plain-object check hardened against prototype tricks: the value must be a
 * non-array object whose prototype is `Object.prototype` or `null`, so
 * payloads carrying inherited fields (`Object.create({title: …})`) are
 * rejected outright instead of validating inherited state.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Absolute http(s) URL with a NON-EMPTY authority (`http:///path` and bare
 * `https://` are rejected), or a site-relative path starting with `/` but
 * not `//` (protocol-relative URLs like `//evil.example/x` are rejected —
 * they resolve to an attacker-chosen host). No whitespace anywhere. Pure
 * string check — the QuickJS sandbox has no guaranteed `URL` global.
 * Exported: seoConfig.ts applies the SAME rule to `schema.publisherLogoUrl`
 * (task 2.3 — "same URL rules as ogImage").
 */
export function isUrlLike(value: string): boolean {
  if (value === '' || /\s/.test(value)) return false
  const absolute = /^https?:\/\/([^/?#]*)/i.exec(value)
  if (absolute) return absolute[1]!.length > 0
  return value.startsWith('/') && !value.startsWith('//')
}

/** Absolute http(s) URL with a non-empty authority — no relative fallback. */
export function isAbsoluteHttpUrl(value: string): boolean {
  if (value === '' || /\s/.test(value)) return false
  const absolute = /^https?:\/\/([^/?#]*)/i.exec(value)
  return absolute !== null && absolute[1]!.length > 0
}

function checkBoundedString(
  errors: FieldError[],
  field: string,
  value: unknown,
  max: number,
): value is string {
  if (typeof value !== 'string') {
    errors.push({ field, message: `must be a string` })
    return false
  }
  if (value.length > max) {
    errors.push({ field, message: `must be at most ${max} characters` })
    return false
  }
  return true
}

/**
 * Bounded string that is TRIMMED before storage — parity with seoConfig's
 * `checkTrimmedString` (round 5 triage C#5). The host trims every text
 * field on write (`data[field.id] = value.trim()` — vendor/Instatic
 * src/core/plugins/resourceRecords.ts:61), so an untrimmed validated
 * value would diverge from what actually stores, and a whitespace-only
 * value would store as `''` and silently vanish from the document the
 * save appeared to accept. Validation therefore normalizes to the trimmed
 * value and rejects values that trim to nothing.
 *
 * `''` is NOT an error here (unlike seoConfig, where '' is absent
 * upstream): POST /meta is a FULL REPLACE and an empty string is its
 * documented clear-by-empty form — `serializeSeoMeta` drops it, so
 * passing it through keeps those round-trips exact.
 *
 * Returns the string to store, or undefined when an error was recorded.
 */
function checkTrimmedString(
  errors: FieldError[],
  field: string,
  value: unknown,
  max: number,
): string | undefined {
  if (!checkBoundedString(errors, field, value, max)) return undefined
  const raw = value as string
  if (raw === '') return ''
  const trimmed = raw.trim()
  if (trimmed === '') {
    errors.push({ field, message: 'must contain a non-whitespace character' })
    return undefined
  }
  return trimmed
}

function checkUrlField(errors: FieldError[], field: string, value: unknown): value is string {
  if (!checkBoundedString(errors, field, value, URL_MAX)) return false
  if (!isUrlLike(value as string)) {
    errors.push({
      field,
      message: `must be an absolute http(s) URL or a path starting with "/"`,
    })
    return false
  }
  return true
}

/**
 * Validate an incoming seo_meta payload. All fields optional; unknown keys
 * and wrong types are rejected with a full list of field errors. Keys whose
 * value is `undefined` are treated as absent.
 */
export function validateSeoMeta(input: unknown): SeoMetaValidation {
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ field: '', message: 'payload must be a JSON object' }] }
  }

  const errors: FieldError[] = []
  const value: SeoMetaPayload = {}

  for (const key of Object.keys(input)) {
    // `imageAudit` is the GET /meta RESPONSE ENVELOPE's read-only join
    // (task 2.4: published-page image findings from the sitemap record) —
    // never a storable field. A client that round-trips a GET body into
    // POST must not 400 over it, so it is silently ignored here (and
    // never copied into the validated value below).
    if (key === 'imageAudit') continue
    if (!(SEO_META_PAYLOAD_KEYS as readonly string[]).includes(key)) {
      errors.push({ field: key, message: 'unknown field' })
    }
  }

  // Own enumerable properties only (defensive even after the prototype
  // check: a polluted Object.prototype must never leak into the payload).
  const raw: Record<string, unknown> = { ...input }

  if (raw.title !== undefined) {
    const title = checkTrimmedString(errors, 'title', raw.title, TITLE_MAX)
    if (title !== undefined) value.title = title
  }
  if (raw.metaDescription !== undefined) {
    const metaDescription = checkTrimmedString(
      errors,
      'metaDescription',
      raw.metaDescription,
      DESCRIPTION_MAX,
    )
    if (metaDescription !== undefined) value.metaDescription = metaDescription
  }
  if (raw.canonical !== undefined && checkUrlField(errors, 'canonical', raw.canonical)) {
    value.canonical = raw.canonical as string
  }

  if (raw.robots !== undefined) {
    if (!isPlainObject(raw.robots)) {
      errors.push({ field: 'robots', message: 'must be an object' })
    } else {
      const robots: SeoRobots = {}
      for (const key of Object.keys(raw.robots)) {
        if (key !== 'noindex' && key !== 'nofollow') {
          errors.push({ field: `robots.${key}`, message: 'unknown field' })
        }
      }
      for (const flag of ['noindex', 'nofollow'] as const) {
        const flagValue = raw.robots[flag]
        if (flagValue === undefined) continue
        if (typeof flagValue !== 'boolean') {
          errors.push({ field: `robots.${flag}`, message: 'must be a boolean' })
          continue
        }
        robots[flag] = flagValue
      }
      if (Object.keys(robots).length > 0) value.robots = robots
    }
  }

  if (raw.ogTitle !== undefined) {
    const ogTitle = checkTrimmedString(errors, 'ogTitle', raw.ogTitle, TITLE_MAX)
    if (ogTitle !== undefined) value.ogTitle = ogTitle
  }
  if (raw.ogDescription !== undefined) {
    const ogDescription = checkTrimmedString(
      errors,
      'ogDescription',
      raw.ogDescription,
      DESCRIPTION_MAX,
    )
    if (ogDescription !== undefined) value.ogDescription = ogDescription
  }
  if (raw.ogImage !== undefined && checkUrlField(errors, 'ogImage', raw.ogImage)) {
    value.ogImage = raw.ogImage as string
  }

  if (raw.twitterCard !== undefined) {
    if (
      typeof raw.twitterCard !== 'string' ||
      !(TWITTER_CARD_VALUES as readonly string[]).includes(raw.twitterCard)
    ) {
      errors.push({
        field: 'twitterCard',
        message: `must be one of: ${TWITTER_CARD_VALUES.join(', ')}`,
      })
    } else {
      value.twitterCard = raw.twitterCard as TwitterCard
    }
  }

  if (raw.focusKeywords !== undefined) {
    if (!Array.isArray(raw.focusKeywords)) {
      errors.push({ field: 'focusKeywords', message: 'must be an array of strings' })
    } else {
      const keywords: string[] = []
      const seen = new Set<string>()
      let itemsOk = true
      for (let i = 0; i < raw.focusKeywords.length; i++) {
        const item = raw.focusKeywords[i]
        if (typeof item !== 'string') {
          errors.push({ field: `focusKeywords.${i}`, message: 'must be a string' })
          itemsOk = false
          continue
        }
        const trimmed = item.trim()
        if (trimmed === '') {
          errors.push({ field: `focusKeywords.${i}`, message: 'must not be empty' })
          itemsOk = false
          continue
        }
        if (trimmed.length > FOCUS_KEYWORD_MAX) {
          errors.push({
            field: `focusKeywords.${i}`,
            message: `must be at most ${FOCUS_KEYWORD_MAX} characters`,
          })
          itemsOk = false
          continue
        }
        // Normalized dedupe (see focusKeywordKey — cross-agent contract):
        // silent, first-wins, original display value kept, order preserved.
        const dedupeKey = focusKeywordKey(trimmed)
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        keywords.push(trimmed)
      }
      // The cap applies to the DEDUPED list.
      if (keywords.length > FOCUS_KEYWORDS_MAX) {
        errors.push({
          field: 'focusKeywords',
          message: `must have at most ${FOCUS_KEYWORDS_MAX} items`,
        })
      } else if (itemsOk && keywords.length > 0) {
        // Empty array = absent (clearing keywords is just omitting them).
        value.focusKeywords = keywords
      }
    }
  }

  if (raw.schemaType !== undefined) {
    if (
      typeof raw.schemaType !== 'string' ||
      !(SCHEMA_TYPE_VALUES as readonly string[]).includes(raw.schemaType)
    ) {
      errors.push({
        field: 'schemaType',
        message: `must be one of: ${SCHEMA_TYPE_VALUES.join(', ')}`,
      })
    } else {
      value.schemaType = raw.schemaType as SchemaPageType
    }
  }

  if (raw.customSchemaJson !== undefined) {
    if (
      checkBoundedString(errors, 'customSchemaJson', raw.customSchemaJson, CUSTOM_SCHEMA_JSON_MAX)
    ) {
      // '' = absent (clearing) — the parse rules apply only when non-empty
      // (server/schema/types.ts: "when present"; serializeSeoMeta drops ''
      // anyway, so accepting it keeps clear-by-empty round-trips exact).
      if ((raw.customSchemaJson as string) !== '') {
        const problem = customSchemaJsonProblem(raw.customSchemaJson as string)
        if (problem !== undefined) errors.push({ field: 'customSchemaJson', message: problem })
        else value.customSchemaJson = raw.customSchemaJson as string
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value }
}

/**
 * Structural check shared by validation (write path) and defensive
 * deserialization (read path): a customSchemaJson value must parse to a
 * plain JSON object carrying a non-empty string `@type` (same rules as a
 * schema template's rawJson — server/schema/types.ts). Returns the error
 * message, or undefined when the value is acceptable. The length cap is
 * checked by the callers (checkBoundedString / the read-side guard).
 */
export function customSchemaJsonProblem(value: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return 'must be valid JSON'
  }
  if (!isPlainObject(parsed)) return 'must be a JSON object'
  const type = parsed['@type']
  if (typeof type !== 'string' || type.trim() === '') {
    return 'must carry a non-empty string "@type"'
  }
  if (exceedsCustomSchemaJsonDepth(parsed, CUSTOM_SCHEMA_JSON_MAX_DEPTH)) {
    return `must nest at most ${CUSTOM_SCHEMA_JSON_MAX_DEPTH} levels deep`
  }
  return undefined
}

/** Iterative depth probe matching schema/store.exceedsJsonDepth. Recursion
 * would risk the same QuickJS stack overflow this guard prevents. */
function exceedsCustomSchemaJsonDepth(value: unknown, max: number): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 1 }]
  while (stack.length > 0) {
    const item = stack.pop()!
    const current = item.value
    const isArray = Array.isArray(current)
    const isObject = !isArray && current !== null && typeof current === 'object'
    if (!isArray && !isObject) continue
    if (item.depth > max) return true
    if (isArray) {
      for (const child of current as unknown[]) {
        stack.push({ value: child, depth: item.depth + 1 })
      }
    } else {
      const record = current as Record<string, unknown>
      for (const key of Object.keys(record)) {
        stack.push({ value: record[key], depth: item.depth + 1 })
      }
    }
  }
  return false
}

const SEO_META_PAYLOAD_KEYS = [
  'title',
  'metaDescription',
  'canonical',
  'robots',
  'ogTitle',
  'ogDescription',
  'ogImage',
  'twitterCard',
  'focusKeywords',
  'schemaType',
  'customSchemaJson',
] as const

/** True when a validated payload carries no meta at all. */
export function isEmptySeoMeta(meta: SeoMetaPayload): boolean {
  return Object.keys(meta).length === 0
}

// ---------------------------------------------------------------------------
// (De)serialization — payload <-> flat storage record data
// ---------------------------------------------------------------------------

/**
 * Payload → flat record data for `cms.storage`. Empty strings are omitted:
 * the host treats `''` as a missing field and drops it anyway
 * (resourceRecords.ts:33 `missing = … || value === ''`), so omitting keeps
 * the round-trip exact.
 */
export function serializeSeoMeta(key: string, meta: SeoMetaPayload): Record<string, unknown> {
  const data: Record<string, unknown> = { key }
  if (meta.title) data.title = meta.title
  if (meta.metaDescription) data.metaDescription = meta.metaDescription
  if (meta.canonical) data.canonical = meta.canonical
  if (meta.robots?.noindex !== undefined) data.robotsNoindex = meta.robots.noindex
  if (meta.robots?.nofollow !== undefined) data.robotsNofollow = meta.robots.nofollow
  if (meta.ogTitle) data.ogTitle = meta.ogTitle
  if (meta.ogDescription) data.ogDescription = meta.ogDescription
  if (meta.ogImage) data.ogImage = meta.ogImage
  if (meta.twitterCard) data.twitterCard = meta.twitterCard
  // Flat-scalar host constraint: the array rides as ONE JSON string.
  if (meta.focusKeywords && meta.focusKeywords.length > 0) {
    data.focusKeywords = JSON.stringify(meta.focusKeywords)
  }
  if (meta.schemaType) data.schemaType = meta.schemaType
  if (meta.customSchemaJson) data.customSchemaJson = meta.customSchemaJson
  return data
}

/**
 * Defensive JSON-string → keywords parse for reads: only trimmed,
 * non-empty, in-bound string items survive, deduped by the SAME
 * normalized rule as validation (focusKeywordKey — NFC + toLowerCase,
 * first occurrence's original kept, order preserved), capped at
 * FOCUS_KEYWORDS_MAX. Anything else in a hand-edited or stale record is
 * silently dropped (never a throw).
 *
 * The RAW length is gated BEFORE `JSON.parse` (round 5 triage C#4): the
 * per-item caps below only bound the parse RESULT, so an oversized
 * hand-edited record — the only way one can exist, POST /meta is
 * size-gated at the route — would otherwise be parsed in full on the
 * publish hot path and the page would ship undecorated.
 */
export function parseStoredFocusKeywords(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  if (value.length > MAX_FOCUS_KEYWORDS_JSON_LENGTH) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const keywords: string[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || trimmed.length > FOCUS_KEYWORD_MAX) continue
    const dedupeKey = focusKeywordKey(trimmed)
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    keywords.push(trimmed)
    if (keywords.length >= FOCUS_KEYWORDS_MAX) break
  }
  return keywords.length > 0 ? keywords : undefined
}

/** Validate one read-back field with the same validator used by writes. */
function readValidatedField(field: string, value: unknown): unknown {
  const validated = validateSeoMeta({ [field]: value })
  if (!validated.ok) return undefined
  return (validated.value as Record<string, unknown>)[field]
}

/**
 * Flat record data → payload. Defensive: only well-typed fields survive, so
 * a hand-edited or stale record can never produce a malformed payload.
 */
export function deserializeSeoMeta(data: Record<string, unknown>): SeoMetaPayload {
  const meta: SeoMetaPayload = {}
  const title = readValidatedField('title', data.title)
  if (typeof title === 'string' && title !== '') meta.title = title
  const metaDescription = readValidatedField('metaDescription', data.metaDescription)
  if (typeof metaDescription === 'string' && metaDescription !== '') {
    meta.metaDescription = metaDescription
  }
  const canonical = readValidatedField('canonical', data.canonical)
  if (typeof canonical === 'string' && canonical !== '') meta.canonical = canonical

  const robots: SeoRobots = {}
  if (typeof data.robotsNoindex === 'boolean') robots.noindex = data.robotsNoindex
  if (typeof data.robotsNofollow === 'boolean') robots.nofollow = data.robotsNofollow
  if (Object.keys(robots).length > 0) meta.robots = robots

  const ogTitle = readValidatedField('ogTitle', data.ogTitle)
  if (typeof ogTitle === 'string' && ogTitle !== '') meta.ogTitle = ogTitle
  const ogDescription = readValidatedField('ogDescription', data.ogDescription)
  if (typeof ogDescription === 'string' && ogDescription !== '') {
    meta.ogDescription = ogDescription
  }
  const ogImage = readValidatedField('ogImage', data.ogImage)
  if (typeof ogImage === 'string' && ogImage !== '') meta.ogImage = ogImage
  const twitterCard = readValidatedField('twitterCard', data.twitterCard)
  if (typeof twitterCard === 'string') meta.twitterCard = twitterCard as TwitterCard
  const focusKeywords = parseStoredFocusKeywords(data.focusKeywords)
  const checkedFocusKeywords =
    focusKeywords === undefined ? undefined : readValidatedField('focusKeywords', focusKeywords)
  if (Array.isArray(checkedFocusKeywords) && checkedFocusKeywords.length > 0) {
    meta.focusKeywords = checkedFocusKeywords as string[]
  }
  const schemaType = readValidatedField('schemaType', data.schemaType)
  if (typeof schemaType === 'string') meta.schemaType = schemaType as SchemaPageType
  const customSchemaJson = readValidatedField('customSchemaJson', data.customSchemaJson)
  if (typeof customSchemaJson === 'string' && customSchemaJson !== '') {
    meta.customSchemaJson = customSchemaJson
  }
  return meta
}

// ---------------------------------------------------------------------------
// Query-string parsing — route params travel as `?table=…&entry=…`
// ---------------------------------------------------------------------------

/**
 * Minimal query parser for `ServerPluginRequest.url`. The host matches
 * plugin routes by EXACT path string (server/plugins/host/rpc.ts:230 —
 * `routes.get(`${method}:${normalizeRoutePath(path)}`)`), so there are no
 * path parameters; identifying values ride the query string. First value
 * wins for repeated keys. Pure string parsing — no `URL` dependency. The
 * result is built on a null prototype so hostile keys (`__proto__`,
 * `constructor`, `toString`, …) behave as plain data.
 */
export function parseQueryParams(url: string): Record<string, string> {
  const params: Record<string, string> = Object.create(null)
  const queryStart = url.indexOf('?')
  if (queryStart === -1) return params
  const query = url.slice(queryStart + 1).split('#')[0]
  for (const pair of query.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const rawKey = eq === -1 ? pair : pair.slice(0, eq)
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1)
    let key: string
    let value: string
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '))
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '))
    } catch {
      continue // malformed percent-encoding — skip the pair
    }
    if (!(key in params)) params[key] = value
  }
  return params
}

/**
 * Key-component charsets. The storage key is `${tableSlug}:${entryId}`, so
 * NEITHER component may contain `:` — otherwise table `a` + entry `b:c`
 * collides with table `a:b` + entry `c`. Both patterns are colon-free by
 * construction and match how the pinned host formats the values:
 *
 *   - table slugs are always produced by `slugFromTitle`
 *     (server/handlers/cms/data/tables.ts:83 → src/core/utils/slug.ts:13-21),
 *     which emits only `[a-z0-9-]`; the pattern here is a tolerant superset
 *     (case-insensitive, underscore allowed) that stays colon-free.
 *   - entry (data-row) ids are `nanoid()` (server/repositories/data/rows/
 *     mutations.ts:19,65) — default nanoid alphabet `A-Za-z0-9_-`.
 */
export const TABLE_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/i
export const ENTRY_ID_RE = /^[A-Za-z0-9_-]+$/

/**
 * Length cap for either key component (round 5 triage C#5 — parity with
 * seoConfig's `TABLE_SLUG_MAX`, which is numerically URL_MAX; declared
 * locally because seoConfig imports THIS module and the dependency must
 * not run the other way). Real values are far shorter — host table slugs
 * are `slugFromTitle` output and entry ids are 21-char nanoids — so this
 * only bounds the work a hand-rolled request can ask of the charset
 * checks, and reports the overrun as a named field error instead of a
 * confusing charset message.
 */
export const ENTRY_REF_COMPONENT_MAX = URL_MAX

export interface SeoMetaStorageRef {
  tableSlug: string
  entryId: string
}

/**
 * Defensively parse a stored `${tableSlug}:${entryId}` key. Invalid or
 * ambiguous records are not safe GC targets and therefore return undefined.
 */
export function parseSeoMetaStorageKey(value: unknown): SeoMetaStorageRef | undefined {
  if (typeof value !== 'string') return undefined
  const separator = value.indexOf(':')
  if (separator <= 0 || value.indexOf(':', separator + 1) !== -1) return undefined
  const tableSlug = value.slice(0, separator)
  const entryId = value.slice(separator + 1)
  if (
    tableSlug.length > ENTRY_REF_COMPONENT_MAX ||
    entryId.length === 0 ||
    entryId.length > ENTRY_REF_COMPONENT_MAX ||
    !TABLE_SLUG_RE.test(tableSlug) ||
    !ENTRY_ID_RE.test(entryId)
  ) {
    return undefined
  }
  return { tableSlug, entryId }
}

/**
 * Extract + validate the `?table=…&entry=…` entry reference all routes
 * require. Returns field errors (for a 400) when either is missing, empty,
 * or outside its charset (which also rules out `:` in either component).
 */
export function parseEntryRef(
  url: string,
): { ok: true; tableSlug: string; entryId: string } | { ok: false; errors: FieldError[] } {
  const params = parseQueryParams(url)
  const errors: FieldError[] = []
  const tableSlug = params.table ?? ''
  const entryId = params.entry ?? ''
  if (tableSlug === '') {
    errors.push({ field: 'table', message: 'required query parameter' })
  } else if (tableSlug.length > ENTRY_REF_COMPONENT_MAX) {
    errors.push({
      field: 'table',
      message: `must be at most ${ENTRY_REF_COMPONENT_MAX} characters`,
    })
  } else if (!TABLE_SLUG_RE.test(tableSlug)) {
    errors.push({
      field: 'table',
      message: 'must match [a-z0-9][a-z0-9_-]* (case-insensitive; ":" not allowed)',
    })
  }
  if (entryId === '') {
    errors.push({ field: 'entry', message: 'required query parameter' })
  } else if (entryId.length > ENTRY_REF_COMPONENT_MAX) {
    errors.push({
      field: 'entry',
      message: `must be at most ${ENTRY_REF_COMPONENT_MAX} characters`,
    })
  } else if (!ENTRY_ID_RE.test(entryId)) {
    errors.push({
      field: 'entry',
      message: 'must match [A-Za-z0-9_-]+ (":" not allowed)',
    })
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, tableSlug, entryId }
}

// ---------------------------------------------------------------------------
// Raw JSON body parsing — the host's parsed body is unusable for writes
// ---------------------------------------------------------------------------

/**
 * Parse a write route's raw body text. The pinned host leaves its
 * pre-parsed `ctx.body` as `{}` for malformed JSON, empty bodies, JSON
 * arrays/scalars, and non-JSON content types (vendor/Instatic
 * server/plugins/host/routeIo.ts:63-78) — indistinguishable from a real
 * empty object, so a truncated request would silently validate as "no
 * fields". Write handlers therefore parse the raw text themselves
 * (`req.text()`; the raw bytes always reach the sandbox, routeIo.ts:118-123)
 * and reject anything that isn't well-formed JSON.
 */
export function parseJsonBody(
  text: string,
): { ok: true; value: unknown } | { ok: false; errors: FieldError[] } {
  if (text.trim() === '') {
    return {
      ok: false,
      errors: [{ field: '', message: 'request body required (JSON object)' }],
    }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, errors: [{ field: '', message: 'malformed JSON body' }] }
  }
}

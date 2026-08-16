/**
 * seo-config storage logic (task 1.3) — pure validation, (de)serialization
 * and a memoized reader for the `seo-config` resource. No SDK imports (the
 * storage collection is injected structurally) so everything unit-tests
 * under plain `bun test` and bundles into the QuickJS sandbox unchanged.
 *
 * Storage model — same host constraints as seo-meta (flat scalar fields
 * only, no upsert/unique key, undeclared fields silently dropped —
 * resourceRecords.ts:31-62): the config document is split across records
 * keyed by a `key` data field:
 *
 *   key `site`           — site defaults: siteName, separator, siteUrl,
 *                          titleTemplate (default title template),
 *                          metaDescription (default description).
 *   key `table:<slug>`   — per-table config: titleTemplate. `<slug>` obeys
 *                          TABLE_SLUG_RE (colon-free), so the two key forms
 *                          can never collide (`site` contains no colon).
 *
 * Duplicate discipline (G10: storage has no unique-key constraint):
 * newest record per key wins on EVERY read, in memory only. Physical
 * cleanup of stale duplicates happens exclusively in the authenticated
 * /config route handlers via `healSeoConfigDuplicates` (capped per
 * request) — the publish-path filter never issues deletes.
 *
 * The reader memoizes in MODULE STATE with a short TTL: the plugin's
 * QuickJS VM persists across filter invocations (one VM per plugin,
 * created at load and reused — vendor/Instatic server/plugins/
 * pluginWorker.ts:61,129,342; one worker per plugin id, workerPool.ts:4),
 * so a full-site publish bake pays one config lookup per TTL window
 * instead of one per page. Config writes in THIS VM invalidate the cache
 * immediately (routes call `invalidateSeoConfigCache`); the TTL bounds
 * staleness for everything else (worker crash/restart starts clean).
 */

import { extractVariables } from './lib/templateEngine'
import { TITLE_TEMPLATE_VARS, normalizeSiteOrigin } from './metaBlock'
import {
  DESCRIPTION_MAX,
  TABLE_SLUG_RE,
  URL_MAX,
  isAbsoluteHttpUrl,
  isUrlLike,
  type FieldError,
} from './seoMeta'

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface SeoSiteDefaults {
  /** Site name — feeds `%site%` in title templates. */
  siteName?: string
  /** Separator — feeds `%sep%`; defaults to metaBlock's DEFAULT_SEPARATOR. */
  separator?: string
  /** Absolute site origin — base for absolutizing canonical / og:image. */
  siteUrl?: string
  /** Default title template (used when the table has none). */
  titleTemplate?: string
  /** Default meta description (used when the entry has none). */
  metaDescription?: string
}

export interface SeoTableConfig {
  /** Title template for entries of this table. */
  titleTemplate?: string
}

/**
 * IndexNow ADMIN config (task 2.2). Only the toggle lives here — absent =
 * enabled (read via `indexNowEnabled(config)`). Everything the SERVER
 * writes (the submission key, last-submission status) lives in the
 * separate `seo-state` collection (server/seoState.ts): POST /config is a
 * full replace and DELETE /config wipes this collection, so server-owned
 * state stored here would be destroyed by ordinary admin saves.
 */
export interface SeoIndexNowConfig {
  enabled?: boolean
}

/**
 * schema.org graph ADMIN config (task 2.3). `enabled` defaults ON —
 * only `false` is stored (read via `schemaEnabled(config)`, same
 * default-ON style as IndexNow). Publisher fields feed the
 * Organization/Person node in server/lib/schemaGraph.ts; the settings-UI
 * tab arrives next wave (server-side validation only for now).
 */
export interface SeoSchemaConfig {
  enabled?: boolean
  publisherKind?: 'organization' | 'person'
  publisherName?: string
  publisherLogoUrl?: string
  /** Absolute http(s) profile URLs (≤10) for the publisher's sameAs. */
  sameAs?: string[]
}

/**
 * First-party analytics ADMIN config (task 2.4). `enabled` defaults OFF —
 * analytics is data collection, so it is strictly OPT-IN (only `true` is
 * stored; absent = disabled — the OPPOSITE polarity of the indexNow /
 * schema toggles, read via `analyticsEnabled(config)`). The toggle gates
 * the baked config tag (spike G6: the tracker script itself is a static
 * manifest asset and always ships; without the config tag it no-ops) AND
 * the beacon ingest routes.
 */
export interface SeoAnalyticsConfig {
  enabled?: boolean
}

/**
 * Site-verification tokens (task 2.4), emitted as `<meta>` tags in the
 * seo block on every render:
 *
 *   google    → <meta name="google-site-verification" content="…">
 *   bing      → <meta name="msvalidate.01" content="…">
 *   pinterest → <meta name="p:domain_verify" content="…">
 *
 * Validation accepts either the bare token or a PASTED FULL META TAG
 * (services show the tag for copy-paste) — the tag is stripped down to
 * its `content` value before storage (`extractVerificationToken`).
 */
export interface SeoVerificationConfig {
  google?: string
  bing?: string
  pinterest?: string
}

export interface SeoConfigData {
  site?: SeoSiteDefaults
  tables?: Record<string, SeoTableConfig>
  indexNow?: SeoIndexNowConfig
  schema?: SeoSchemaConfig
  analytics?: SeoAnalyticsConfig
  verification?: SeoVerificationConfig
}

/** IndexNow defaults ON — absent/undefined `enabled` means enabled. */
export function indexNowEnabled(config: SeoConfigData): boolean {
  return config.indexNow?.enabled !== false
}

/** Schema graph defaults ON — absent/undefined `enabled` means enabled. */
export function schemaEnabled(config: SeoConfigData): boolean {
  return config.schema?.enabled !== false
}

/** Analytics defaults OFF (opt-in data collection) — only `true` enables. */
export function analyticsEnabled(config: SeoConfigData): boolean {
  return config.analytics?.enabled === true
}

export type SeoConfigValidation =
  | { ok: true; value: SeoConfigData }
  | { ok: false; errors: FieldError[] }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Manifest resource id — must match instatic-plugin.config.ts. */
export const SEO_CONFIG_RESOURCE_ID = 'seo-config'

/** Record key for the site-defaults record. */
export const SITE_CONFIG_KEY = 'site'

/** Record-key prefix for per-table records: `table:<tableSlug>`. */
export const TABLE_CONFIG_KEY_PREFIX = 'table:'

/**
 * Record key for the IndexNow toggle record (colon-free — cannot collide).
 * Pre-review builds also embedded server state (key/status) in this
 * record; server/seoState.ts lifts that legacy state out on first read.
 */
export const INDEXNOW_CONFIG_KEY = 'indexnow'

/** Record key for the schema.org config record (colon-free — no collision). */
export const SCHEMA_CONFIG_KEY = 'schema'

/** Record key for the analytics toggle record (task 2.4, colon-free). */
export const ANALYTICS_CONFIG_KEY = 'analytics'

/** Record key for the verification-tokens record (task 2.4, colon-free). */
export const VERIFICATION_CONFIG_KEY = 'verification'

export const SITE_NAME_MAX = 200
export const SEPARATOR_MAX = 20
export const TITLE_TEMPLATE_MAX = 300
export const PUBLISHER_NAME_MAX = 200
export const SAME_AS_MAX = 10
export const VERIFICATION_TOKEN_MAX = 200

/**
 * Flat record-data field ids, matching the `seo-config` resource
 * declaration in instatic-plugin.config.ts (plus the lookup `key`).
 */
export const SEO_CONFIG_FIELD_IDS = [
  'key',
  'siteName',
  'separator',
  'siteUrl',
  'titleTemplate',
  'metaDescription',
  'indexNowEnabled',
  'schemaEnabled',
  'publisherKind',
  'publisherName',
  'publisherLogoUrl',
  'sameAsJson',
  'analyticsEnabled',
  'verificationGoogle',
  'verificationBing',
  'verificationPinterest',
] as const

const SITE_KEYS = ['siteName', 'separator', 'siteUrl', 'titleTemplate', 'metaDescription'] as const
const TABLE_KEYS = ['titleTemplate'] as const
const INDEXNOW_KEYS = ['enabled'] as const
const SCHEMA_KEYS = [
  'enabled',
  'publisherKind',
  'publisherName',
  'publisherLogoUrl',
  'sameAs',
] as const
const PUBLISHER_KINDS = ['organization', 'person'] as const
const ANALYTICS_KEYS = ['enabled'] as const
const VERIFICATION_KEYS = ['google', 'bing', 'pinterest'] as const

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Same hardened plain-object check as seoMeta (prototype tricks rejected). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function checkBoundedString(
  errors: FieldError[],
  field: string,
  value: unknown,
  max: number,
): value is string {
  if (typeof value !== 'string') {
    errors.push({ field, message: 'must be a string' })
    return false
  }
  if (value.length > max) {
    errors.push({ field, message: `must be at most ${max} characters` })
    return false
  }
  return true
}

/**
 * Bounded string that is TRIMMED before storage (task 2.3, review round
 * 2 #2): the host trims every text field on write anyway
 * (`data[field.id] = value.trim()` — vendor src/core/plugins/
 * resourceRecords.ts:61), so an untrimmed validated value would diverge
 * from what actually stores (and a whitespace-only value would store as
 * '' and silently vanish). Validation therefore normalizes to the
 * trimmed value and rejects values that trim to nothing — the echoed
 * document always matches storage. Returns the trimmed string, or
 * undefined when an error was recorded. Callers pass only non-empty
 * inputs ('' is treated as absent upstream).
 */
function checkTrimmedString(
  errors: FieldError[],
  field: string,
  value: unknown,
  max: number,
): string | undefined {
  if (!checkBoundedString(errors, field, value, max)) return undefined
  const trimmed = (value as string).trim()
  if (trimmed === '') {
    errors.push({ field, message: 'must contain a non-whitespace character' })
    return undefined
  }
  return trimmed
}

/**
 * Validate a title template: bounded, trimmed (host trims on store —
 * see checkTrimmedString), and every `%var%` it references must be a
 * supported variable — a typo'd variable would otherwise silently render
 * as '' at publish time. Returns the trimmed template, or undefined when
 * an error was recorded.
 */
function checkTitleTemplate(
  errors: FieldError[],
  field: string,
  value: unknown,
): string | undefined {
  const trimmed = checkTrimmedString(errors, field, value, TITLE_TEMPLATE_MAX)
  if (trimmed === undefined) return undefined
  const allowed: readonly string[] = TITLE_TEMPLATE_VARS
  const unknown = extractVariables(trimmed).filter((name) => !allowed.includes(name))
  if (unknown.length > 0) {
    errors.push({
      field,
      message: `unknown template variable(s): ${unknown.join(', ')} (allowed: ${allowed
        .map((v) => `%${v}%`)
        .join(', ')})`,
    })
    return undefined
  }
  return trimmed
}

function validateSiteDefaults(input: unknown, errors: FieldError[]): SeoSiteDefaults | undefined {
  if (!isPlainObject(input)) {
    errors.push({ field: 'site', message: 'must be an object' })
    return undefined
  }
  for (const key of Object.keys(input)) {
    if (!(SITE_KEYS as readonly string[]).includes(key)) {
      errors.push({ field: `site.${key}`, message: 'unknown field' })
    }
  }
  const raw: Record<string, unknown> = { ...input }
  const site: SeoSiteDefaults = {}

  if (raw.siteName !== undefined && raw.siteName !== '') {
    const siteName = checkTrimmedString(errors, 'site.siteName', raw.siteName, SITE_NAME_MAX)
    if (siteName !== undefined) site.siteName = siteName
  }
  if (raw.separator !== undefined && raw.separator !== '') {
    const separator = checkTrimmedString(errors, 'site.separator', raw.separator, SEPARATOR_MAX)
    if (separator !== undefined) site.separator = separator
  }
  if (raw.siteUrl !== undefined && raw.siteUrl !== '') {
    if (checkBoundedString(errors, 'site.siteUrl', raw.siteUrl, URL_MAX)) {
      // Must be a BARE ORIGIN — it is the join base for relative
      // canonicals/og:images, so userinfo (`https://@/`), an empty host
      // (`https://:443/`), or any path/query (`https://example.com/base?x=1`
      // → malformed `…/base?x=1/about` joins) are rejected. A single
      // trailing slash is tolerated and normalized away on store; padding
      // is trimmed first (host trims text fields on write anyway).
      const origin = normalizeSiteOrigin((raw.siteUrl as string).trim())
      if (origin === undefined) {
        errors.push({
          field: 'site.siteUrl',
          message:
            'must be a bare http(s) origin — non-empty host, optional port, ' +
            'no userinfo, no path/query/fragment (e.g. https://example.com)',
        })
      } else {
        site.siteUrl = origin
      }
    }
  }
  if (raw.titleTemplate !== undefined && raw.titleTemplate !== '') {
    const template = checkTitleTemplate(errors, 'site.titleTemplate', raw.titleTemplate)
    if (template !== undefined) site.titleTemplate = template
  }
  if (raw.metaDescription !== undefined && raw.metaDescription !== '') {
    const description = checkTrimmedString(
      errors,
      'site.metaDescription',
      raw.metaDescription,
      DESCRIPTION_MAX,
    )
    if (description !== undefined) site.metaDescription = description
  }
  return Object.keys(site).length > 0 ? site : undefined
}

function validateTables(
  input: unknown,
  errors: FieldError[],
): Record<string, SeoTableConfig> | undefined {
  if (!isPlainObject(input)) {
    errors.push({ field: 'tables', message: 'must be an object keyed by table slug' })
    return undefined
  }
  const tables: Record<string, SeoTableConfig> = {}
  for (const slug of Object.keys(input)) {
    const field = `tables.${slug}`
    if (!TABLE_SLUG_RE.test(slug)) {
      errors.push({
        field,
        message: 'table slug must match [a-z0-9][a-z0-9_-]* (case-insensitive)',
      })
      continue
    }
    const value = (input as Record<string, unknown>)[slug]
    if (!isPlainObject(value)) {
      errors.push({ field, message: 'must be an object' })
      continue
    }
    for (const key of Object.keys(value)) {
      if (!(TABLE_KEYS as readonly string[]).includes(key)) {
        errors.push({ field: `${field}.${key}`, message: 'unknown field' })
      }
    }
    const table: SeoTableConfig = {}
    const template = (value as Record<string, unknown>).titleTemplate
    if (template !== undefined && template !== '') {
      const checked = checkTitleTemplate(errors, `${field}.titleTemplate`, template)
      if (checked !== undefined) table.titleTemplate = checked
    }
    if (Object.keys(table).length > 0) tables[slug] = table
  }
  return Object.keys(tables).length > 0 ? tables : undefined
}

/**
 * Validate the `indexNow` section — the toggle only. `enabled: true` is
 * normalized away (absent = enabled — see `indexNowEnabled`), so storage
 * round-trips stay exact and the record disappears when nothing
 * meaningful is set. Server-owned fields (`key`, status) were moved to
 * `seo-state` (review fix #9) and are rejected here as unknown.
 */
function validateIndexNow(input: unknown, errors: FieldError[]): SeoIndexNowConfig | undefined {
  if (!isPlainObject(input)) {
    errors.push({ field: 'indexNow', message: 'must be an object' })
    return undefined
  }
  for (const key of Object.keys(input)) {
    if (!(INDEXNOW_KEYS as readonly string[]).includes(key)) {
      errors.push({ field: `indexNow.${key}`, message: 'unknown field' })
    }
  }
  const raw: Record<string, unknown> = { ...input }
  const section: SeoIndexNowConfig = {}

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      errors.push({ field: 'indexNow.enabled', message: 'must be a boolean' })
    } else if (raw.enabled === false) {
      section.enabled = false
    }
  }
  return Object.keys(section).length > 0 ? section : undefined
}

/**
 * Validate the `schema` section (task 2.3). `enabled: true` is normalized
 * away (absent = enabled — see `schemaEnabled`), matching the indexNow
 * toggle discipline so storage round-trips stay exact. publisherLogoUrl
 * follows the SAME rules as per-entry ogImage (absolute http(s) URL or a
 * site-relative `/` path — `isUrlLike`); sameAs entries must be ABSOLUTE
 * http(s) URLs (a relative social-profile link is meaningless).
 */
function validateSchema(input: unknown, errors: FieldError[]): SeoSchemaConfig | undefined {
  if (!isPlainObject(input)) {
    errors.push({ field: 'schema', message: 'must be an object' })
    return undefined
  }
  for (const key of Object.keys(input)) {
    if (!(SCHEMA_KEYS as readonly string[]).includes(key)) {
      errors.push({ field: `schema.${key}`, message: 'unknown field' })
    }
  }
  const raw: Record<string, unknown> = { ...input }
  const section: SeoSchemaConfig = {}

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      errors.push({ field: 'schema.enabled', message: 'must be a boolean' })
    } else if (raw.enabled === false) {
      section.enabled = false
    }
  }
  if (raw.publisherKind !== undefined && raw.publisherKind !== '') {
    if (
      typeof raw.publisherKind !== 'string' ||
      !(PUBLISHER_KINDS as readonly string[]).includes(raw.publisherKind)
    ) {
      errors.push({
        field: 'schema.publisherKind',
        message: `must be one of: ${PUBLISHER_KINDS.join(', ')}`,
      })
    } else {
      section.publisherKind = raw.publisherKind as 'organization' | 'person'
    }
  }
  if (raw.publisherName !== undefined && raw.publisherName !== '') {
    const name = checkTrimmedString(
      errors,
      'schema.publisherName',
      raw.publisherName,
      PUBLISHER_NAME_MAX,
    )
    if (name !== undefined) section.publisherName = name
  }
  if (raw.publisherLogoUrl !== undefined && raw.publisherLogoUrl !== '') {
    const logo = checkTrimmedString(errors, 'schema.publisherLogoUrl', raw.publisherLogoUrl, URL_MAX)
    if (logo !== undefined) {
      if (!isUrlLike(logo)) {
        errors.push({
          field: 'schema.publisherLogoUrl',
          message: 'must be an absolute http(s) URL or a path starting with "/"',
        })
      } else {
        section.publisherLogoUrl = logo
      }
    }
  }
  if (raw.sameAs !== undefined) {
    if (!Array.isArray(raw.sameAs)) {
      errors.push({ field: 'schema.sameAs', message: 'must be an array of URLs' })
    } else if (raw.sameAs.length > SAME_AS_MAX) {
      errors.push({
        field: 'schema.sameAs',
        message: `must have at most ${SAME_AS_MAX} items`,
      })
    } else {
      const urls: string[] = []
      let itemsOk = true
      for (let i = 0; i < raw.sameAs.length; i++) {
        const item = raw.sameAs[i]
        const trimmed = typeof item === 'string' ? item.trim() : undefined
        if (
          trimmed === undefined ||
          trimmed.length > URL_MAX ||
          !isAbsoluteHttpUrl(trimmed)
        ) {
          errors.push({
            field: `schema.sameAs.${i}`,
            message: 'must be an absolute http(s) URL',
          })
          itemsOk = false
          continue
        }
        urls.push(trimmed)
      }
      // Empty array = absent (clearing sameAs is just omitting it).
      if (itemsOk && urls.length > 0) section.sameAs = urls
    }
  }
  return Object.keys(section).length > 0 ? section : undefined
}

/**
 * Validate the `analytics` section (task 2.4). Analytics defaults OFF, so
 * only `enabled: true` is stored (`enabled: false` is normalized away) —
 * the mirror image of the indexNow toggle's discipline: the record
 * disappears whenever the section carries only the default.
 */
function validateAnalytics(input: unknown, errors: FieldError[]): SeoAnalyticsConfig | undefined {
  if (!isPlainObject(input)) {
    errors.push({ field: 'analytics', message: 'must be an object' })
    return undefined
  }
  for (const key of Object.keys(input)) {
    if (!(ANALYTICS_KEYS as readonly string[]).includes(key)) {
      errors.push({ field: `analytics.${key}`, message: 'unknown field' })
    }
  }
  const raw: Record<string, unknown> = { ...input }
  const section: SeoAnalyticsConfig = {}

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      errors.push({ field: 'analytics.enabled', message: 'must be a boolean' })
    } else if (raw.enabled === true) {
      section.enabled = true
    }
  }
  return Object.keys(section).length > 0 ? section : undefined
}

/**
 * Normalize one verification input to its bare token. Accepts either the
 * token itself or a pasted full `<meta … content="…">` tag (what Google /
 * Bing / Pinterest show for copy-paste) — the tag is stripped down to its
 * `content` attribute value. Returns undefined when no usable token
 * remains; the token charset is conservative (no whitespace, quotes, or
 * angle brackets — it is emitted into a double-quoted attribute).
 */
export function extractVerificationToken(raw: string): string | undefined {
  let value = raw.trim()
  if (/^<meta\b/i.test(value)) {
    const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(value)
    if (content === null) return undefined
    value = (content[1] ?? content[2] ?? '').trim()
  }
  if (value === '' || value.length > VERIFICATION_TOKEN_MAX) return undefined
  if (!/^[^\s<>"'`]+$/.test(value)) return undefined
  return value
}

/**
 * Validate the `verification` section (task 2.4). Each field goes through
 * `extractVerificationToken` (bare token or pasted meta tag); an input
 * that yields no usable token is a field error, so a paste of the wrong
 * thing never silently stores garbage.
 */
function validateVerification(
  input: unknown,
  errors: FieldError[],
): SeoVerificationConfig | undefined {
  if (!isPlainObject(input)) {
    errors.push({ field: 'verification', message: 'must be an object' })
    return undefined
  }
  for (const key of Object.keys(input)) {
    if (!(VERIFICATION_KEYS as readonly string[]).includes(key)) {
      errors.push({ field: `verification.${key}`, message: 'unknown field' })
    }
  }
  const raw: Record<string, unknown> = { ...input }
  const section: SeoVerificationConfig = {}
  for (const field of VERIFICATION_KEYS) {
    const value = raw[field]
    if (value === undefined || value === '') continue
    if (typeof value !== 'string') {
      errors.push({ field: `verification.${field}`, message: 'must be a string' })
      continue
    }
    if (value.length > 2000) {
      errors.push({ field: `verification.${field}`, message: 'must be at most 2000 characters' })
      continue
    }
    const token = extractVerificationToken(value)
    if (token === undefined) {
      errors.push({
        field: `verification.${field}`,
        message: `must be a bare verification token (≤${VERIFICATION_TOKEN_MAX} chars, no spaces/quotes) or a pasted <meta> tag with a content attribute`,
      })
      continue
    }
    section[field] = token
  }
  return Object.keys(section).length > 0 ? section : undefined
}

/**
 * Validate an incoming full config document. Empty strings are treated as
 * absent (the host storage drops '' fields anyway); empty sub-objects are
 * dropped, so a round-trip through storage is exact.
 */
export function validateSeoConfig(input: unknown): SeoConfigValidation {
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ field: '', message: 'payload must be a JSON object' }] }
  }
  const errors: FieldError[] = []
  const value: SeoConfigData = {}

  for (const key of Object.keys(input)) {
    if (!(CONFIG_SECTION_KEYS as readonly string[]).includes(key)) {
      errors.push({ field: key, message: 'unknown field' })
    }
  }
  const raw: Record<string, unknown> = { ...input }
  if (raw.site !== undefined) {
    const site = validateSiteDefaults(raw.site, errors)
    if (site !== undefined) value.site = site
  }
  if (raw.tables !== undefined) {
    const tables = validateTables(raw.tables, errors)
    if (tables !== undefined) value.tables = tables
  }
  if (raw.indexNow !== undefined) {
    const indexNow = validateIndexNow(raw.indexNow, errors)
    if (indexNow !== undefined) value.indexNow = indexNow
  }
  if (raw.schema !== undefined) {
    const schema = validateSchema(raw.schema, errors)
    if (schema !== undefined) value.schema = schema
  }
  if (raw.analytics !== undefined) {
    const analytics = validateAnalytics(raw.analytics, errors)
    if (analytics !== undefined) value.analytics = analytics
  }
  if (raw.verification !== undefined) {
    const verification = validateVerification(raw.verification, errors)
    if (verification !== undefined) value.verification = verification
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value }
}

/** True when a validated config carries no data at all. */
export function isEmptySeoConfig(config: SeoConfigData): boolean {
  return CONFIG_SECTION_KEYS.every((key) => config[key] === undefined)
}

/**
 * The top-level config sections POST /config resolves independently
 * (presence-first semantics — see `resolveConfigSections`). Task 2.4 adds
 * `analytics` + `verification`; clients that predate a section can never
 * delete it (absent key = carry-forward).
 */
export const CONFIG_SECTION_KEYS = [
  'site',
  'tables',
  'indexNow',
  'schema',
  'analytics',
  'verification',
] as const

/**
 * Does the raw request body explicitly speak at least ONE config section?
 * A body with no section keys at all has nothing to say — the route 400s
 * it (clearing everything is DELETE /config's job).
 */
export function hasExplicitConfigSection(rawBody: unknown): boolean {
  if (!isPlainObject(rawBody)) return false
  return CONFIG_SECTION_KEYS.some((key) => key in rawBody)
}

/**
 * Presence-first section resolution for POST /config (task 2.3, review
 * round 2 blocker): each top-level section is replaced or kept based on
 * whether its key is PRESENT in the raw request body — not on whether
 * validation left a value for it:
 *
 *   - key PRESENT → the client speaks that section: the validated value
 *     replaces the stored one. A value validation normalized to
 *     undefined (`{}`, all-defaults like `{enabled:true}`) is an
 *     explicit CLEAR of that section.
 *   - key ABSENT → the stored section is carried forward verbatim, so a
 *     client built before a section existed (e.g. the pre-2.3 settings
 *     form and `schema`) can never silently delete it.
 *
 * Callers judge emptiness AFTER this resolution: a resolved document may
 * legitimately be fully empty when the body explicitly cleared the only
 * stored section. `rawBody` must be the PARSED but UNVALIDATED request
 * body — validation erases the absent-vs-present-empty distinction this
 * rule depends on.
 */
export function resolveConfigSections(
  rawBody: unknown,
  validated: SeoConfigData,
  existing: SeoConfigData,
): SeoConfigData {
  const resolved: SeoConfigData = {}
  for (const key of CONFIG_SECTION_KEYS) {
    const value =
      isPlainObject(rawBody) && key in rawBody ? validated[key] : existing[key]
    if (value !== undefined) (resolved as Record<string, unknown>)[key] = value
  }
  return resolved
}

// ---------------------------------------------------------------------------
// (De)serialization — config document <-> flat storage records
// ---------------------------------------------------------------------------

/**
 * Config → one flat record-data object per storage key. Records carrying
 * only `key` (no data) are not emitted.
 */
export function serializeSeoConfig(config: SeoConfigData): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  const site = config.site
  if (site !== undefined) {
    const data: Record<string, unknown> = { key: SITE_CONFIG_KEY }
    if (site.siteName) data.siteName = site.siteName
    if (site.separator) data.separator = site.separator
    if (site.siteUrl) data.siteUrl = site.siteUrl
    if (site.titleTemplate) data.titleTemplate = site.titleTemplate
    if (site.metaDescription) data.metaDescription = site.metaDescription
    if (Object.keys(data).length > 1) records.push(data)
  }
  for (const slug of Object.keys(config.tables ?? {})) {
    const table = config.tables![slug]!
    const data: Record<string, unknown> = { key: `${TABLE_CONFIG_KEY_PREFIX}${slug}` }
    if (table.titleTemplate) data.titleTemplate = table.titleTemplate
    if (Object.keys(data).length > 1) records.push(data)
  }
  // Only `enabled: false` is stored — absent means enabled (default ON).
  if (config.indexNow?.enabled === false) {
    records.push({ key: INDEXNOW_CONFIG_KEY, indexNowEnabled: false })
  }
  const schema = config.schema
  if (schema !== undefined) {
    const data: Record<string, unknown> = { key: SCHEMA_CONFIG_KEY }
    if (schema.enabled === false) data.schemaEnabled = false
    if (schema.publisherKind) data.publisherKind = schema.publisherKind
    if (schema.publisherName) data.publisherName = schema.publisherName
    if (schema.publisherLogoUrl) data.publisherLogoUrl = schema.publisherLogoUrl
    // Flat-scalar host constraint: the URL array rides as ONE JSON string.
    if (schema.sameAs && schema.sameAs.length > 0) data.sameAsJson = JSON.stringify(schema.sameAs)
    if (Object.keys(data).length > 1) records.push(data)
  }
  // Analytics defaults OFF — only `enabled: true` is stored (task 2.4).
  if (config.analytics?.enabled === true) {
    records.push({ key: ANALYTICS_CONFIG_KEY, analyticsEnabled: true })
  }
  const verification = config.verification
  if (verification !== undefined) {
    const data: Record<string, unknown> = { key: VERIFICATION_CONFIG_KEY }
    if (verification.google) data.verificationGoogle = verification.google
    if (verification.bing) data.verificationBing = verification.bing
    if (verification.pinterest) data.verificationPinterest = verification.pinterest
    if (Object.keys(data).length > 1) records.push(data)
  }
  return records
}

/**
 * Defensive JSON-string → sameAs parse for reads: only absolute-http(s),
 * in-bound, unique string items survive (a hand-edited record can never
 * produce a malformed section — same posture as deserializeSeoMeta).
 */
export function parseStoredSameAs(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const urls: string[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (typeof item !== 'string' || item.length > URL_MAX || !isAbsoluteHttpUrl(item)) continue
    if (seen.has(item)) continue
    seen.add(item)
    urls.push(item)
    if (urls.length >= SAME_AS_MAX) break
  }
  return urls.length > 0 ? urls : undefined
}

/**
 * Flat record datas → config document. Defensive like deserializeSeoMeta:
 * only well-typed non-empty fields survive, malformed keys/slugs are
 * skipped, first record wins per key (callers pass newest-first).
 */
export function deserializeSeoConfigRecords(
  datas: readonly Record<string, unknown>[],
): SeoConfigData {
  const config: SeoConfigData = {}
  const seen = new Set<string>()
  for (const data of datas) {
    const key = typeof data.key === 'string' ? data.key : ''
    if (key === '' || seen.has(key)) continue
    seen.add(key)

    if (key === SITE_CONFIG_KEY) {
      const site: SeoSiteDefaults = {}
      if (typeof data.siteName === 'string' && data.siteName !== '') site.siteName = data.siteName
      if (typeof data.separator === 'string' && data.separator !== '') {
        site.separator = data.separator
      }
      if (typeof data.siteUrl === 'string' && data.siteUrl !== '') site.siteUrl = data.siteUrl
      if (typeof data.titleTemplate === 'string' && data.titleTemplate !== '') {
        site.titleTemplate = data.titleTemplate
      }
      if (typeof data.metaDescription === 'string' && data.metaDescription !== '') {
        site.metaDescription = data.metaDescription
      }
      if (Object.keys(site).length > 0) config.site = site
      continue
    }

    if (key === INDEXNOW_CONFIG_KEY) {
      // Toggle only. Legacy embedded server state (indexNowKey/status
      // fields from pre-review builds) is IGNORED here — seoState.ts
      // lifts it into the seo-state collection on first read.
      if (data.indexNowEnabled === false) config.indexNow = { enabled: false }
      continue
    }

    if (key === SCHEMA_CONFIG_KEY) {
      const schema: SeoSchemaConfig = {}
      if (data.schemaEnabled === false) schema.enabled = false
      if (
        typeof data.publisherKind === 'string' &&
        (PUBLISHER_KINDS as readonly string[]).includes(data.publisherKind)
      ) {
        schema.publisherKind = data.publisherKind as 'organization' | 'person'
      }
      if (typeof data.publisherName === 'string' && data.publisherName !== '') {
        schema.publisherName = data.publisherName
      }
      if (
        typeof data.publisherLogoUrl === 'string' &&
        data.publisherLogoUrl !== '' &&
        isUrlLike(data.publisherLogoUrl)
      ) {
        schema.publisherLogoUrl = data.publisherLogoUrl
      }
      const sameAs = parseStoredSameAs(data.sameAsJson)
      if (sameAs !== undefined) schema.sameAs = sameAs
      if (Object.keys(schema).length > 0) config.schema = schema
      continue
    }

    if (key === ANALYTICS_CONFIG_KEY) {
      // Only `enabled: true` is meaningful — absent/false = disabled.
      if (data.analyticsEnabled === true) config.analytics = { enabled: true }
      continue
    }

    if (key === VERIFICATION_CONFIG_KEY) {
      const verification: SeoVerificationConfig = {}
      const fields = [
        ['google', 'verificationGoogle'],
        ['bing', 'verificationBing'],
        ['pinterest', 'verificationPinterest'],
      ] as const
      for (const [section, field] of fields) {
        const value = data[field]
        // Stored data is still storage data — re-extract at the read
        // boundary so a hand-edited record can never emit an unsafe token.
        if (typeof value === 'string' && value !== '') {
          const token = extractVerificationToken(value)
          if (token !== undefined) verification[section] = token
        }
      }
      if (Object.keys(verification).length > 0) config.verification = verification
      continue
    }

    if (key.startsWith(TABLE_CONFIG_KEY_PREFIX)) {
      const slug = key.slice(TABLE_CONFIG_KEY_PREFIX.length)
      if (!TABLE_SLUG_RE.test(slug)) continue
      const table: SeoTableConfig = {}
      if (typeof data.titleTemplate === 'string' && data.titleTemplate !== '') {
        table.titleTemplate = data.titleTemplate
      }
      if (Object.keys(table).length > 0) {
        config.tables = config.tables ?? {}
        config.tables[slug] = table
      }
    }
  }
  return config
}

// ---------------------------------------------------------------------------
// Memoized reader — structural collection interface, injectable in tests
// ---------------------------------------------------------------------------

export interface StoredRecordLike {
  id: string
  data: Record<string, unknown>
}

/** Structural subset of `api.cms.storage.collection(id)` the reader needs. */
export interface SeoConfigCollectionLike {
  list: (options?: { limit?: number }) => Promise<{ records: StoredRecordLike[] }>
  delete: (recordId: string) => Promise<unknown>
}

/**
 * Cache TTL. Within one publish bake the filter fires once per page in
 * quick succession — a few seconds of reuse removes almost every repeat
 * lookup while bounding staleness from writes this VM didn't see.
 */
export const SEO_CONFIG_CACHE_TTL_MS = 5_000

/**
 * The host's list cap (StorageListOptionsSchema: limit "capped at 1000").
 * A list returning exactly this many records may be truncated — full
 * document replaces and duplicate cleanup must refuse to run on a
 * possibly-partial view.
 */
export const HOST_LIST_LIMIT = 1000

/** Per-request cap on duplicate-cleanup deletions (publish-path safety). */
export const MAX_CLEANUP_DELETES = 25

/**
 * Cache + generation counter. Every invalidation bumps the generation;
 * an in-flight `loadSeoConfig` fill that STARTED before an invalidation
 * observes the mismatch and refuses to populate the cache — a slow read
 * racing a config write can never overwrite a newer invalidation
 * (G10-adjacent: plugin storage has no transactions, so a multi-record
 * POST is non-atomic; see the /config route comment for the residual
 * window).
 */
let cache: { config: SeoConfigData; expiresAt: number; generation: number } | null = null
let cacheGeneration = 0

/** Drop the memoized config — call BEFORE and AFTER any seo-config write. */
export function invalidateSeoConfigCache(): void {
  cacheGeneration++
  cache = null
}

/**
 * Group records by key, newest-first-wins. Records without a usable key
 * are ignored (never destroyed here). Relies on the host's default
 * `created_at desc` list order.
 */
function groupNewestByKey(records: readonly StoredRecordLike[]): {
  newestByKey: Map<string, StoredRecordLike>
  staleDuplicates: StoredRecordLike[]
} {
  const newestByKey = new Map<string, StoredRecordLike>()
  const staleDuplicates: StoredRecordLike[] = []
  for (const record of records) {
    const key = typeof record.data.key === 'string' ? record.data.key : ''
    if (key === '') continue
    if (newestByKey.has(key)) staleDuplicates.push(record)
    else newestByKey.set(key, record)
  }
  return { newestByKey, staleDuplicates }
}

/**
 * Load the config document — READ-ONLY and memoized. The publish filter
 * runs this on the hot path, so it never deletes anything: duplicate
 * records are resolved newest-wins in memory only. Actual cleanup lives
 * in `healSeoConfigDuplicates`, called from the authenticated /config
 * routes with a per-request cap.
 */
export async function loadSeoConfig(
  collection: SeoConfigCollectionLike,
  now: number = Date.now(),
): Promise<SeoConfigData> {
  if (cache !== null && now < cache.expiresAt) return cache.config

  const generation = cacheGeneration
  const { records } = await collection.list({ limit: HOST_LIST_LIMIT })
  const { newestByKey } = groupNewestByKey(records)
  const config = deserializeSeoConfigRecords([...newestByKey.values()].map((r) => r.data))
  if (generation === cacheGeneration) {
    cache = { config, expiresAt: now + SEO_CONFIG_CACHE_TTL_MS, generation }
  }
  return config
}

/**
 * Delete stale duplicate records (everything but the newest per key),
 * capped at `maxDeletes` per call — leftovers get the next request.
 * Never runs on a possibly-truncated view: a list at the host cap skips
 * cleanup entirely rather than half-running it. Returns deletions made.
 * Authenticated-route use only — never called from the publish filter.
 */
export async function healSeoConfigDuplicates(
  collection: SeoConfigCollectionLike,
  maxDeletes: number = MAX_CLEANUP_DELETES,
): Promise<number> {
  const { records } = await collection.list({ limit: HOST_LIST_LIMIT })
  if (records.length >= HOST_LIST_LIMIT) return 0
  const { staleDuplicates } = groupNewestByKey(records)
  let deleted = 0
  for (const record of staleDuplicates) {
    if (deleted >= maxDeletes) break
    await collection.delete(record.id)
    deleted++
  }
  return deleted
}

// ---------------------------------------------------------------------------
// Full-replace planning (POST /config) — pure, testable
// ---------------------------------------------------------------------------

export type SeoConfigReplacePlan =
  | {
      ok: true
      /** Newest existing record per desired key → update in place. */
      updates: Array<{ recordId: string; data: Record<string, unknown> }>
      /** Desired keys with no existing record → create. */
      creates: Array<Record<string, unknown>>
      /**
       * Record ids to delete: REQUIRED deletions (removed desired keys)
       * are always included; CLEANUP deletions (stale duplicates,
       * keyless garbage) are capped at `maxCleanupDeletes` — leftovers
       * are healed by later requests.
       */
      deletes: string[]
    }
  | {
      /** List returned at the host cap — the view may be truncated, so a
       *  full replace cannot be guaranteed. Perform NO writes. */
      ok: false
      reason: 'list-cap'
    }

/** Plan the POST /config full replace over a listed record snapshot. */
export function planSeoConfigReplace(
  records: readonly StoredRecordLike[],
  desired: readonly Record<string, unknown>[],
  maxCleanupDeletes: number = MAX_CLEANUP_DELETES,
): SeoConfigReplacePlan {
  if (records.length >= HOST_LIST_LIMIT) return { ok: false, reason: 'list-cap' }

  const desiredByKey = new Map(desired.map((data) => [data.key as string, data]))
  const updates: Array<{ recordId: string; data: Record<string, unknown> }> = []
  const requiredDeletes: string[] = []
  const cleanupDeletes: string[] = []
  const seen = new Set<string>()

  for (const record of records) {
    const key = typeof record.data.key === 'string' ? record.data.key : ''
    if (key === '') {
      cleanupDeletes.push(record.id) // keyless garbage
      continue
    }
    if (seen.has(key)) {
      cleanupDeletes.push(record.id) // stale duplicate
      continue
    }
    seen.add(key)
    const data = desiredByKey.get(key)
    if (data) updates.push({ recordId: record.id, data })
    else requiredDeletes.push(record.id) // key removed from the document
  }

  const creates = [...desiredByKey.entries()]
    .filter(([key]) => !seen.has(key))
    .map(([, data]) => data)

  return {
    ok: true,
    updates,
    creates,
    deletes: [...requiredDeletes, ...cleanupDeletes.slice(0, maxCleanupDeletes)],
  }
}

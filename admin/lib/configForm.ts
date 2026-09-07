/**
 * Settings-page form model (task 1.4) — pure config-document assembly,
 * client-side validation, server-error mapping, and DIRTY-MERGE save
 * planning for the admin app.
 *
 * Client validation is LITERALLY the server's: `validateSeoConfig`
 * (server/seoConfig.ts) runs on the assembled document, so unknown
 * `%vars%` in templates and non-bare-origin site URLs are rejected with
 * the same field errors the POST /config route would return. On top of
 * that, this module validates the parts only the FORM knows about —
 * per-table rows with blank/duplicate slugs, which cannot be represented
 * in a `SeoConfigData` document at all.
 *
 * Concurrency discipline (lost-update fix): POST /config is a FULL
 * REPLACE, so a save built from a stale in-memory document would clobber
 * another admin's concurrent edits. Saves therefore (1) refetch the
 * document, (2) apply ONLY the entries the user actually changed — per
 * site field, per table row (keyed by a stable row id) — onto that FRESH
 * document via `mergeDirtyConfig`, and (3) POST the merge. Undirty data
 * always survives; dirty entries are last-write-wins. The residual
 * fetch→POST window is accepted at this pin: the host storage API has no
 * revision/compare-and-set primitive (G10-adjacent).
 *
 * An empty merged document routes to DELETE (the server 400s empty POSTs
 * by design).
 */

import {
  CONFIG_SECTION_KEYS,
  indexNowEnabled,
  isEmptySeoConfig,
  schemaEnabled,
  validateSeoConfig,
  type SeoConfigData,
  type SeoSchemaConfig,
  type SeoSiteDefaults,
  type SeoTableConfig,
  type SeoVerificationConfig,
} from '../../server/seoConfig'
import { TABLE_SLUG_RE, type FieldError } from '../../server/seoMeta'
import { DEFAULT_SEPARATOR } from '../../server/metaBlock'
import { renderTemplate } from '../../server/lib/templateEngine'

// ---------------------------------------------------------------------------
// Form shape
// ---------------------------------------------------------------------------

/**
 * A per-table template row. `id` is a STABLE identity assigned when the
 * row enters the form (load order for stored rows, `nextRowId` for added
 * ones) — React keys, error maps, and dirty tracking all key on it, so
 * removing a row never re-attaches its neighbors' errors or dirtiness.
 */
export interface ConfigTableRow {
  id: number
  tableSlug: string
  titleTemplate: string
}

/** A publisher sameAs URL row (task 2.4 Schema tab) — stable id like table rows. */
export interface SameAsRow {
  id: number
  url: string
}

export interface ConfigFormState {
  siteName: string
  separator: string
  siteUrl: string
  metaDescription: string
  siteTitleTemplate: string
  /** IndexNow toggle (task 2.2) — true = enabled (the document default). */
  indexNowEnabled: boolean
  tableRows: ConfigTableRow[]
  /** Schema tab (task 2.4; server section shipped in 2.3). */
  schemaEnabled: boolean
  publisherKind: '' | 'organization' | 'person'
  publisherName: string
  publisherLogoUrl: string
  sameAsRows: SameAsRow[]
  /** Analytics toggle (task 2.4) — false = disabled (the document default). */
  analyticsEnabled: boolean
  /** Verification tokens (task 2.4) — bare token or pasted meta tag. */
  verificationGoogle: string
  verificationBing: string
  verificationPinterest: string
}

/** The site-level form fields, in display order. */
export const SITE_FORM_FIELDS = [
  'siteName',
  'separator',
  'siteUrl',
  'metaDescription',
  'siteTitleTemplate',
] as const

export type SiteFormField = (typeof SITE_FORM_FIELDS)[number]

/** Form field → `SeoSiteDefaults` document key. */
const SITE_FIELD_TO_CONFIG_KEY: Record<SiteFormField, keyof SeoSiteDefaults> = {
  siteName: 'siteName',
  separator: 'separator',
  siteUrl: 'siteUrl',
  metaDescription: 'metaDescription',
  siteTitleTemplate: 'titleTemplate',
}

export function emptyConfigForm(): ConfigFormState {
  return {
    siteName: '',
    separator: '',
    siteUrl: '',
    metaDescription: '',
    siteTitleTemplate: '',
    indexNowEnabled: true,
    tableRows: [],
    schemaEnabled: true,
    publisherKind: '',
    publisherName: '',
    publisherLogoUrl: '',
    sameAsRows: [],
    analyticsEnabled: false,
    verificationGoogle: '',
    verificationBing: '',
    verificationPinterest: '',
  }
}

/**
 * Stored /config document → form state. Rows are sorted by slug for a
 * stable UI and given ids 0..n-1 in that order (deterministic, so a
 * baseline captured from the same document shares the same ids).
 */
export function formFromConfig(config: SeoConfigData): ConfigFormState {
  const site = config.site ?? {}
  const tableRows = Object.keys(config.tables ?? {})
    .sort()
    .map((tableSlug, index) => ({
      id: index,
      tableSlug,
      titleTemplate: config.tables?.[tableSlug]?.titleTemplate ?? '',
    }))
  const schema = config.schema ?? {}
  const verification = config.verification ?? {}
  return {
    siteName: site.siteName ?? '',
    separator: site.separator ?? '',
    siteUrl: site.siteUrl ?? '',
    metaDescription: site.metaDescription ?? '',
    siteTitleTemplate: site.titleTemplate ?? '',
    indexNowEnabled: indexNowEnabled(config),
    tableRows,
    schemaEnabled: schemaEnabled(config),
    publisherKind: schema.publisherKind ?? '',
    publisherName: schema.publisherName ?? '',
    publisherLogoUrl: schema.publisherLogoUrl ?? '',
    sameAsRows: (schema.sameAs ?? []).map((url, index) => ({ id: index, url })),
    analyticsEnabled: config.analytics?.enabled === true,
    verificationGoogle: verification.google ?? '',
    verificationBing: verification.bing ?? '',
    verificationPinterest: verification.pinterest ?? '',
  }
}

/** Next unused row id for an added row (max existing + 1). */
export function nextRowId(rows: ReadonlyArray<{ id: number }>): number {
  return rows.reduce((max, row) => Math.max(max, row.id + 1), 0)
}

/**
 * A site field's DOCUMENT value from its form string, mirroring the
 * whitespace treatment `configFromForm` (and the server) apply: trimmed
 * for name/URL, raw-but-non-blank for separator/description/template.
 * `undefined` = the field is absent from the document.
 */
function siteValueFromForm(form: ConfigFormState, field: SiteFormField): string | undefined {
  const raw = form[field]
  if (raw.trim() === '') return undefined
  return field === 'siteName' || field === 'siteUrl' ? raw.trim() : raw
}

/**
 * Form state → full config document. Whitespace-only values are treated
 * as absent; rows whose slug OR template is blank contribute nothing (row
 * completeness is a form-level validation concern, handled in
 * `validateConfigForm` — a half-filled row cannot be represented in the
 * document). Later duplicate slugs are dropped (first row wins) so the
 * assembled document is always well-formed.
 */
export function configFromForm(form: ConfigFormState): SeoConfigData {
  const config: SeoConfigData = {}
  const site: SeoSiteDefaults = {}
  for (const field of SITE_FORM_FIELDS) {
    const value = siteValueFromForm(form, field)
    if (value !== undefined) site[SITE_FIELD_TO_CONFIG_KEY[field]] = value
  }
  if (Object.keys(site).length > 0) config.site = site

  const tables: Record<string, SeoTableConfig> = {}
  for (const row of form.tableRows) {
    const slug = row.tableSlug.trim()
    const template = row.titleTemplate.trim()
    if (slug === '' || template === '') continue
    if (tables[slug] !== undefined) continue // duplicate — first row wins
    tables[slug] = { titleTemplate: row.titleTemplate }
  }
  if (Object.keys(tables).length > 0) config.tables = tables

  config.indexNow = { enabled: form.indexNowEnabled }

  const schema = schemaFromForm(form)
  if (schema !== undefined) config.schema = schema

  // Analytics: only `enabled: true` is representable (opt-in default OFF).
  if (form.analyticsEnabled) config.analytics = { enabled: true }

  const verification = verificationFromForm(form)
  if (verification !== undefined) config.verification = verification

  return config
}

/** The `schema` section a form represents, or undefined when empty. */
function schemaFromForm(form: ConfigFormState): SeoSchemaConfig | undefined {
  const schema: SeoSchemaConfig = {}
  schema.enabled = form.schemaEnabled
  if (form.publisherKind !== '') schema.publisherKind = form.publisherKind
  if (form.publisherName.trim() !== '') schema.publisherName = form.publisherName.trim()
  if (form.publisherLogoUrl.trim() !== '') schema.publisherLogoUrl = form.publisherLogoUrl.trim()
  const sameAs = form.sameAsRows.map((row) => row.url.trim()).filter((url) => url !== '')
  if (sameAs.length > 0) schema.sameAs = sameAs
  return Object.keys(schema).length > 0 ? schema : undefined
}

/** The `verification` section a form represents, or undefined when empty. */
function verificationFromForm(form: ConfigFormState): SeoVerificationConfig | undefined {
  const verification: SeoVerificationConfig = {}
  if (form.verificationGoogle.trim() !== '') verification.google = form.verificationGoogle.trim()
  if (form.verificationBing.trim() !== '') verification.bing = form.verificationBing.trim()
  if (form.verificationPinterest.trim() !== '') {
    verification.pinterest = form.verificationPinterest.trim()
  }
  return Object.keys(verification).length > 0 ? verification : undefined
}

// ---------------------------------------------------------------------------
// Dirty tracking — what did THIS form actually change vs its baseline?
// ---------------------------------------------------------------------------

/** Site fields whose form text differs from the baseline form. */
export function dirtySiteFields(
  form: ConfigFormState,
  baseline: ConfigFormState,
): SiteFormField[] {
  return SITE_FORM_FIELDS.filter((field) => form[field] !== baseline[field])
}

interface RowChanges {
  /** Form rows that are new or textually changed vs their baseline row. */
  dirtyRows: ConfigTableRow[]
  /** Baseline rows whose id no longer exists in the form (user removed them). */
  removedRows: ConfigTableRow[]
}

function diffRows(form: ConfigFormState, baseline: ConfigFormState): RowChanges {
  const baselineById = new Map(baseline.tableRows.map((row) => [row.id, row]))
  const formIds = new Set(form.tableRows.map((row) => row.id))
  const dirtyRows = form.tableRows.filter((row) => {
    const base = baselineById.get(row.id)
    return (
      base === undefined ||
      base.tableSlug !== row.tableSlug ||
      base.titleTemplate !== row.titleTemplate
    )
  })
  const removedRows = baseline.tableRows.filter((row) => !formIds.has(row.id))
  return { dirtyRows, removedRows }
}

/** Schema-section scalar form fields (task 2.4 tab). */
const SCHEMA_FORM_FIELDS = [
  'schemaEnabled',
  'publisherKind',
  'publisherName',
  'publisherLogoUrl',
] as const
type SchemaFormField = (typeof SCHEMA_FORM_FIELDS)[number]

/** Verification form fields → document keys. */
const VERIFICATION_FORM_FIELDS = [
  ['verificationGoogle', 'google'],
  ['verificationBing', 'bing'],
  ['verificationPinterest', 'pinterest'],
] as const

function dirtySchemaFields(form: ConfigFormState, baseline: ConfigFormState): SchemaFormField[] {
  return SCHEMA_FORM_FIELDS.filter((field) => form[field] !== baseline[field])
}

/**
 * The sameAs LIST is one dirty unit: any row added, removed, or edited
 * makes the whole list dirty, and the merge replaces the fresh document's
 * list with this form's (per-URL merging of an ordered list would invent
 * orderings no one asked for).
 */
function sameAsDirty(form: ConfigFormState, baseline: ConfigFormState): boolean {
  const a = form.sameAsRows.map((row) => `${row.id}:${row.url}`)
  const b = baseline.sameAsRows.map((row) => `${row.id}:${row.url}`)
  return a.length !== b.length || a.some((entry, index) => entry !== b[index])
}

function dirtyVerificationFields(
  form: ConfigFormState,
  baseline: ConfigFormState,
): Array<(typeof VERIFICATION_FORM_FIELDS)[number]> {
  return VERIFICATION_FORM_FIELDS.filter(([field]) => form[field] !== baseline[field])
}

/** True when the form carries ANY change vs its baseline (drives Save). */
export function isConfigFormDirty(form: ConfigFormState, baseline: ConfigFormState): boolean {
  if (dirtySiteFields(form, baseline).length > 0) return true
  if (form.indexNowEnabled !== baseline.indexNowEnabled) return true
  if (form.analyticsEnabled !== baseline.analyticsEnabled) return true
  if (dirtySchemaFields(form, baseline).length > 0) return true
  if (sameAsDirty(form, baseline)) return true
  if (dirtyVerificationFields(form, baseline).length > 0) return true
  const { dirtyRows, removedRows } = diffRows(form, baseline)
  return dirtyRows.length > 0 || removedRows.length > 0
}

/**
 * The lost-update fix: apply ONLY this form's dirty entries onto a FRESH
 * document (refetched immediately before save).
 *
 *   - Undirty site fields / untouched rows: the fresh document's values
 *     survive verbatim — another admin's concurrent edits are preserved.
 *   - Dirty site fields: set (or remove, when blanked) on the fresh site
 *     record — last-write-wins on exactly those fields.
 *   - Dirty rows: a changed/new row writes `tables[slug]`; a rename also
 *     deletes the baseline slug's entry; a row blanked or removed deletes
 *     its (baseline) slug.
 *
 * Callers validate the form BEFORE merging (`validateConfigForm`), so
 * dirty rows here always carry a usable slug+template or are blank.
 */
export function mergeDirtyConfig(
  fresh: SeoConfigData,
  form: ConfigFormState,
  baseline: ConfigFormState,
): SeoConfigData {
  const site: SeoSiteDefaults = { ...(fresh.site ?? {}) }
  for (const field of dirtySiteFields(form, baseline)) {
    const key = SITE_FIELD_TO_CONFIG_KEY[field]
    const value = siteValueFromForm(form, field)
    if (value === undefined) delete site[key]
    else site[key] = value
  }

  const tables: Record<string, SeoTableConfig> = { ...(fresh.tables ?? {}) }
  const baselineById = new Map(baseline.tableRows.map((row) => [row.id, row]))
  const { dirtyRows, removedRows } = diffRows(form, baseline)

  for (const removed of removedRows) {
    const slug = removed.tableSlug.trim()
    if (slug !== '') delete tables[slug]
  }

  for (const row of dirtyRows) {
    const base = baselineById.get(row.id)
    const slug = row.tableSlug.trim()
    const template = row.titleTemplate.trim()
    // A rename (or blanking) removes the baseline slug's entry.
    if (base !== undefined) {
      const oldSlug = base.tableSlug.trim()
      if (oldSlug !== '' && oldSlug !== slug) delete tables[oldSlug]
    }
    if (slug === '' || template === '') {
      // Row blanked out — treat as removal of its (current) slug, if any.
      if (slug !== '') delete tables[slug]
      continue
    }
    tables[slug] = { titleTemplate: row.titleTemplate }
  }

  const merged: SeoConfigData = {}
  if (Object.keys(site).length > 0) merged.site = site
  if (Object.keys(tables).length > 0) merged.tables = tables
  // indexNow (task 2.2): the fresh document's section passes through
  // verbatim unless THIS form's toggle is dirty — the same lost-update
  // rule as every other field. (Server-owned IndexNow state — the key,
  // submission status — no longer lives in this document at all; it sits
  // in the separate seo-state collection, so a save can never destroy it.)
  let indexNow = fresh.indexNow
  if (form.indexNowEnabled !== baseline.indexNowEnabled) {
    indexNow = { enabled: form.indexNowEnabled }
  }
  if (indexNow !== undefined) merged.indexNow = indexNow

  // schema (task 2.4 tab; section semantics from 2.3): field-wise dirty
  // merge like the site section; the sameAs list is one dirty unit.
  // Accepted caveat (review B2#9): clearing name/logo/sameAs leaves an
  // inert publisherKind behind (the RangeTabs has no "none" state), so
  // the posted section is not literally `{}` — harmless: a publisher
  // node is only emitted when a NAME is present (metaBlock.buildSchemaTag).
  const schema: SeoSchemaConfig = { ...(fresh.schema ?? {}) }
  for (const field of dirtySchemaFields(form, baseline)) {
    if (field === 'schemaEnabled') {
      schema.enabled = form.schemaEnabled
    } else if (field === 'publisherKind') {
      if (form.publisherKind === '') delete schema.publisherKind
      else schema.publisherKind = form.publisherKind
    } else if (field === 'publisherName') {
      if (form.publisherName.trim() === '') delete schema.publisherName
      else schema.publisherName = form.publisherName.trim()
    } else {
      if (form.publisherLogoUrl.trim() === '') delete schema.publisherLogoUrl
      else schema.publisherLogoUrl = form.publisherLogoUrl.trim()
    }
  }
  if (sameAsDirty(form, baseline)) {
    const sameAs = form.sameAsRows.map((row) => row.url.trim()).filter((url) => url !== '')
    if (sameAs.length === 0) delete schema.sameAs
    else schema.sameAs = sameAs
  }
  if (Object.keys(schema).length > 0) merged.schema = schema

  // analytics (task 2.4): only `enabled: true` is representable.
  let analytics = fresh.analytics
  if (form.analyticsEnabled !== baseline.analyticsEnabled) {
    analytics = form.analyticsEnabled ? { enabled: true } : undefined
  }
  if (analytics !== undefined) merged.analytics = analytics

  // verification (task 2.4): field-wise dirty merge.
  const verification: SeoVerificationConfig = { ...(fresh.verification ?? {}) }
  for (const [field, key] of dirtyVerificationFields(form, baseline)) {
    const value = form[field].trim()
    if (value === '') delete verification[key]
    else verification[key] = value
  }
  if (Object.keys(verification).length > 0) merged.verification = verification

  return merged
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Per-row form errors, keyed by STABLE row id (never by position). */
export type RowErrors = Record<number, Partial<Record<'tableSlug' | 'titleTemplate', string>>>

/** Per-sameAs-row errors, keyed by STABLE row id (task 2.4 Schema tab). */
export type SameAsErrors = Record<number, string>

export interface ConfigValidation {
  ok: boolean
  /** Document assembled from the form (valid rows only). */
  config: SeoConfigData
  /** Document-level errors keyed by server field path (site.siteUrl, …). */
  fieldErrors: Record<string, string>
  /** Row-level errors keyed by row id. */
  rowErrors: RowErrors
  /** sameAs row errors keyed by row id. */
  sameAsErrors: SameAsErrors
}

/**
 * Validate the whole form: row completeness / slug charset / duplicates
 * first (form-only concerns), then the server's `validateSeoConfig` on
 * the assembled document. Mirrors POST /config exactly for everything a
 * document can express.
 */
export function validateConfigForm(form: ConfigFormState): ConfigValidation {
  const rowErrors: RowErrors = {}
  const seenSlugs = new Set<string>()
  for (const row of form.tableRows) {
    const slug = row.tableSlug.trim()
    const template = row.titleTemplate.trim()
    if (slug === '' && template === '') continue // fully blank row — ignored
    const errors: RowErrors[number] = {}
    if (slug === '') {
      errors.tableSlug = 'table slug required'
    } else if (!TABLE_SLUG_RE.test(slug)) {
      errors.tableSlug = 'must match [a-z0-9][a-z0-9_-]* (case-insensitive)'
    } else if (seenSlugs.has(slug)) {
      errors.tableSlug = 'duplicate table slug'
    } else {
      seenSlugs.add(slug)
    }
    if (template === '') {
      errors.titleTemplate = 'title template required (or remove the row)'
    }
    if (Object.keys(errors).length > 0) rowErrors[row.id] = errors
  }

  const assembled = configFromForm(form)
  const serverResult = validateSeoConfig(assembled)
  const fieldErrors: Record<string, string> = {}
  const sameAsErrors: SameAsErrors = {}
  if (!serverResult.ok) {
    mergeServerErrors(serverResult.errors, form, fieldErrors, rowErrors, sameAsErrors)
  }

  return {
    ok:
      Object.keys(fieldErrors).length === 0 &&
      Object.keys(rowErrors).length === 0 &&
      Object.keys(sameAsErrors).length === 0,
    // Prefer the server-validated value: it carries normalizations (e.g. a
    // tolerated trailing slash on siteUrl is stripped), so dirty-compares
    // against the stored document don't stick on cosmetic differences.
    config: serverResult.ok ? serverResult.value : assembled,
    fieldErrors,
    rowErrors,
    sameAsErrors,
  }
}

/**
 * Map server-shaped field errors (`site.siteUrl`,
 * `tables.<slug>.titleTemplate`, …) onto the form: table errors land on
 * the matching row's STABLE id (matched by trimmed slug, first match),
 * everything else keeps its field path. Also used verbatim for 400
 * responses from POST /config.
 */
export function mergeServerErrors(
  errors: readonly FieldError[],
  form: ConfigFormState,
  fieldErrors: Record<string, string>,
  rowErrors: RowErrors,
  sameAsErrors: SameAsErrors = {},
): void {
  // `schema.sameAs.N` indexes the ASSEMBLED list (blank rows skipped) —
  // build the parallel row-id list once so N maps back to the stable id.
  const sameAsRowIds = form.sameAsRows
    .filter((row) => row.url.trim() !== '')
    .map((row) => row.id)
  for (const error of errors) {
    const tableMatch = /^tables\.([^.]+)(?:\.titleTemplate)?$/.exec(error.field)
    if (tableMatch) {
      const slug = tableMatch[1]
      const row = form.tableRows.find((candidate) => candidate.tableSlug.trim() === slug)
      if (row !== undefined) {
        const entry = (rowErrors[row.id] ??= {})
        if (entry.titleTemplate === undefined) entry.titleTemplate = error.message
        continue
      }
    }
    const sameAsMatch = /^schema\.sameAs\.(\d+)$/.exec(error.field)
    if (sameAsMatch) {
      const rowId = sameAsRowIds[Number(sameAsMatch[1])]
      if (rowId !== undefined) {
        if (sameAsErrors[rowId] === undefined) sameAsErrors[rowId] = error.message
        continue
      }
    }
    if (fieldErrors[error.field] === undefined) fieldErrors[error.field] = error.message
  }
}

/** 400-response errors → the same form mapping as client validation. */
export function serverErrorsToForm(
  errors: readonly FieldError[],
  form: ConfigFormState,
): { fieldErrors: Record<string, string>; rowErrors: RowErrors; sameAsErrors: SameAsErrors } {
  const fieldErrors: Record<string, string> = {}
  const rowErrors: RowErrors = {}
  const sameAsErrors: SameAsErrors = {}
  mergeServerErrors(errors, form, fieldErrors, rowErrors, sameAsErrors)
  return { fieldErrors, rowErrors, sameAsErrors }
}

// ---------------------------------------------------------------------------
// Save planning + document equality
// ---------------------------------------------------------------------------

export type ConfigSavePlan =
  | { kind: 'post'; config: SeoConfigData; body: Record<string, unknown> }
  | { kind: 'delete' }

/**
 * The config sections THIS FORM actually models (review B2#2 blocker) —
 * a CLIENT-OWNED list, deliberately decoupled from the server's
 * CONFIG_SECTION_KEYS: iterating the server list would make a future
 * server-side section this form has no fields for get sent as `{}`
 * (= explicit clear under the 2.3 presence semantics) on every save,
 * silently wiping it. The form may only be authoritative for sections it
 * can display and edit.
 */
export const FORM_MODELED_SECTIONS = [
  'site',
  'tables',
  'indexNow',
  'schema',
  'analytics',
  'verification',
] as const satisfies ReadonlyArray<(typeof CONFIG_SECTION_KEYS)[number]>

/**
 * The POST /config request body, with every section THIS FORM MODELS
 * sent EXPLICITLY — absent modeled sections become `{}` (present-but-
 * empty); sections the form does not model are OMITTED entirely.
 *
 * Why (task 2.4, citing the 2.3 section semantics): POST /config resolves
 * each top-level section by PRESENCE — a key present in the raw body is
 * authoritative (`{}` = explicit clear), an ABSENT key carries the stored
 * section forward verbatim (server/seoConfig.ts resolveConfigSections).
 * This form merges its dirty fields onto a freshly-fetched document, so
 * the merged state IS the intended final state for every section it
 * models; omitting a modeled section that merged to empty would silently
 * RESURRECT the stored one (e.g. re-enabling IndexNow merges the section
 * away — absent would carry the stored `{enabled:false}` forward and the
 * toggle would never save). Unmodeled sections stay absent → server
 * carry-forward protects them (review B2#2).
 */
export function explicitSectionBody(config: SeoConfigData): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const key of FORM_MODELED_SECTIONS) {
    body[key] = config[key] ?? {}
  }
  return body
}

/**
 * Empty documents route to DELETE — the server 400s empty POSTs — but
 * ONLY when the freshly-fetched stored document contains no section this
 * form does not model (review B2#2): DELETE /config wipes EVERY record,
 * unmodeled sections included. When the fresh document carries an
 * unknown section, the clear is expressed as a POST of explicit empty
 * modeled sections instead, and server carry-forward keeps the rest.
 * `freshRaw` is the same raw /config response the merge ran over.
 */
export function planConfigSave(
  config: SeoConfigData,
  freshRaw?: Record<string, unknown>,
): ConfigSavePlan {
  if (!isEmptySeoConfig(config)) {
    return { kind: 'post', config, body: explicitSectionBody(config) }
  }
  const modeled: ReadonlyArray<string> = FORM_MODELED_SECTIONS
  const hasUnmodeledSection =
    freshRaw !== undefined && Object.keys(freshRaw).some((key) => !modeled.includes(key))
  return hasUnmodeledSection
    ? { kind: 'post', config, body: explicitSectionBody(config) }
    : { kind: 'delete' }
}

/** Structural equality over config documents. */
export function configEquals(a: SeoConfigData, b: SeoConfigData): boolean {
  return stableStringify(a) === stableStringify(b)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`
}

// ---------------------------------------------------------------------------
// Template live preview
// ---------------------------------------------------------------------------

/**
 * Sample variables used by the Titles tab's live template previews. These
 * are INVENTED placeholder values (there is no real entry on the settings
 * page) — the UI labels the rendered output as a sample for that reason.
 */
export function sampleTemplateVars(form: ConfigFormState): Record<string, string> {
  return {
    title: 'Sample Page',
    site: form.siteName.trim() !== '' ? form.siteName.trim() : 'My Site',
    sep: form.separator.trim() !== '' ? form.separator : DEFAULT_SEPARATOR,
    slug: 'sample-page',
  }
}

/**
 * Render a template with the sample vars for the live preview. An empty
 * template previews as ''. Rendering never throws — `renderTemplate` is
 * total over strings.
 */
export function previewTemplate(template: string, form: ConfigFormState): string {
  if (template.trim() === '') return ''
  return renderTemplate(template, sampleTemplateVars(form))
}

// ---------------------------------------------------------------------------
// Publish decoration failures (review 2026-08-15)
// ---------------------------------------------------------------------------

/**
 * GET /config rides a warning when a publish shipped a page with NO SEO
 * tags (the publish filter caught an error and passed the document
 * through untouched). Parsed defensively: a malformed warning must never
 * stop the settings page loading, and a zero count is NOT a warning.
 */
export interface DecorationFailureView {
  count: number
  lastAt?: string
  pages: string[]
}

export function parseDecorationFailures(body: unknown): DecorationFailureView | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const raw = (body as Record<string, unknown>).decorationFailures
  if (raw === null || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const count = value.count
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return undefined
  const pages = Array.isArray(value.pages)
    ? value.pages.filter((p): p is string => typeof p === 'string')
    : []
  return {
    count: Math.floor(count),
    ...(typeof value.lastAt === 'string' && value.lastAt !== '' ? { lastAt: value.lastAt } : {}),
    pages,
  }
}

/** GET /config warning for an IndexNow submission failure. */
export interface IndexNowFailureView {
  status: string
  lastAt?: string
}

export function parseIndexNowFailure(body: unknown): IndexNowFailureView | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const raw = (body as Record<string, unknown>).indexNowFailure
  if (raw === null || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.status !== 'string' || value.status === '') return undefined
  return {
    status: value.status,
    ...(typeof value.lastAt === 'string' && value.lastAt !== '' ? { lastAt: value.lastAt } : {}),
  }
}

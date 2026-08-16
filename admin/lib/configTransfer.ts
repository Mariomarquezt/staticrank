/**
 * Settings export/import (task 2.6) — pure document (de)serialization,
 * validation, and per-section diffing for the Settings-transfer tools on
 * the SEO Settings page. No React, no SDK imports.
 *
 * Export: the current modeled config document wrapped with a format
 * marker + plugin version, downloaded client-side as JSON.
 *
 * Import: validated through the SAME `validateSeoConfig` the server (and
 * the settings form) run, then saved through the modeled-sections POST
 * machinery — the request body carries EXACTLY the sections PRESENT in
 * the file (present = authoritative under the 2.3 presence semantics,
 * `{}` = explicit clear), so:
 *   - a PARTIAL file (say, only `site`) touches only that section;
 *   - unknown sections in the FILE are rejected with a clear error
 *     (this client may only write sections it models — FORM_MODELED_
 *     SECTIONS discipline, review B2#2);
 *   - unknown sections on the SERVER survive untouched (absent from the
 *     body → server carry-forward).
 */

import { validateSeoConfig, type SeoConfigData } from '../../server/seoConfig'
import type { FieldError } from '../../server/seoMeta'
import { FORM_MODELED_SECTIONS } from './configForm'

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Format marker — bump the @N suffix on breaking export-shape changes. */
export const CONFIG_EXPORT_FORMAT = 'monkeywebs.seo/config@1'

export const CONFIG_EXPORT_FILENAME = 'monkeywebs-seo-config.json'

export interface ConfigExportFile {
  _format: string
  _pluginVersion: string
  _exportedAt: string
  config: SeoConfigData
}

export function buildConfigExport(
  config: SeoConfigData,
  pluginVersion: string,
  exportedAt: string,
): ConfigExportFile {
  return {
    _format: CONFIG_EXPORT_FORMAT,
    _pluginVersion: pluginVersion,
    _exportedAt: exportedAt,
    config,
  }
}

export function serializeConfigExport(file: ConfigExportFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Import parsing + validation
// ---------------------------------------------------------------------------

/**
 * Import file size cap (review C#5) — checked against `File.size` BEFORE
 * the file is read into memory. A real export is a few KB; 1 MiB is
 * orders of magnitude of headroom and matches the host's own form-body
 * budget (spike G7).
 */
export const MAX_IMPORT_FILE_BYTES = 1024 * 1024

export function importFileTooLarge(sizeBytes: number): boolean {
  return sizeBytes > MAX_IMPORT_FILE_BYTES
}

export const IMPORT_FILE_TOO_LARGE_MESSAGE =
  'settings file is too large (over 1 MB) — this is not a settings export'

export type ModeledSection = (typeof FORM_MODELED_SECTIONS)[number]

export type ConfigImportResult =
  | {
      ok: true
      /** Server-validated (normalized) document — the values to save. */
      config: SeoConfigData
      /** Sections PRESENT in the file, in modeled order (may be empty-`{}`). */
      presentSections: ModeledSection[]
    }
  | { ok: false; errors: FieldError[] }

function importError(message: string): ConfigImportResult {
  return { ok: false, errors: [{ field: '', message }] }
}

/**
 * Parse + validate an import file's raw text. Failure modes each get a
 * distinct, actionable message: malformed JSON, a missing/wrong format
 * marker, a non-object `config`, unknown sections inside `config`, and
 * per-field validation errors from `validateSeoConfig` (identical to what
 * POST /config would return).
 */
export function parseConfigImport(raw: string): ConfigImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return importError('not a JSON file')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return importError('not a settings export (expected a JSON object)')
  }
  const file = parsed as Record<string, unknown>
  if (file._format !== CONFIG_EXPORT_FORMAT) {
    return importError(
      `not a recognized settings export — expected "_format": "${CONFIG_EXPORT_FORMAT}"`,
    )
  }
  const rawConfig = file.config
  if (rawConfig === null || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return importError('settings export carries no "config" object')
  }

  const modeled: ReadonlyArray<string> = FORM_MODELED_SECTIONS
  const unknown = Object.keys(rawConfig as Record<string, unknown>).filter(
    (key) => !modeled.includes(key),
  )
  if (unknown.length > 0) {
    return importError(
      `unknown section${unknown.length === 1 ? '' : 's'} in file: ${unknown.join(', ')} — this plugin version imports only: ${modeled.join(', ')}`,
    )
  }

  const validated = validateSeoConfig(rawConfig)
  if (!validated.ok) return { ok: false, errors: validated.errors }

  const presentKeys = new Set(Object.keys(rawConfig as Record<string, unknown>))
  const presentSections = FORM_MODELED_SECTIONS.filter((key) => presentKeys.has(key))
  if (presentSections.length === 0) {
    // POST /config rejects section-less bodies by design (clearing
    // everything is DELETE's job) — surface that up front.
    return importError('the file contains no settings sections — nothing to import')
  }
  return { ok: true, config: validated.value, presentSections }
}

// ---------------------------------------------------------------------------
// Per-section change preview
// ---------------------------------------------------------------------------

export type SectionChangeKind =
  /** Present in the file, differs from stored, stored was empty. */
  | 'added'
  /** Present in the file, differs from stored non-empty state. */
  | 'changed'
  /** Present-but-empty in the file, stored was non-empty → explicit clear. */
  | 'cleared'
  /** Present in the file, structurally equal to stored. */
  | 'unchanged'
  /** Absent from the file → the stored section is carried forward. */
  | 'kept'

export interface SectionChange {
  section: ModeledSection
  kind: SectionChangeKind
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

function sectionIsEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    (value !== null && typeof value === 'object' && Object.keys(value as object).length === 0)
  )
}

/**
 * What applying the import would do to each modeled section of the
 * CURRENT stored document. `current` should be the freshly-fetched GET
 * /config response (the same document the confirm-save races against).
 */
export function diffConfigImport(
  current: SeoConfigData,
  imported: SeoConfigData,
  presentSections: readonly ModeledSection[],
): SectionChange[] {
  const present = new Set<string>(presentSections)
  return FORM_MODELED_SECTIONS.map((section) => {
    if (!present.has(section)) return { section, kind: 'kept' as const }
    const fileValue = imported[section]
    const storedValue = current[section]
    if (stableStringify(fileValue ?? {}) === stableStringify(storedValue ?? {})) {
      return { section, kind: 'unchanged' as const }
    }
    if (sectionIsEmpty(fileValue)) return { section, kind: 'cleared' as const }
    if (sectionIsEmpty(storedValue)) return { section, kind: 'added' as const }
    return { section, kind: 'changed' as const }
  })
}

/** True when applying the import would change anything at all. */
export function importHasChanges(changes: readonly SectionChange[]): boolean {
  return changes.some((c) => c.kind !== 'kept' && c.kind !== 'unchanged')
}

// ---------------------------------------------------------------------------
// Save body
// ---------------------------------------------------------------------------

/**
 * The POST /config body applying an import: EXACTLY the file's present
 * sections, explicitly — present-but-empty stays `{}` (explicit clear);
 * absent sections are omitted so server carry-forward protects them
 * (including sections this client doesn't model at all).
 */
export function importSaveBody(
  config: SeoConfigData,
  presentSections: readonly ModeledSection[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const section of presentSections) {
    body[section] = config[section] ?? {}
  }
  return body
}

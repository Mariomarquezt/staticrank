/**
 * Editor-panel form model (task 1.5, extended by 2.5) — pure payload
 * building/diffing for the per-entry meta the panel edits (title + meta
 * description + focus keywords).
 *
 * The server's POST /meta is a FULL REPLACE (PUT semantics, see
 * server/index.ts route table), so a save must never send only the two
 * panel fields: `applyFormToMeta` grafts the edited fields onto the FULL
 * payload, preserving canonical / robots / og* / twitterCard set
 * elsewhere. Clearing everything routes through DELETE (the server 400s
 * an empty POST by design — clearing is DELETE's job).
 *
 * Concurrency discipline (lost-update fix): the payload the panel loaded
 * at mount time may be STALE — another admin can have changed e.g. the
 * canonical since. A graft onto the stale payload would silently revert
 * that change on save. Callers therefore REFETCH the entry's meta
 * immediately before saving and graft the panel-owned fields (title,
 * metaDescription, focusKeywords — `PANEL_META_FIELDS`) onto the FRESH
 * payload; same
 * for clearing (`planMetaClear` clears only the panel-owned fields, and
 * only DELETEs when the fresh record holds nothing else). The residual
 * fetch→POST window is accepted at this pin: the host storage API has no
 * revision/compare-and-set primitive (G10-adjacent).
 */

import { isEmptySeoMeta, type SeoMetaPayload } from '../../server/seoMeta'

/** The payload fields the editor panel owns (everything else passes through). */
export const PANEL_META_FIELDS = ['title', 'metaDescription', 'focusKeywords'] as const

/**
 * Free-tier keyword allowance — gated in the UI only (the server accepts
 * up to 10 per the meta contract; the engine itself is gating-free).
 */
export const FREE_KEYWORD_LIMIT = 1

export interface MetaFormState {
  title: string
  metaDescription: string
  /** Focus keywords as edited (raw strings; normalized on graft). */
  focusKeywords: string[]
}

/**
 * Server-contract normalization for the keyword list — MUST mirror the
 * server's validateSeoMeta dedupe exactly or a save round-trip re-dirties
 * the form: trimmed, non-empty, deduped on NFC-normalized + lowercased
 * compare keys (locale-independent `toLowerCase`), FIRST original kept as
 * the display value, order preserved. Index 0 is the free-tier keyword
 * the panel edits.
 */
export function normalizeKeywords(keywords: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of keywords) {
    const keyword = raw.trim()
    if (keyword === '') continue
    const key = keyword.normalize('NFC').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(keyword)
  }
  return out
}

/**
 * Free-tier SCORING slice, by SLOT: only the primary slot (index 0) is
 * ever scored. An empty primary scores nothing — Pro extras stored at
 * later indexes are NEVER compacted into the scored slot; they ride along
 * verbatim through the save graft (`applyFormToMeta`) instead.
 */
export function scoredFreeKeywords(focusKeywords: string[]): string[] {
  const primary = (focusKeywords[0] ?? '').trim()
  return primary === '' ? [] : [primary]
}

/** Stored payload → editable form strings (absent fields read as ''/[]). */
export function formFromMeta(meta: SeoMetaPayload): MetaFormState {
  return {
    title: meta.title ?? '',
    metaDescription: meta.metaDescription ?? '',
    focusKeywords: meta.focusKeywords === undefined ? [] : [...meta.focusKeywords],
  }
}

/**
 * Graft the form's fields onto the full stored payload. An empty (or
 * whitespace-only) form value removes the field — for keywords, a list
 * that normalizes to empty removes `focusKeywords` entirely (POST is a
 * full replace; the server stores no empty arrays). Everything the panel
 * does not edit passes through untouched.
 */
export function applyFormToMeta(existing: SeoMetaPayload, form: MetaFormState): SeoMetaPayload {
  const next: SeoMetaPayload = { ...existing }
  const title = form.title.trim() === '' ? undefined : form.title
  const metaDescription = form.metaDescription.trim() === '' ? undefined : form.metaDescription
  if (title === undefined) delete next.title
  else next.title = title
  if (metaDescription === undefined) delete next.metaDescription
  else next.metaDescription = metaDescription
  const focusKeywords = normalizeKeywords(form.focusKeywords)
  if (focusKeywords.length === 0) delete next.focusKeywords
  else next.focusKeywords = focusKeywords
  // robots may be an empty object on a defensive deserialize — normalize away.
  if (next.robots !== undefined && Object.keys(next.robots).length === 0) delete next.robots
  return next
}

/** Order-insensitive structural equality over payload fields. */
export function metaEquals(a: SeoMetaPayload, b: SeoMetaPayload): boolean {
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
// Save planning
// ---------------------------------------------------------------------------

export type MetaSavePlan =
  | { kind: 'noop' }
  | { kind: 'delete' }
  | { kind: 'post'; payload: SeoMetaPayload }

/**
 * Decide what the Save action must do. `fresh` MUST be a just-refetched
 * payload (see the module header's concurrency discipline):
 *   - graft equals the fresh payload → noop
 *   - all fields gone (panel fields cleared AND nothing else stored)
 *     → DELETE (server rejects empty POST bodies)
 *   - otherwise → POST the grafted full payload
 */
export function planMetaSave(fresh: SeoMetaPayload, form: MetaFormState): MetaSavePlan {
  const next = applyFormToMeta(fresh, form)
  if (metaEquals(next, fresh)) return { kind: 'noop' }
  if (isEmptySeoMeta(next)) return { kind: 'delete' }
  return { kind: 'post', payload: next }
}

/**
 * "Clear overrides" plan against a just-refetched payload: removes ONLY
 * the panel-owned fields (title, metaDescription, focusKeywords). Other
 * admins' fields (canonical, robots, og*, twitterCard) survive via a POST
 * of the remainder; DELETE fires only when the fresh record holds nothing
 * besides panel-owned fields; a record already free of them is a noop.
 */
export function planMetaClear(fresh: SeoMetaPayload): MetaSavePlan {
  return planMetaSave(fresh, { title: '', metaDescription: '', focusKeywords: [] })
}

/** True when the form differs from what is stored (drives Save enablement). */
export function isMetaDirty(existing: SeoMetaPayload, form: MetaFormState): boolean {
  return planMetaSave(existing, form).kind !== 'noop'
}

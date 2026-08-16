// server/redirects/types.ts — FREE build.
//
// Only the slug-move declarations live here. When a page is renamed the
// HOST mints the 301; this plugin merely notices (the publish.after hook
// sees the stored slug differ from the fresh one) and records it so the
// admin can show what changed. Nothing here manages redirect rules.

/** FREE storage resource: one append-only record per observed rename. */
export const SLUGMOVES_RESOURCE_ID = 'seo-slugmoves'

/** Flat record-data field ids (must match the manifest resource). */
export const SLUGMOVE_FIELD_IDS = [
  'key', // `move:<pageId>:<base36 time>`
  'pageId',
  'fromSlug',
  'toSlug',
  'at', // ISO
] as const

export interface SlugMoveRecord {
  key: string
  pageId: string
  fromSlug: string
  toSlug: string
  at: string
}

/** Retention cap — the publish.after path prunes the oldest beyond this
 * (25 deletes per pass; the host storage has no bulk delete). */
export const MAX_SLUGMOVE_RECORDS = 200

export interface PageviewInput {
  /** location.pathname ONLY — never the query string (review B2#4). */
  path: string
  referrer?: string
  pageOrigin: string
  innerWidth?: number
  siteId: string
}

/**
 * Reject beacons longer than this BEFORE any parse work (review B2#1).
 * The host buffers the ENTIRE anonymous request body before the plugin
 * route runs (`await request.arrayBuffer()` — vendor
 * server/plugins/host/routeIo.ts:59-61), so a flood of huge text/plain
 * POSTs reaches the sandbox whole; the only plugin-side defense is to
 * refuse the string without touching JSON.parse. A legitimate beacon is
 * well under 500 chars; 4096 leaves generous headroom. `raw.length`
 * counts UTF-16 units — a lower bound on bytes, which is exactly the
 * parse-work bound needed. Host-side ingress limiting is impossible at
 * this pin — upstream gap G16 (docs/SPIKES.md).
 */
export const MAX_BEACON_RAW_LENGTH = 4096

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g

export function buildPageviewPayload(input: PageviewInput): {
  t: 'pv'
  u: string
  r: string
  w: 'm' | 't' | 'd' | ''
  s: string
} {
  return {
    t: 'pv',
    // Privacy decision (review B2#4): pathname only. Query strings can
    // carry emails, tokens, and search terms — they never leave the page.
    u: input.path,
    r: referrerOrigin(input.referrer ?? '', input.pageOrigin),
    w: widthBucket(input.innerWidth),
    s: input.siteId,
  }
}

export function referrerOrigin(referrer: string, pageOrigin: string): string {
  try {
    const referrerUrl = new URL(referrer)
    const pageUrl = new URL(pageOrigin)

    if (!isHttpUrl(referrerUrl) || !isHttpUrl(pageUrl)) return ''
    if (referrerUrl.origin === pageUrl.origin) return ''
    return referrerUrl.origin
  } catch {
    return ''
  }
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

export function widthBucket(w: number | undefined): 'm' | 't' | 'd' | '' {
  if (typeof w !== 'number' || !Number.isFinite(w)) return ''
  if (w < 600) return 'm'
  if (w < 1024) return 't'
  return 'd'
}

function stripControlChars(value: unknown): string | null {
  return typeof value === 'string' ? value.replace(CONTROL_CHARS, '') : null
}

export function parseTrackerBeacon(raw: string): {
  t: string
  u: string
  r: string
  w: string
  s: string
} | null {
  // Length gate FIRST — no parse work on oversized anonymous bodies
  // (review B2#1; see MAX_BEACON_RAW_LENGTH).
  if (typeof raw !== 'string' || raw.length > MAX_BEACON_RAW_LENGTH) return null

  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const object = parsed as Record<string, unknown>
  const t = stripControlChars(object.t)
  const u = stripControlChars(object.u)
  const r = stripControlChars(object.r)
  const w = stripControlChars(object.w)
  const s = stripControlChars(object.s)

  if (t !== 'pv' || u === null || r === null || w === null || s === null) return null
  if (w !== '' && w !== 'm' && w !== 't' && w !== 'd') return null
  if (u.length > 2000 || r.length > 200 || s.length > 100) return null

  return { t, u, r, w, s }
}

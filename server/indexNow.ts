/**
 * IndexNow submission (task 2.2) — notify search engines of changed URLs.
 *
 * Protocol (indexnow.org): POST JSON `{ host, key, keyLocation, urlList }`
 * to `https://api.indexnow.org/indexnow`; 200/202 = accepted. The key is
 * proven by serving it as plain text from `keyLocation`, which IndexNow
 * allows anywhere on the submitting host — so the key is served from a
 * PUBLIC plugin runtime route (`…/runtime/indexnow-key.txt`), sidestepping
 * the no-root-files gap (G2) exactly like the sitemap.
 *
 * Network surface at pin 6b055cf78 (verified): the QuickJS sandbox gets a
 * gated `fetch()` polyfill (vendor server/plugins/quickjs/bootstrap/
 * fetch.ts) that bridges to a host-side fetch. Two host-enforced gates:
 * the `network.outbound` manifest permission (protocol/targets.ts:59
 * `'network.fetch': 'network.outbound'`) AND a hostname allowlist in the
 * manifest's `networkAllowedHosts` (fail-closed — host/network.ts:140-143;
 * schema src/core/plugin-sdk/types/manifest.ts:81-88). This plugin lists
 * exactly `api.indexnow.org`.
 *
 * Key generation — QuickJS has NO crypto.randomUUID / getRandomValues
 * (the crypto shim exposes only crypto.subtle digest/importKey/sign —
 * bootstrap/crypto.ts:5-6), so the key derives from Math.random + Date.
 * QUALITY CAVEAT: Math.random is not a CSPRNG. Acceptable here: the key
 * only authorizes URL submissions for THIS host — a guessed key lets an
 * attacker send spurious "this URL changed" pings for our own site,
 * nothing more. Operators can rotate via the authenticated DELETE
 * `indexnow-key.txt` route (a new one is generated on the next submission).
 *
 * Delivery discipline (review fix #8): the publish path NEVER performs
 * network I/O — `publish.after` only marks changed records `pending`
 * (durable: the flag lives on the seo-sitemap record, so queued URLs
 * survive a VM restart). ALL submission happens in the 15-minute
 * `seo-maintenance` schedule tick, which has its own fresh 5 s eval
 * budget: one POST of up to INDEXNOW_URLS_PER_POST URLs, aborted after
 * INDEXNOW_FETCH_TIMEOUT_MS; on success it clears exactly the submitted
 * records' flags (after re-verifying each record still matches the
 * submitted snapshot — a concurrent publish re-marks a page pending and
 * must not be un-marked, review fix #6). The ≥10 s throttle guard is kept
 * inside the tick as defense in depth against overlapping fires.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'

/** Manifest allowlist entry — must match instatic-plugin.config.ts. */
export const INDEXNOW_HOST = 'api.indexnow.org'

/** Public runtime route path serving the key file. */
export const INDEXNOW_KEY_ROUTE = '/indexnow-key.txt'

/** Generated key length (hex chars). IndexNow allows 8–128. */
export const INDEXNOW_KEY_LENGTH = 32

/** IndexNow key charset per protocol (a-zA-Z0-9 and dashes, 8–128 chars). */
export const INDEXNOW_KEY_RE = /^[A-Za-z0-9-]{8,128}$/

/** Min interval between flush POSTs from this VM. */
export const INDEXNOW_FLUSH_MIN_INTERVAL_MS = 10_000

/** Abort the POST after this long — stays inside the 5 s eval deadline. */
export const INDEXNOW_FETCH_TIMEOUT_MS = 3_000

/**
 * Max URLs per POST — ALIGNED with the pending-flag clear cap (review
 * fix #7): a flush submits exactly one batch of this size and clears
 * exactly the records it submitted; the remainder waits for the next
 * flush. The protocol itself allows 10k URLs per POST.
 */
export const INDEXNOW_URLS_PER_POST = 50

/** Pending-flag clears per successful flush — equals the submit batch. */
export const INDEXNOW_CLEAR_CAP = INDEXNOW_URLS_PER_POST

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/**
 * Generate a hex key from the provided entropy sources (injectable for
 * tests). See the module header for the Math.random quality caveat.
 */
export function generateIndexNowKey(
  random: () => number = Math.random,
  now: number = Date.now(),
): string {
  const hex = '0123456789abcdef'
  let key = ''
  // Fold the clock into the first chars so two VMs started with identical
  // PRNG state still diverge.
  let seed = now >>> 0
  for (let i = 0; i < INDEXNOW_KEY_LENGTH; i++) {
    const r = Math.floor(random() * 16) & 0xf
    const s = seed & 0xf
    seed = Math.floor(seed / 16)
    key += hex[(r ^ s) & 0xf]
  }
  return key
}

// ---------------------------------------------------------------------------
// Payload building — pure, testable
// ---------------------------------------------------------------------------

export interface IndexNowPayload {
  host: string
  key: string
  keyLocation: string
  urlList: string[]
}

/** `https://example.com:8443` → `example.com:8443`; undefined when malformed. */
export function hostFromOrigin(siteUrl: string): string | undefined {
  const match = /^https?:\/\/([^/]+)\/?$/i.exec(siteUrl)
  return match ? match[1] : undefined
}

/**
 * Build the submission payload, or undefined when it cannot be valid
 * (bad origin, invalid key, or no URLs). URLs not on the site origin are
 * dropped — IndexNow rejects cross-host lists wholesale.
 */
export function buildIndexNowPayload(
  siteUrl: string,
  key: string,
  keyLocation: string,
  urls: readonly string[],
): IndexNowPayload | undefined {
  const host = hostFromOrigin(siteUrl)
  if (host === undefined) return undefined
  if (!INDEXNOW_KEY_RE.test(key)) return undefined
  const prefix = `${siteUrl}/`
  const urlList = [...new Set(urls)]
    .filter((url) => url === siteUrl || url.startsWith(prefix))
    .slice(0, INDEXNOW_URLS_PER_POST)
  if (urlList.length === 0) return undefined
  return { host, key, keyLocation, urlList }
}

// ---------------------------------------------------------------------------
// Flush throttle — pure, testable
// ---------------------------------------------------------------------------

/** True when enough wall-clock has passed since the last flush attempt. */
export function shouldFlushIndexNow(
  lastFlushAt: number | undefined,
  now: number,
  minIntervalMs: number = INDEXNOW_FLUSH_MIN_INTERVAL_MS,
): boolean {
  return lastFlushAt === undefined || now - lastFlushAt >= minIntervalMs
}

// ---------------------------------------------------------------------------
// Submission — thin wrapper over the sandbox fetch, injectable for tests
// ---------------------------------------------------------------------------

export type FetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal?: unknown
  },
) => Promise<{ status: number; ok: boolean }>

export interface IndexNowSubmitResult {
  ok: boolean
  status?: number
  error?: string
}

/**
 * POST one payload. Aborts after `timeoutMs` when AbortController exists
 * in this runtime (the sandbox bootstrap provides it; guarded anyway so a
 * missing polyfill degrades to an un-aborted fetch, not a crash). Network
 * errors are captured, never thrown — callers log-and-continue.
 */
export async function submitIndexNow(
  fetchLike: FetchLike,
  payload: IndexNowPayload,
  timeoutMs: number = INDEXNOW_FETCH_TIMEOUT_MS,
): Promise<IndexNowSubmitResult> {
  let signal: unknown
  let cancelTimer: (() => void) | undefined
  try {
    const AC = (globalThis as Record<string, unknown>).AbortController as
      | (new () => { abort: () => void; signal: unknown })
      | undefined
    if (typeof AC === 'function' && typeof setTimeout === 'function') {
      const controller = new AC()
      signal = controller.signal
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      cancelTimer = () => clearTimeout(timer as never)
    }
  } catch {
    // no abort support — proceed without a timeout
  }
  try {
    const res = await fetchLike(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal,
    })
    // Per protocol: 200 OK, 202 Accepted. Anything else is a failure the
    // status record surfaces for the (future) UI.
    return res.status === 200 || res.status === 202
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, error: `unexpected status ${res.status}` }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error && err.message !== '' ? err.message : 'network error',
    }
  } finally {
    if (cancelTimer) cancelTimer()
  }
}

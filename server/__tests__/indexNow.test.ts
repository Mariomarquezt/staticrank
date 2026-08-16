import { describe, expect, test } from 'bun:test'
import {
  INDEXNOW_ENDPOINT,
  INDEXNOW_FLUSH_MIN_INTERVAL_MS,
  INDEXNOW_KEY_LENGTH,
  INDEXNOW_KEY_RE,
  INDEXNOW_URLS_PER_POST,
  buildIndexNowPayload,
  generateIndexNowKey,
  hostFromOrigin,
  shouldFlushIndexNow,
  submitIndexNow,
  type FetchLike,
} from '../indexNow'

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

describe('generateIndexNowKey', () => {
  test('produces a protocol-valid hex key of the configured length', () => {
    const key = generateIndexNowKey()
    expect(key).toHaveLength(INDEXNOW_KEY_LENGTH)
    expect(key).toMatch(/^[0-9a-f]+$/)
    expect(INDEXNOW_KEY_RE.test(key)).toBe(true)
  })

  test('different entropy → different keys; deterministic with fixed inputs', () => {
    const a = generateIndexNowKey(() => 0.1, 1000)
    const b = generateIndexNowKey(() => 0.9, 1000)
    expect(a).not.toBe(b)
    expect(generateIndexNowKey(() => 0.1, 1000)).toBe(a)
  })

  test('same PRNG, different clocks → different keys', () => {
    const a = generateIndexNowKey(() => 0.5, 1111)
    const b = generateIndexNowKey(() => 0.5, 987654321)
    expect(a).not.toBe(b)
  })
})

describe('INDEXNOW_KEY_RE', () => {
  test('accepts 8-128 chars of the protocol charset, rejects the rest', () => {
    expect(INDEXNOW_KEY_RE.test('abcd1234')).toBe(true)
    expect(INDEXNOW_KEY_RE.test('a-B-3-'.repeat(5))).toBe(true)
    expect(INDEXNOW_KEY_RE.test('short')).toBe(false)
    expect(INDEXNOW_KEY_RE.test('x'.repeat(129))).toBe(false)
    expect(INDEXNOW_KEY_RE.test('has space')).toBe(false)
    expect(INDEXNOW_KEY_RE.test('under_score')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Payload building
// ---------------------------------------------------------------------------

describe('hostFromOrigin', () => {
  test('extracts host (and port) from a bare origin', () => {
    expect(hostFromOrigin('https://example.com')).toBe('example.com')
    expect(hostFromOrigin('https://example.com/')).toBe('example.com')
    expect(hostFromOrigin('http://example.com:8443')).toBe('example.com:8443')
  })

  test('rejects non-origins', () => {
    expect(hostFromOrigin('example.com')).toBeUndefined()
    expect(hostFromOrigin('https://example.com/path')).toBeUndefined()
    expect(hostFromOrigin('ftp://example.com')).toBeUndefined()
  })
})

describe('buildIndexNowPayload', () => {
  const SITE = 'https://example.com'
  const KEY = 'abcd1234abcd1234'
  const KEY_LOC = `${SITE}/admin/api/cms/plugins/monkeywebs.seo/runtime/indexnow-key.txt`

  test('builds the protocol payload', () => {
    const payload = buildIndexNowPayload(SITE, KEY, KEY_LOC, [`${SITE}/`, `${SITE}/about`])
    expect(payload).toEqual({
      host: 'example.com',
      key: KEY,
      keyLocation: KEY_LOC,
      urlList: [`${SITE}/`, `${SITE}/about`],
    })
  })

  test('drops cross-host URLs and dedupes', () => {
    const payload = buildIndexNowPayload(SITE, KEY, KEY_LOC, [
      `${SITE}/a`,
      `${SITE}/a`,
      'https://evil.example.org/a',
    ])
    expect(payload?.urlList).toEqual([`${SITE}/a`])
  })

  test('undefined for invalid key, malformed origin, or empty URL list', () => {
    expect(buildIndexNowPayload(SITE, 'nope', KEY_LOC, [`${SITE}/a`])).toBeUndefined()
    expect(buildIndexNowPayload('example.com', KEY, KEY_LOC, [`${SITE}/a`])).toBeUndefined()
    expect(buildIndexNowPayload(SITE, KEY, KEY_LOC, [])).toBeUndefined()
    expect(buildIndexNowPayload(SITE, KEY, KEY_LOC, ['https://other.com/x'])).toBeUndefined()
  })

  test('caps the URL list per POST', () => {
    const urls = []
    for (let i = 0; i < INDEXNOW_URLS_PER_POST + 20; i++) urls.push(`${SITE}/page-${i}`)
    const payload = buildIndexNowPayload(SITE, KEY, KEY_LOC, urls)
    expect(payload?.urlList).toHaveLength(INDEXNOW_URLS_PER_POST)
  })
})

// ---------------------------------------------------------------------------
// Flush throttle
// ---------------------------------------------------------------------------

describe('shouldFlushIndexNow', () => {
  test('first flush always allowed', () => {
    expect(shouldFlushIndexNow(undefined, 0)).toBe(true)
  })

  test('throttles inside the window, allows at/after it', () => {
    expect(shouldFlushIndexNow(1000, 1000 + INDEXNOW_FLUSH_MIN_INTERVAL_MS - 1)).toBe(false)
    expect(shouldFlushIndexNow(1000, 1000 + INDEXNOW_FLUSH_MIN_INTERVAL_MS)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

const PAYLOAD = {
  host: 'example.com',
  key: 'abcd1234abcd1234',
  keyLocation: 'https://example.com/key.txt',
  urlList: ['https://example.com/'],
}

describe('submitIndexNow', () => {
  test('POSTs the JSON payload to the IndexNow endpoint', async () => {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = []
    const fetchLike: FetchLike = async (url, init) => {
      calls.push({ url, init })
      return { status: 200, ok: true }
    }
    const result = await submitIndexNow(fetchLike, PAYLOAD)
    expect(result).toEqual({ ok: true, status: 200 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(INDEXNOW_ENDPOINT)
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(JSON.parse(calls[0]!.init.body)).toEqual(PAYLOAD)
  })

  test('202 counts as accepted', async () => {
    const result = await submitIndexNow(async () => ({ status: 202, ok: true }), PAYLOAD)
    expect(result).toEqual({ ok: true, status: 202 })
  })

  test('non-2xx statuses are failures with the status preserved', async () => {
    const result = await submitIndexNow(async () => ({ status: 429, ok: false }), PAYLOAD)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(429)
  })

  test('network errors are captured, never thrown', async () => {
    const result = await submitIndexNow(async () => {
      throw new Error('boom')
    }, PAYLOAD)
    expect(result).toEqual({ ok: false, error: 'boom' })
  })
})

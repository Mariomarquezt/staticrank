import { describe, expect, test } from 'bun:test'
import {
  MAX_BEACON_RAW_LENGTH,
  buildPageviewPayload,
  parseTrackerBeacon,
  referrerOrigin,
  widthBucket,
} from '../trackerPayload'

describe('buildPageviewPayload', () => {
  test('composes the pageview fields from page context — pathname only', () => {
    expect(
      buildPageviewPayload({
        path: '/guides/intro',
        referrer: 'https://search.example/results?q=seo',
        pageOrigin: 'https://site.example',
        innerWidth: 1023,
        siteId: 'site-42',
      }),
    ).toEqual({
      t: 'pv',
      // Review B2#4: `u` is location.pathname ONLY — query strings can
      // carry emails/tokens/search terms and never leave the page.
      u: '/guides/intro',
      r: 'https://search.example',
      w: 't',
      s: 'site-42',
    })
  })
})

describe('referrerOrigin', () => {
  test('omits a same-origin referrer', () => {
    expect(referrerOrigin('https://site.example/private/page', 'https://site.example')).toBe('')
  })

  test('strips a cross-origin referrer to its origin', () => {
    expect(referrerOrigin('https://other.example/path?secret=1#fragment', 'https://site.example')).toBe(
      'https://other.example',
    )
  })

  test('rejects non-http(s) referrers', () => {
    expect(referrerOrigin('javascript:alert(1)', 'https://site.example')).toBe('')
    expect(referrerOrigin('data:text/plain,hello', 'https://site.example')).toBe('')
    expect(referrerOrigin('mailto:user@example.com', 'https://site.example')).toBe('')
  })

  test('handles malformed URLs, case, and ports', () => {
    expect(referrerOrigin('not a URL', 'https://site.example')).toBe('')
    expect(referrerOrigin('https://SITE.EXAMPLE:443/private', 'https://site.example/')).toBe('')
    expect(referrerOrigin('https://site.example:8443/private', 'https://site.example')).toBe(
      'https://site.example:8443',
    )
  })
})

describe('widthBucket', () => {
  test('maps mobile, tablet, desktop, and unknown widths', () => {
    expect(widthBucket(599)).toBe('m')
    expect(widthBucket(600)).toBe('t')
    expect(widthBucket(1023)).toBe('t')
    expect(widthBucket(1024)).toBe('d')
    expect(widthBucket(undefined)).toBe('')
  })
})

describe('parseTrackerBeacon', () => {
  const payload = buildPageviewPayload({
    path: '/about',
    referrer: 'https://referrer.example/path',
    pageOrigin: 'https://site.example',
    innerWidth: 1200,
    siteId: 'site-42',
  })

  test('parses a valid beacon emitted from the pageview builder', () => {
    expect(parseTrackerBeacon(JSON.stringify(payload))).toEqual(payload)
  })

  test('returns null for malformed JSON and non-objects', () => {
    expect(parseTrackerBeacon('{')).toBeNull()
    expect(parseTrackerBeacon('null')).toBeNull()
    expect(parseTrackerBeacon('[]')).toBeNull()
  })

  test('returns null when the event type is not a pageview', () => {
    expect(parseTrackerBeacon(JSON.stringify({ ...payload, t: 'event' }))).toBeNull()
  })

  test('returns null for oversized URL, referrer, or site fields', () => {
    expect(parseTrackerBeacon(JSON.stringify({ ...payload, u: 'u'.repeat(2001) }))).toBeNull()
    expect(parseTrackerBeacon(JSON.stringify({ ...payload, r: 'r'.repeat(201) }))).toBeNull()
    expect(parseTrackerBeacon(JSON.stringify({ ...payload, s: 's'.repeat(101) }))).toBeNull()
  })

  test('rejects oversized raw bodies BEFORE parsing (review B2#1)', () => {
    // At the cap: parse proceeds (padding keeps it valid JSON).
    const atCap = `${JSON.stringify(payload)}${' '.repeat(MAX_BEACON_RAW_LENGTH)}`.slice(
      0,
      MAX_BEACON_RAW_LENGTH,
    )
    expect(parseTrackerBeacon(atCap)).toEqual(payload)
    // One char over: rejected without parse work — even though the
    // content would be perfectly valid JSON.
    const overCap = `${JSON.stringify(payload)}${' '.repeat(MAX_BEACON_RAW_LENGTH)}`.slice(
      0,
      MAX_BEACON_RAW_LENGTH + 1,
    )
    expect(parseTrackerBeacon(overCap)).toBeNull()
    // Garbage of huge size is likewise refused cheaply.
    expect(parseTrackerBeacon('x'.repeat(1_000_000))).toBeNull()
  })

  test('strips control characters from accepted string fields', () => {
    expect(
      parseTrackerBeacon(
        JSON.stringify({ t: 'p\u0000v', u: '/a\u0000b\u001f', r: 'https://ref.example\n', w: 'm', s: 'site\u007f42' }),
      ),
    ).toEqual({ t: 'pv', u: '/ab', r: 'https://ref.example', w: 'm', s: 'site42' })
  })
})

// ---------------------------------------------------------------------------
// Browser ↔ server parity (review B2#5): execute the VERBATIM IIFE from
// assets/tracker.js in a mocked-window context (test-only — plain
// function eval with stubbed window/navigator/document/location) and
// assert the JSON it sends equals buildPageviewPayload's output.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { describe as describeParity, expect as expectParity, test as testParity } from 'bun:test'

const TRACKER_SRC = readFileSync(
  new URL('../../../assets/tracker.js', import.meta.url),
  'utf8',
)

interface TrackerEnv {
  config?: unknown
  pathname: string
  search?: string
  origin: string
  referrer?: string
  innerWidth?: number
  nav?: Record<string, unknown>
  winDoNotTrack?: unknown
}

const CONFIG = {
  endpoint: '/admin/api/cms/plugins/monkeywebs.seo/runtime/beacon',
  siteId: 'site-42',
  enabled: true,
}

/** Run the tracker IIFE against a stubbed window; returns captured sends. */
function runTracker(env: TrackerEnv): Array<{ endpoint: string; body: string }> {
  const sends: Array<{ endpoint: string; body: string }> = []
  const win: Record<string, unknown> = {
    __mwSeoAnalytics: env.config === undefined ? CONFIG : env.config,
    navigator: {
      sendBeacon: (endpoint: string, body: string) => {
        sends.push({ endpoint, body })
        return true
      },
      ...(env.nav ?? {}),
    },
    document: {
      readyState: 'complete',
      referrer: env.referrer ?? '',
      addEventListener: () => {},
    },
    location: {
      pathname: env.pathname,
      search: env.search ?? '',
      origin: env.origin,
    },
    innerWidth: env.innerWidth,
  }
  if (env.winDoNotTrack !== undefined) win.doNotTrack = env.winDoNotTrack
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- test-only
  const run = new Function('window', TRACKER_SRC)
  run(win)
  return sends
}

describeParity('assets/tracker.js ↔ trackerPayload parity', () => {
  const scenarios = [
    {
      label: 'mobile, same-origin referrer',
      env: {
        pathname: '/blog/post-1',
        search: '?utm=x',
        origin: 'https://site.example',
        referrer: 'https://site.example/blog',
        innerWidth: 400,
      },
    },
    {
      label: 'tablet, cross-origin referrer',
      env: {
        pathname: '/about',
        origin: 'https://site.example',
        referrer: 'https://search.example/results?q=seo',
        innerWidth: 800,
      },
    },
    {
      label: 'desktop, no referrer, query string present',
      env: {
        pathname: '/pricing',
        search: '?email=leak@example.com',
        origin: 'https://site.example',
        innerWidth: 1440,
      },
    },
  ] as const

  for (const scenario of scenarios) {
    testParity(`browser payload equals buildPageviewPayload — ${scenario.label}`, () => {
      const sends = runTracker(scenario.env)
      expectParity(sends.length).toBe(1)
      expectParity(sends[0]!.endpoint).toBe(CONFIG.endpoint)
      const browserPayload: unknown = JSON.parse(sends[0]!.body)
      const serverPayload = buildPageviewPayload({
        path: scenario.env.pathname,
        referrer: 'referrer' in scenario.env ? scenario.env.referrer : undefined,
        pageOrigin: scenario.env.origin,
        innerWidth: scenario.env.innerWidth,
        siteId: CONFIG.siteId,
      })
      expectParity(browserPayload).toEqual(serverPayload)
      // The server-side validator accepts the browser's exact bytes.
      expectParity(parseTrackerBeacon(sends[0]!.body)).toEqual(serverPayload)
      // Privacy (review B2#4): the query string never leaves the page.
      expectParity(sends[0]!.body.includes('utm')).toBe(false)
      expectParity(sends[0]!.body.includes('leak@example.com')).toBe(false)
    })
  }

  testParity('DNT/GPC opt-outs bail before any send (review B2#6)', () => {
    const base = { pathname: '/x', origin: 'https://site.example', innerWidth: 800 }
    expectParity(runTracker({ ...base, nav: { doNotTrack: '1' } }).length).toBe(0)
    expectParity(runTracker({ ...base, nav: { doNotTrack: 'yes' } }).length).toBe(0)
    expectParity(runTracker({ ...base, nav: { msDoNotTrack: '1' } }).length).toBe(0)
    expectParity(runTracker({ ...base, winDoNotTrack: '1' }).length).toBe(0)
    expectParity(runTracker({ ...base, winDoNotTrack: 'yes' }).length).toBe(0)
    expectParity(runTracker({ ...base, nav: { globalPrivacyControl: true } }).length).toBe(0)
    expectParity(runTracker({ ...base, nav: { webdriver: true } }).length).toBe(0)
    // 'unspecified'/'0' are NOT opt-outs — tracking proceeds.
    expectParity(runTracker({ ...base, nav: { doNotTrack: '0' } }).length).toBe(1)
    expectParity(runTracker({ ...base, nav: { doNotTrack: 'unspecified' } }).length).toBe(1)
  })

  testParity('missing/disabled config bails silently', () => {
    const base = { pathname: '/x', origin: 'https://site.example' }
    expectParity(runTracker({ ...base, config: null }).length).toBe(0)
    expectParity(runTracker({ ...base, config: { ...CONFIG, enabled: false } }).length).toBe(0)
    expectParity(runTracker({ ...base, config: { ...CONFIG, endpoint: '' } }).length).toBe(0)
  })
})

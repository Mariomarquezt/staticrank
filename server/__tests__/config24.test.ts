/**
 * Task 2.4 — seo-config `analytics` + `verification` sections: defaults,
 * validation (token extraction from pasted meta tags), storage
 * round-trips, and the presence-first section semantics extended to the
 * new keys.
 */

import { describe, expect, test } from 'bun:test'
import { validateSeoMeta } from '../seoMeta'
import {
  analyticsEnabled,
  deserializeSeoConfigRecords,
  extractVerificationToken,
  hasExplicitConfigSection,
  isEmptySeoConfig,
  resolveConfigSections,
  serializeSeoConfig,
  validateSeoConfig,
  type SeoConfigData,
} from '../seoConfig'

describe('analytics section', () => {
  test('defaults OFF; only enabled:true is stored', () => {
    expect(analyticsEnabled({})).toBe(false)
    expect(analyticsEnabled({ analytics: {} })).toBe(false)
    expect(analyticsEnabled({ analytics: { enabled: true } })).toBe(true)

    const on = validateSeoConfig({ analytics: { enabled: true } })
    expect(on).toEqual({ ok: true, value: { analytics: { enabled: true } } })
    // The default (false) normalizes away — the record disappears.
    const off = validateSeoConfig({ analytics: { enabled: false } })
    expect(off).toEqual({ ok: true, value: {} })
  })

  test('rejects unknown fields and non-boolean toggles', () => {
    const bad = validateSeoConfig({ analytics: { enabled: 'yes', extra: 1 } })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.errors.map((e) => e.field).sort()).toEqual([
        'analytics.enabled',
        'analytics.extra',
      ])
    }
  })

  test('storage round-trip', () => {
    const config: SeoConfigData = { analytics: { enabled: true } }
    const records = serializeSeoConfig(config)
    expect(records).toEqual([{ key: 'analytics', analyticsEnabled: true }])
    expect(deserializeSeoConfigRecords(records)).toEqual(config)
  })
})

describe('extractVerificationToken', () => {
  test('bare tokens pass through trimmed', () => {
    expect(extractVerificationToken('  AbC-123_xyz=  ')).toBe('AbC-123_xyz=')
  })

  test('pasted meta tags are stripped to the content value', () => {
    expect(
      extractVerificationToken(
        '<meta name="google-site-verification" content="tok3n_ABC" />',
      ),
    ).toBe('tok3n_ABC')
    expect(extractVerificationToken("<meta name='msvalidate.01' content='BINGTOKEN'>")).toBe(
      'BINGTOKEN',
    )
  })

  test('rejects unusable inputs', () => {
    expect(extractVerificationToken('')).toBeUndefined()
    expect(extractVerificationToken('has spaces inside')).toBeUndefined()
    expect(extractVerificationToken('<meta name="x">')).toBeUndefined()
    expect(extractVerificationToken('quo"te')).toBeUndefined()
    expect(extractVerificationToken('a'.repeat(201))).toBeUndefined()
  })
})

describe('verification section', () => {
  test('validates + normalizes each service field', () => {
    const result = validateSeoConfig({
      verification: {
        google: '<meta name="google-site-verification" content="G-TOK">',
        bing: 'B-TOK',
        pinterest: '',
      },
    })
    expect(result).toEqual({
      ok: true,
      value: { verification: { google: 'G-TOK', bing: 'B-TOK' } },
    })
  })

  test('field errors for unusable tokens and unknown services', () => {
    const result = validateSeoConfig({
      verification: { google: 'not a token', yandex: 'x' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.map((e) => e.field).sort()).toEqual([
        'verification.google',
        'verification.yandex',
      ])
    }
  })

  test('storage round-trip re-extracts defensively on read', () => {
    const config: SeoConfigData = {
      verification: { google: 'G', bing: 'B', pinterest: 'P' },
    }
    const records = serializeSeoConfig(config)
    expect(records).toEqual([
      { key: 'verification', verificationGoogle: 'G', verificationBing: 'B', verificationPinterest: 'P' },
    ])
    expect(deserializeSeoConfigRecords(records)).toEqual(config)
    // A hand-edited record with an unsafe value never surfaces it.
    expect(
      deserializeSeoConfigRecords([
        { key: 'verification', verificationGoogle: 'has spaces "quoted"' },
      ]),
    ).toEqual({})
  })
})

describe('GET /meta response envelope', () => {
  test('validateSeoMeta ignores the read-only imageAudit join key', () => {
    // A client that round-trips a GET /meta body into POST must not 400
    // over the envelope key — and it must never be stored either.
    const result = validateSeoMeta({
      title: 'T',
      imageAudit: { totalImages: 3, findings: 1 },
    })
    expect(result).toEqual({ ok: true, value: { title: 'T' } })
  })

  test('other unknown keys still fail', () => {
    const result = validateSeoMeta({ imageAudi: {} })
    expect(result.ok).toBe(false)
  })
})

describe('section-presence semantics (2.3 rules over the 2.4 keys)', () => {
  const stored: SeoConfigData = {
    site: { siteName: 'Acme' },
    analytics: { enabled: true },
    verification: { google: 'G' },
  }

  test('absent keys carry forward, present keys replace', () => {
    const rawBody = { verification: { google: 'NEW' } }
    const validated = validateSeoConfig(rawBody)
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    const resolved = resolveConfigSections(rawBody, validated.value, stored)
    expect(resolved).toEqual({
      site: { siteName: 'Acme' },
      analytics: { enabled: true }, // absent → carried forward
      verification: { google: 'NEW' }, // present → replaced
    })
  })

  test('present-but-empty clears (explicit `{}` / all-defaults)', () => {
    const rawBody = { analytics: { enabled: false }, verification: {} }
    const validated = validateSeoConfig(rawBody)
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    const resolved = resolveConfigSections(rawBody, validated.value, stored)
    expect(resolved).toEqual({ site: { siteName: 'Acme' } })
  })

  test('hasExplicitConfigSection / isEmptySeoConfig know the new keys', () => {
    expect(hasExplicitConfigSection({ analytics: {} })).toBe(true)
    expect(hasExplicitConfigSection({ verification: {} })).toBe(true)
    expect(hasExplicitConfigSection({ unrelated: {} })).toBe(false)
    expect(isEmptySeoConfig({ analytics: { enabled: true } })).toBe(false)
    expect(isEmptySeoConfig({ verification: { google: 'G' } })).toBe(false)
    expect(isEmptySeoConfig({})).toBe(true)
  })
})

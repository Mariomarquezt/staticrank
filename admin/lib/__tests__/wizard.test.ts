/**
 * Task 2.6 — setup-wizard step/completion model.
 */
import { describe, expect, test } from 'bun:test'
import type { SeoConfigData } from '../../../server/seoConfig'
import {
  WIZARD_STEPS,
  WIZARD_STEP_IDS,
  buildSetupAudit,
  isConfigComplete,
  nextStep,
  prevStep,
  runtimeDocUrls,
  stepIndex,
} from '../wizard'

const PLUGIN_ID = 'monkeywebs.seo'

describe('steps', () => {
  test('step metadata covers every step id in order', () => {
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual([...WIZARD_STEP_IDS])
  })

  test('next/prev walk the sequence and stop at the ends', () => {
    expect(nextStep('basics')).toBe('titles')
    expect(nextStep('analytics')).toBe('finish')
    expect(nextStep('finish')).toBeNull()
    expect(prevStep('finish')).toBe('analytics')
    expect(prevStep('basics')).toBeNull()
    expect(stepIndex('basics')).toBe(0)
    expect(stepIndex('finish')).toBe(WIZARD_STEP_IDS.length - 1)
  })
})

describe('isConfigComplete', () => {
  test('incomplete without a stored siteUrl', () => {
    expect(isConfigComplete({})).toBe(false)
    expect(isConfigComplete({ site: { siteName: 'Acme' } })).toBe(false)
  })

  test('complete exactly when siteUrl normalizes to a bare origin', () => {
    expect(isConfigComplete({ site: { siteUrl: 'https://example.com' } })).toBe(true)
    // unusable stored value must not read as configured
    expect(isConfigComplete({ site: { siteUrl: 'not a url' } })).toBe(false)
  })
})

describe('runtimeDocUrls', () => {
  test('absolute against the configured origin', () => {
    const urls = runtimeDocUrls(PLUGIN_ID, { site: { siteUrl: 'https://example.com' } })
    expect(urls.absolute).toBe(true)
    expect(urls.sitemap).toBe(
      'https://example.com/admin/api/cms/plugins/monkeywebs.seo/runtime/sitemap.xml',
    )
    expect(urls.llmsTxt).toBe(
      'https://example.com/admin/api/cms/plugins/monkeywebs.seo/runtime/llms.txt',
    )
  })

  test('root-relative while no siteUrl is set', () => {
    const urls = runtimeDocUrls(PLUGIN_ID, {})
    expect(urls.absolute).toBe(false)
    expect(urls.sitemap).toBe('/admin/api/cms/plugins/monkeywebs.seo/runtime/sitemap.xml')
  })
})

describe('buildSetupAudit', () => {
  test('empty config → everything unconfigured except defaults-on items', () => {
    const items = buildSetupAudit({})
    const byId = new Map(items.map((i) => [i.id, i]))
    expect(byId.get('site-url')?.ok).toBe(false)
    expect(byId.get('site-name')?.ok).toBe(false)
    expect(byId.get('meta-description')?.ok).toBe(false)
    expect(byId.get('title-template')?.ok).toBe(false)
    // IndexNow defaults to ENABLED, but the ok-mark ALSO requires a
    // usable siteUrl (review C#2) — no URL, no possible submission.
    expect(byId.get('indexnow')?.ok).toBe(false)
    // schema graph defaults on but no publisher named → not ok
    expect(byId.get('schema')?.ok).toBe(false)
    expect(byId.get('verification')?.ok).toBe(false)
    // analytics is opt-in, default OFF
    expect(byId.get('analytics')?.ok).toBe(false)
  })

  test('fully configured config → all ok', () => {
    const config: SeoConfigData = {
      site: {
        siteUrl: 'https://example.com',
        siteName: 'Acme',
        metaDescription: 'What Acme does.',
        titleTemplate: '%title% %sep% %site%',
      },
      schema: { publisherName: 'Acme Inc.' },
      verification: { google: 'tok' },
      analytics: { enabled: true },
    }
    for (const item of buildSetupAudit(config)) {
      expect({ id: item.id, ok: item.ok }).toEqual({ id: item.id, ok: true })
    }
  })

  test('per-table template alone satisfies the title-template item', () => {
    const items = buildSetupAudit({ tables: { posts: { titleTemplate: '%title%' } } })
    expect(items.find((i) => i.id === 'title-template')?.ok).toBe(true)
  })

  test('disabled toggles read as unconfigured', () => {
    const items = buildSetupAudit({
      indexNow: { enabled: false },
      schema: { enabled: false, publisherName: 'Acme' },
    })
    const byId = new Map(items.map((i) => [i.id, i]))
    expect(byId.get('indexnow')?.ok).toBe(false)
    // schema disabled → publisher name alone doesn't make it ok
    expect(byId.get('schema')?.ok).toBe(false)
  })

  test('IndexNow ok requires BOTH the toggle and a usable siteUrl (C#2)', () => {
    const on = (config: SeoConfigData) =>
      buildSetupAudit(config).find((i) => i.id === 'indexnow')!
    // toggle on (default) + siteUrl → ok
    expect(on({ site: { siteUrl: 'https://example.com' } }).ok).toBe(true)
    // toggle on, no siteUrl → NOT ok, with the needs-URL wording
    const noUrl = on({})
    expect(noUrl.ok).toBe(false)
    expect(noUrl.detail).toContain('Site URL')
    // toggle off, siteUrl present → NOT ok
    expect(on({ site: { siteUrl: 'https://example.com' }, indexNow: { enabled: false } }).ok).toBe(
      false,
    )
  })

  test('audit lines speak in configured-state language, not operating claims (C#2)', () => {
    const items = buildSetupAudit({
      site: { siteUrl: 'https://example.com' },
      analytics: { enabled: true },
    })
    const byId = new Map(items.map((i) => [i.id, i]))
    expect(byId.get('indexnow')?.detail).toContain('after the next publish')
    expect(byId.get('analytics')?.detail).toContain('next publish')
  })

  test('Pro teasers follow the §3.4 copy scheme', () => {
    const withPro = buildSetupAudit({}).filter((i) => i.pro !== undefined)
    expect(withPro.length).toBeGreaterThan(0)
    for (const item of withPro) {
      expect(item.pro!.startsWith('Included in Pro — ')).toBe(true)
    }
  })
})

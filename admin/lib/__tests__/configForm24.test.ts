/**
 * Task 2.4 — settings-form extensions: Schema tab (publisher + sameAs
 * rows), analytics toggle, verification fields; dirty tracking + dirty
 * merge for all of them; and the explicit-section POST body that makes
 * every save authoritative for the sections this client knows (2.3
 * presence semantics — see explicitSectionBody).
 */

import { describe, expect, test } from 'bun:test'
import {
  emptyConfigForm,
  explicitSectionBody,
  formFromConfig,
  isConfigFormDirty,
  mergeDirtyConfig,
  planConfigSave,
  serverErrorsToForm,
  validateConfigForm,
} from '../configForm'
import type { SeoConfigData } from '../../../server/seoConfig'

const STORED: SeoConfigData = {
  site: { siteName: 'Acme' },
  schema: {
    publisherKind: 'organization',
    publisherName: 'Acme Inc.',
    sameAs: ['https://x.com/acme', 'https://github.com/acme'],
  },
  analytics: { enabled: true },
  verification: { google: 'G-TOK' },
}

describe('formFromConfig (2.4 fields)', () => {
  test('loads schema/analytics/verification into the form', () => {
    const form = formFromConfig(STORED)
    expect(form.schemaEnabled).toBe(true)
    expect(form.publisherKind).toBe('organization')
    expect(form.publisherName).toBe('Acme Inc.')
    expect(form.sameAsRows).toEqual([
      { id: 0, url: 'https://x.com/acme' },
      { id: 1, url: 'https://github.com/acme' },
    ])
    expect(form.analyticsEnabled).toBe(true)
    expect(form.verificationGoogle).toBe('G-TOK')
    expect(form.verificationBing).toBe('')
  })

  test('defaults: schema on, analytics off', () => {
    const form = formFromConfig({})
    expect(form.schemaEnabled).toBe(true)
    expect(form.analyticsEnabled).toBe(false)
    expect(form.sameAsRows).toEqual([])
  })
})

describe('dirty tracking (2.4 fields)', () => {
  test('each new field marks the form dirty', () => {
    const baseline = formFromConfig(STORED)
    expect(isConfigFormDirty(baseline, baseline)).toBe(false)
    expect(isConfigFormDirty({ ...baseline, schemaEnabled: false }, baseline)).toBe(true)
    expect(isConfigFormDirty({ ...baseline, publisherName: 'Other' }, baseline)).toBe(true)
    expect(isConfigFormDirty({ ...baseline, analyticsEnabled: false }, baseline)).toBe(true)
    expect(isConfigFormDirty({ ...baseline, verificationBing: 'B' }, baseline)).toBe(true)
    expect(
      isConfigFormDirty(
        { ...baseline, sameAsRows: baseline.sameAsRows.slice(0, 1) },
        baseline,
      ),
    ).toBe(true)
  })
})

describe('mergeDirtyConfig (2.4 fields)', () => {
  test('undirty sections survive the fresh document verbatim', () => {
    const baseline = formFromConfig(STORED)
    const form = { ...baseline, siteName: 'Renamed' } // only site dirty
    const fresh: SeoConfigData = {
      ...STORED,
      verification: { google: 'CONCURRENT' }, // another admin's edit
    }
    const merged = mergeDirtyConfig(fresh, form, baseline)
    expect(merged.site?.siteName).toBe('Renamed')
    expect(merged.verification).toEqual({ google: 'CONCURRENT' })
    expect(merged.schema).toEqual(STORED.schema)
    expect(merged.analytics).toEqual({ enabled: true })
  })

  test('dirty schema fields merge field-wise; sameAs replaces as one unit', () => {
    const baseline = formFromConfig(STORED)
    const form = {
      ...baseline,
      publisherName: 'New Name',
      sameAsRows: [{ id: 0, url: 'https://only.example/acme' }],
    }
    const merged = mergeDirtyConfig(STORED, form, baseline)
    expect(merged.schema).toEqual({
      publisherKind: 'organization',
      publisherName: 'New Name',
      sameAs: ['https://only.example/acme'],
    })
  })

  test('blanking dirty fields deletes them; toggles map to presence', () => {
    const baseline = formFromConfig(STORED)
    const form = {
      ...baseline,
      publisherName: '',
      sameAsRows: [],
      analyticsEnabled: false,
      verificationGoogle: '',
      schemaEnabled: false,
    }
    const merged = mergeDirtyConfig(STORED, form, baseline)
    expect(merged.schema).toEqual({ enabled: false, publisherKind: 'organization' })
    expect(merged.analytics).toBeUndefined()
    expect(merged.verification).toBeUndefined()
  })
})

describe('explicit-section save body (2.3 semantics fix)', () => {
  test('every known section is present; empty ones are explicit `{}`', () => {
    const body = explicitSectionBody({ site: { siteName: 'Acme' } })
    expect(Object.keys(body).sort()).toEqual([
      'analytics',
      'indexNow',
      'schema',
      'site',
      'tables',
      'verification',
    ])
    expect(body.site).toEqual({ siteName: 'Acme' })
    expect(body.schema).toEqual({})
    expect(body.indexNow).toEqual({})
  })

  test('re-enabling IndexNow POSTs an explicit empty section (clears stored false)', () => {
    // The regression this fixes: enabled merges the section AWAY, and an
    // ABSENT key would carry the stored {enabled:false} forward — the
    // toggle would never save.
    const plan = planConfigSave({ site: { siteName: 'Acme' } })
    expect(plan.kind).toBe('post')
    if (plan.kind !== 'post') return
    expect(plan.body.indexNow).toEqual({})
  })

  test('fully empty documents still route to DELETE (no unmodeled sections)', () => {
    expect(planConfigSave({})).toEqual({ kind: 'delete' })
    expect(planConfigSave({}, { site: { siteName: 'A' } })).toEqual({ kind: 'delete' })
  })

  test('REGRESSION (review B2#2): an unknown server section survives a save', () => {
    // A future server ships a `redirects` section this form has no
    // fields for. The fresh /config response carries it at runtime.
    const freshRaw = {
      site: { siteName: 'Acme' },
      redirects: { rules: [{ from: '/a', to: '/b' }] },
    }
    const baseline = formFromConfig(freshRaw as SeoConfigData)
    const form = { ...baseline, siteName: 'Renamed' }
    const merged = mergeDirtyConfig(freshRaw as SeoConfigData, form, baseline)
    const plan = planConfigSave(merged, freshRaw)
    expect(plan.kind).toBe('post')
    if (plan.kind !== 'post') return
    // The POST body OMITS the unmodeled section entirely — server
    // carry-forward keeps it; a `{}` here would be an explicit clear.
    expect('redirects' in plan.body).toBe(false)
    expect(plan.body.site).toEqual({ siteName: 'Renamed' })
  })

  test('REGRESSION (review B2#2): clearing everything never DELETEs past an unknown section', () => {
    const freshRaw = { site: { siteName: 'Acme' }, redirects: { rules: [] } }
    // The user blanked every modeled field → merged document is empty.
    const plan = planConfigSave({}, freshRaw)
    // DELETE would wipe the unmodeled `redirects` records too — the
    // clear must go out as a POST of explicit empty MODELED sections.
    expect(plan.kind).toBe('post')
    if (plan.kind !== 'post') return
    expect('redirects' in plan.body).toBe(false)
    expect(plan.body.site).toEqual({})
    expect(plan.body.schema).toEqual({})
  })
})

describe('validation + error mapping (2.4 fields)', () => {
  test('sameAs row errors map onto stable row ids', () => {
    const form = {
      ...emptyConfigForm(),
      sameAsRows: [
        { id: 7, url: 'https://ok.example/a' },
        { id: 9, url: 'not-a-url' },
      ],
    }
    const result = validateConfigForm(form)
    expect(result.ok).toBe(false)
    expect(result.sameAsErrors[9]).toBeDefined()
    expect(result.sameAsErrors[7]).toBeUndefined()
  })

  test('server 400 errors map the same way', () => {
    const form = {
      ...emptyConfigForm(),
      sameAsRows: [{ id: 3, url: 'https://a.example/x' }],
    }
    const mapped = serverErrorsToForm(
      [
        { field: 'schema.sameAs.0', message: 'must be an absolute http(s) URL' },
        { field: 'verification.google', message: 'bad token' },
      ],
      form,
    )
    expect(mapped.sameAsErrors[3]).toBe('must be an absolute http(s) URL')
    expect(mapped.fieldErrors['verification.google']).toBe('bad token')
  })

  test('verification token extraction runs client-side too (shared validator)', () => {
    const form = {
      ...emptyConfigForm(),
      verificationGoogle: '<meta name="google-site-verification" content="G-TOK">',
    }
    const result = validateConfigForm(form)
    expect(result.ok).toBe(true)
    expect(result.config.verification?.google).toBe('G-TOK')
  })
})

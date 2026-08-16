/**
 * Task 2.6 — settings export/import: round-trips, format-marker gating,
 * unknown-section rejection, partial documents, diff preview, save body.
 */
import { describe, expect, test } from 'bun:test'
import type { SeoConfigData } from '../../../server/seoConfig'
import { FORM_MODELED_SECTIONS } from '../configForm'
import {
  CONFIG_EXPORT_FORMAT,
  MAX_IMPORT_FILE_BYTES,
  buildConfigExport,
  diffConfigImport,
  importFileTooLarge,
  importHasChanges,
  importSaveBody,
  parseConfigImport,
  serializeConfigExport,
} from '../configTransfer'

const FULL_CONFIG: SeoConfigData = {
  site: {
    siteUrl: 'https://example.com',
    siteName: 'Acme',
    separator: '·',
    metaDescription: 'What Acme does.',
    titleTemplate: '%title% %sep% %site%',
  },
  tables: { posts: { titleTemplate: '%title% %sep% %site%' } },
  indexNow: { enabled: false },
  schema: { publisherKind: 'organization', publisherName: 'Acme Inc.' },
  analytics: { enabled: true },
  verification: { google: 'tok-google' },
}

describe('export → import round-trip', () => {
  test('a serialized export parses back to the same document', () => {
    const raw = serializeConfigExport(buildConfigExport(FULL_CONFIG, '0.1.0', '2026-08-14T00:00:00Z'))
    const result = parseConfigImport(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config).toEqual(FULL_CONFIG)
    expect(result.presentSections).toEqual([...FORM_MODELED_SECTIONS])
  })

  test('export file carries the marker + plugin version', () => {
    const file = buildConfigExport(FULL_CONFIG, '0.1.0', '2026-08-14T00:00:00Z')
    expect(file._format).toBe(CONFIG_EXPORT_FORMAT)
    expect(file._pluginVersion).toBe('0.1.0')
    expect(file._exportedAt).toBe('2026-08-14T00:00:00Z')
  })
})

describe('parseConfigImport failure modes', () => {
  test('malformed JSON', () => {
    const result = parseConfigImport('{nope')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]!.message).toContain('not a JSON file')
  })

  test('non-object roots', () => {
    for (const raw of ['[1,2]', '"hi"', 'null', '5']) {
      const result = parseConfigImport(raw)
      expect(result.ok).toBe(false)
    }
  })

  test('wrong or missing format marker', () => {
    const wrong = JSON.stringify({ _format: 'someone-else/config@1', config: {} })
    const missing = JSON.stringify({ config: { site: {} } })
    for (const raw of [wrong, missing]) {
      const result = parseConfigImport(raw)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.errors[0]!.message).toContain(CONFIG_EXPORT_FORMAT)
    }
  })

  test('missing/invalid config object', () => {
    for (const config of [undefined, null, [1], 'x']) {
      const result = parseConfigImport(JSON.stringify({ _format: CONFIG_EXPORT_FORMAT, config }))
      expect(result.ok).toBe(false)
    }
  })

  test('unknown sections in the FILE are rejected with a clear error', () => {
    const raw = JSON.stringify({
      _format: CONFIG_EXPORT_FORMAT,
      config: { site: { siteName: 'Acme' }, futureSection: { x: 1 } },
    })
    const result = parseConfigImport(raw)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]!.message).toContain('futureSection')
    expect(result.errors[0]!.message).toContain('unknown section')
  })

  test('invalid field values surface the SAME validator errors as POST /config', () => {
    const raw = JSON.stringify({
      _format: CONFIG_EXPORT_FORMAT,
      config: { site: { siteUrl: 'https://example.com/some/path' } },
    })
    const result = parseConfigImport(raw)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.field === 'site.siteUrl')).toBe(true)
  })

  test('a config with no sections at all is rejected (nothing to import)', () => {
    const result = parseConfigImport(JSON.stringify({ _format: CONFIG_EXPORT_FORMAT, config: {} }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]!.message).toContain('no settings sections')
  })

  test('extra top-level metadata keys are tolerated', () => {
    const raw = JSON.stringify({
      _format: CONFIG_EXPORT_FORMAT,
      _pluginVersion: '9.9.9',
      _note: 'exported from staging',
      config: { site: { siteName: 'Acme' } },
    })
    const result = parseConfigImport(raw)
    expect(result.ok).toBe(true)
  })
})

describe('import size cap (C#5)', () => {
  test('exactly at the cap passes; one byte over is rejected', () => {
    expect(MAX_IMPORT_FILE_BYTES).toBe(1024 * 1024)
    expect(importFileTooLarge(MAX_IMPORT_FILE_BYTES)).toBe(false)
    expect(importFileTooLarge(MAX_IMPORT_FILE_BYTES + 1)).toBe(true)
  })

  test('ordinary export sizes are far under the cap', () => {
    const raw = serializeConfigExport(buildConfigExport(FULL_CONFIG, '0.1.0', '2026-08-14T00:00:00Z'))
    expect(importFileTooLarge(new TextEncoder().encode(raw).length)).toBe(false)
  })

  test('zero and small sizes pass', () => {
    expect(importFileTooLarge(0)).toBe(false)
    expect(importFileTooLarge(4096)).toBe(false)
  })
})

describe('partial documents', () => {
  test('a site-only file imports only the site section', () => {
    const raw = JSON.stringify({
      _format: CONFIG_EXPORT_FORMAT,
      config: { site: { siteName: 'Acme' } },
    })
    const result = parseConfigImport(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.presentSections).toEqual(['site'])
    expect(importSaveBody(result.config, result.presentSections)).toEqual({
      site: { siteName: 'Acme' },
    })
  })

  test('present-but-empty sections stay explicit `{}` in the save body (clear)', () => {
    const raw = JSON.stringify({
      _format: CONFIG_EXPORT_FORMAT,
      config: { site: { siteName: 'Acme' }, verification: {} },
    })
    const result = parseConfigImport(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.presentSections).toEqual(['site', 'verification'])
    const body = importSaveBody(result.config, result.presentSections)
    expect(body.verification).toEqual({})
    // absent sections are OMITTED — server carry-forward protects them
    expect('indexNow' in body).toBe(false)
    expect('schema' in body).toBe(false)
  })

  test('validator normalizations apply (trailing slash trimmed)', () => {
    const raw = JSON.stringify({
      _format: CONFIG_EXPORT_FORMAT,
      config: { site: { siteUrl: 'https://example.com/' } },
    })
    const result = parseConfigImport(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.site?.siteUrl).toBe('https://example.com')
  })
})

describe('diffConfigImport', () => {
  test('classifies added / changed / cleared / unchanged / kept', () => {
    const current: SeoConfigData = {
      site: { siteName: 'Old' },
      verification: { google: 'tok' },
      analytics: { enabled: true },
      indexNow: { enabled: false },
    }
    const imported: SeoConfigData = {
      site: { siteName: 'New' }, // changed
      schema: { publisherName: 'Acme' }, // added
      analytics: { enabled: true }, // unchanged
      // verification present-but-empty → cleared
    }
    const changes = diffConfigImport(current, imported, [
      'site',
      'schema',
      'analytics',
      'verification',
    ])
    const byId = new Map(changes.map((c) => [c.section, c.kind]))
    expect(byId.get('site')).toBe('changed')
    expect(byId.get('schema')).toBe('added')
    expect(byId.get('analytics')).toBe('unchanged')
    expect(byId.get('verification')).toBe('cleared')
    // absent from the file → kept
    expect(byId.get('indexNow')).toBe('kept')
    expect(byId.get('tables')).toBe('kept')
    expect(importHasChanges(changes)).toBe(true)
  })

  test('empty-vs-absent sections compare as equal (unchanged)', () => {
    const changes = diffConfigImport({}, { verification: {} }, ['verification'])
    expect(changes.find((c) => c.section === 'verification')?.kind).toBe('unchanged')
  })

  test('no effective changes → importHasChanges false', () => {
    const current: SeoConfigData = { site: { siteName: 'Acme' } }
    const changes = diffConfigImport(current, { site: { siteName: 'Acme' } }, ['site'])
    expect(importHasChanges(changes)).toBe(false)
  })
})

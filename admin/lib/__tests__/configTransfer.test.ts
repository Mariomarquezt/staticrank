/**
 * Task 2.6 — settings export/import: round-trips, format-marker gating,
 * unknown-section rejection, partial documents, diff preview, save body.
 */
import { describe, expect, test } from 'bun:test'
import {
  CONFIG_TABLES_MAX,
  SEO_CONFIG_REQUEST_BODY_MAX,
  TABLE_SLUG_MAX,
  TITLE_TEMPLATE_MAX,
  type SeoConfigData,
} from '../../../server/seoConfig'
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
  pickExportableConfig,
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
    expect(importFileTooLarge(MAX_IMPORT_FILE_BYTES)).toBe(false)
    expect(importFileTooLarge(MAX_IMPORT_FILE_BYTES + 1)).toBe(true)
  })

  test('the cap clears the schema-derived worst case with margin (t4-31)', () => {
    // The server's own worst-case JSON budget for one config document
    // bounds the config's byte length; the file adds only the envelope
    // and pretty-print indentation.
    expect(MAX_IMPORT_FILE_BYTES).toBeGreaterThan(SEO_CONFIG_REQUEST_BODY_MAX)
    expect(MAX_IMPORT_FILE_BYTES % (1024 * 1024)).toBe(0)
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

describe('export carries ONLY config sections (t4-30)', () => {
  // GET /config answers with the stored document PLUS run-state warnings
  // when something is wrong; those keys are not importable sections, so a
  // verbatim export was a backup that refused to re-import exactly when
  // the site had an active problem.
  const CONTAMINATED = {
    ...FULL_CONFIG,
    version: 1,
    decorationFailures: { count: 2, pages: ['p1'], lastAt: '2026-08-23T00:00:00Z' },
    indexNowFailure: { status: 'submission failed', lastAt: '2026-08-23T00:00:00Z' },
  } as unknown as SeoConfigData

  test('pickExportableConfig keeps modeled sections + version, drops the rest', () => {
    const picked = pickExportableConfig(CONTAMINATED) as Record<string, unknown>
    expect(picked.version).toBe(1)
    expect('decorationFailures' in picked).toBe(false)
    expect('indexNowFailure' in picked).toBe(false)
    for (const section of FORM_MODELED_SECTIONS) {
      expect(picked[section]).toEqual(CONTAMINATED[section] as unknown)
    }
  })

  test('absent sections are not invented as empty objects', () => {
    const picked = pickExportableConfig({ site: { siteName: 'Acme' } }) as Record<string, unknown>
    expect(Object.keys(picked)).toEqual(['site'])
  })

  test('an export taken while warnings are active still imports', () => {
    const raw = serializeConfigExport(
      buildConfigExport(CONTAMINATED, '0.1.0', '2026-08-23T00:00:00Z'),
    )
    expect(raw).not.toContain('decorationFailures')
    const result = parseConfigImport(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.presentSections).toEqual([...FORM_MODELED_SECTIONS])
  })
})

describe('a MAXIMAL valid config round-trips through the size cap (t4-31)', () => {
  test('every schema maximum at once exports and re-imports', () => {
    const longSlug = (index: number) =>
      `t${String(index).padStart(5, '0')}`.padEnd(TABLE_SLUG_MAX, 'a')
    const tables: Record<string, { titleTemplate: string }> = {}
    for (let i = 0; i < CONFIG_TABLES_MAX; i++) {
      tables[longSlug(i)] = { titleTemplate: 'x'.repeat(TITLE_TEMPLATE_MAX) }
    }
    const maximal: SeoConfigData = {
      site: {
        siteUrl: `https://${'a'.repeat(60)}.example.com`,
        siteName: 'n'.repeat(200),
        separator: 's'.repeat(20),
        metaDescription: 'd'.repeat(500),
        titleTemplate: 't'.repeat(TITLE_TEMPLATE_MAX),
      },
      tables,
      indexNow: { enabled: true },
      schema: {
        publisherKind: 'organization',
        publisherName: 'p'.repeat(200),
        publisherLogoUrl: `https://example.com/${'l'.repeat(1900)}.png`,
        sameAs: Array.from(
          { length: 10 },
          (_, i) => `https://example.com/${String(i)}${'u'.repeat(1900)}`,
        ),
      },
      analytics: { enabled: true },
      verification: {
        google: 'g'.repeat(200),
        bing: 'b'.repeat(200),
        pinterest: 'p'.repeat(200),
      },
    }
    const raw = serializeConfigExport(buildConfigExport(maximal, '0.1.0', '2026-08-23T00:00:00Z'))
    const bytes = new TextEncoder().encode(raw).length
    // The whole point: the cap is above a maximal VALID export.
    expect(bytes).toBeGreaterThan(1024 * 1024) // the old 1 MiB cap would reject it
    expect(importFileTooLarge(bytes)).toBe(false)
    const result = parseConfigImport(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.config.tables ?? {}).length).toBe(CONFIG_TABLES_MAX)
  })
})

// ---------------------------------------------------------------------------
// settings.tsx wiring guards — source-text checks, because no
// component-render harness exists for the .tsx files (same precedent as
// admin/lib/__tests__/redirects.test.ts).
// ---------------------------------------------------------------------------

describe('settings.tsx save/import wiring (t4-30)', () => {
  async function settingsSource(): Promise<string> {
    return Bun.file(new URL('../../settings.tsx', import.meta.url).pathname).text()
  }

  test('the save response is MERGED with in-flight edits, not assigned wholesale', async () => {
    const source = await settingsSource()
    // The form the request describes is captured before the await…
    expect(source).toContain('const savedForm = form')
    // …and the response is merged into whatever the form holds on arrival.
    expect(source).toContain(
      'setForm((currentForm) => mergeConfigFormAfterSave(nextForm, savedForm, currentForm))',
    )
    // The save path must not go back to replacing the form outright.
    const save = source.slice(source.indexOf('async function save('), source.indexOf('/** Export'))
    expect(save).not.toContain('setForm(nextForm)')
  })

  test('applying an import over unsaved edits needs a second, labelled confirm', async () => {
    const source = await settingsSource()
    expect(source).toContain('if (dirty && !confirmDiscardEdits)')
    expect(source).toContain('Discard edits and import')
    expect(source).toContain('You have unsaved settings edits')
    // The confirm never survives a new preview or a completed import.
    expect(source.match(/setConfirmDiscardEdits\(false\)/g)?.length).toBeGreaterThanOrEqual(3)
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

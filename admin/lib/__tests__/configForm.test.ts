import { describe, expect, test } from 'bun:test'
import {
  configEquals,
  configFromForm,
  dirtySiteFields,
  emptyConfigForm,
  formFromConfig,
  isConfigFormDirty,
  mergeDirtyConfig,
  nextRowId,
  planConfigSave,
  previewTemplate,
  sampleTemplateVars,
  serverErrorsToForm,
  validateConfigForm,
  type ConfigFormState,
  type ConfigTableRow,
} from '../configForm'
import type { SeoConfigData } from '../../../server/seoConfig'

let idCounter = 100
function row(tableSlug: string, titleTemplate: string, id?: number): ConfigTableRow {
  return { id: id ?? idCounter++, tableSlug, titleTemplate }
}

function form(partial: Partial<ConfigFormState>): ConfigFormState {
  return { ...emptyConfigForm(), ...partial }
}

describe('formFromConfig / configFromForm round-trip', () => {
  const config: SeoConfigData = {
    site: {
      siteName: 'Acme',
      separator: '|',
      siteUrl: 'https://acme.test',
      titleTemplate: '%title% %sep% %site%',
      metaDescription: 'Default desc',
    },
    tables: {
      posts: { titleTemplate: '%title% — Blog' },
      docs: { titleTemplate: '%title% Docs' },
    },
  }

  test('round-trips a full document', () => {
    expect(configFromForm(formFromConfig(config))).toEqual(config)
  })

  test('rows come out sorted by slug with deterministic ids 0..n-1', () => {
    const rows = formFromConfig(config).tableRows
    expect(rows.map((r) => r.tableSlug)).toEqual(['docs', 'posts'])
    expect(rows.map((r) => r.id)).toEqual([0, 1])
  })

  test('empty form → empty document', () => {
    expect(configFromForm(emptyConfigForm())).toEqual({})
  })

  test('whitespace-only values are absent; half-filled rows contribute nothing', () => {
    const state = form({
      siteName: '   ',
      tableRows: [row('posts', '   '), row('', '%title%')],
    })
    expect(configFromForm(state)).toEqual({})
  })

  test('duplicate slugs: first row wins in the document', () => {
    const state = form({
      tableRows: [row('posts', 'A'), row('posts', 'B')],
    })
    expect(configFromForm(state)).toEqual({ tables: { posts: { titleTemplate: 'A' } } })
  })
})

describe('nextRowId', () => {
  test('empty rows → 0', () => {
    expect(nextRowId([])).toBe(0)
  })

  test('max id + 1, regardless of order', () => {
    expect(nextRowId([row('a', 't', 3), row('b', 't', 1)])).toBe(4)
  })
})

describe('validateConfigForm', () => {
  test('valid form passes and returns the assembled document', () => {
    const result = validateConfigForm(
      form({
        siteName: 'Acme',
        siteUrl: 'https://acme.test',
        siteTitleTemplate: '%title% %sep% %site%',
        tableRows: [row('posts', '%title% Blog')],
      }),
    )
    expect(result.ok).toBe(true)
    expect(result.config).toEqual({
      site: {
        siteName: 'Acme',
        siteUrl: 'https://acme.test',
        titleTemplate: '%title% %sep% %site%',
      },
      tables: { posts: { titleTemplate: '%title% Blog' } },
    })
  })

  test('unknown template variables are rejected (server rule reused)', () => {
    const result = validateConfigForm(form({ siteTitleTemplate: '%title% %bogus%' }))
    expect(result.ok).toBe(false)
    expect(result.fieldErrors['site.titleTemplate']).toContain('unknown template variable')
  })

  test('non-bare-origin site URL is rejected (server rule reused)', () => {
    const result = validateConfigForm(form({ siteUrl: 'https://acme.test/base?x=1' }))
    expect(result.ok).toBe(false)
    expect(result.fieldErrors['site.siteUrl']).toContain('bare http(s) origin')
  })

  test('trailing-slash origin is tolerated (normalized on store)', () => {
    const result = validateConfigForm(form({ siteUrl: 'https://acme.test/' }))
    expect(result.ok).toBe(true)
    expect(result.config.site?.siteUrl).toBe('https://acme.test')
  })

  test('row errors keyed by STABLE row id: blank slug, bad charset, duplicates, missing template', () => {
    const rows = [
      row('', '%title%', 10),
      row('has space', '%title%', 11),
      row('posts', '%title%', 12),
      row('posts', '%title% again', 13),
      row('docs', '   ', 14),
    ]
    const result = validateConfigForm(form({ tableRows: rows }))
    expect(result.ok).toBe(false)
    expect(result.rowErrors[10]?.tableSlug).toBe('table slug required')
    expect(result.rowErrors[11]?.tableSlug).toContain('must match')
    expect(result.rowErrors[12]).toBeUndefined()
    expect(result.rowErrors[13]?.tableSlug).toBe('duplicate table slug')
    expect(result.rowErrors[14]?.titleTemplate).toContain('required')
  })

  test('fully blank rows are ignored', () => {
    const result = validateConfigForm(form({ tableRows: [row('', '')] }))
    expect(result.ok).toBe(true)
    expect(result.rowErrors).toEqual({})
  })

  test('bad table template maps onto the matching row id', () => {
    const result = validateConfigForm(form({ tableRows: [row('posts', '%nope%', 7)] }))
    expect(result.ok).toBe(false)
    expect(result.rowErrors[7]?.titleTemplate).toContain('unknown template variable')
    expect(Object.keys(result.fieldErrors)).toEqual([])
  })
})

describe('serverErrorsToForm', () => {
  test('maps table field paths onto row IDS, leaves the rest keyed by path', () => {
    const state = form({ tableRows: [row('other', 'x', 3), row('posts', '%title%', 9)] })
    const mapped = serverErrorsToForm(
      [
        { field: 'tables.posts.titleTemplate', message: 'bad template' },
        { field: 'site.siteUrl', message: 'bad origin' },
        { field: 'tables.ghost.titleTemplate', message: 'no matching row' },
      ],
      state,
    )
    expect(mapped.rowErrors[9]?.titleTemplate).toBe('bad template')
    expect(mapped.rowErrors[3]).toBeUndefined()
    expect(mapped.fieldErrors['site.siteUrl']).toBe('bad origin')
    expect(mapped.fieldErrors['tables.ghost.titleTemplate']).toBe('no matching row')
  })

  test('errors survive row removal because ids are stable', () => {
    // Row at position 0 removed; the error for 'posts' must land on the
    // surviving row's id, not on whatever now sits at position 0.
    const state = form({ tableRows: [row('posts', '%title%', 5)] })
    const mapped = serverErrorsToForm(
      [{ field: 'tables.posts.titleTemplate', message: 'bad' }],
      state,
    )
    expect(mapped.rowErrors[5]?.titleTemplate).toBe('bad')
  })
})

describe('dirty tracking', () => {
  const baseline = form({
    siteName: 'Old',
    siteUrl: 'https://acme.test',
    tableRows: [row('posts', 'T1', 0), row('docs', 'D1', 1)],
  })

  test('pristine form is not dirty', () => {
    expect(isConfigFormDirty(baseline, baseline)).toBe(false)
    expect(dirtySiteFields(baseline, baseline)).toEqual([])
  })

  test('site field edits are tracked individually', () => {
    const edited = { ...baseline, siteName: 'New' }
    expect(dirtySiteFields(edited, baseline)).toEqual(['siteName'])
    expect(isConfigFormDirty(edited, baseline)).toBe(true)
  })

  test('row edit / add / remove each make the form dirty', () => {
    const editedRow = {
      ...baseline,
      tableRows: [row('posts', 'T2', 0), row('docs', 'D1', 1)],
    }
    expect(isConfigFormDirty(editedRow, baseline)).toBe(true)

    const added = { ...baseline, tableRows: [...baseline.tableRows, row('faq', 'F1', 2)] }
    expect(isConfigFormDirty(added, baseline)).toBe(true)

    const removed = { ...baseline, tableRows: [baseline.tableRows[0]!] }
    expect(isConfigFormDirty(removed, baseline)).toBe(true)
  })
})

describe('mergeDirtyConfig (lost-update fix)', () => {
  // Baseline document both admins started from.
  const storedAtLoad: SeoConfigData = {
    site: { siteName: 'Old', siteUrl: 'https://acme.test' },
    tables: { posts: { titleTemplate: 'T1' } },
  }
  const baseline = formFromConfig(storedAtLoad) // rows: posts id 0

  test('REVIEWER SCENARIO: A dirty site-name only + B fresh table-template change → both survive', () => {
    const aForm = { ...baseline, siteName: 'New' } // A only edited siteName
    const fresh: SeoConfigData = {
      site: { siteName: 'Old', siteUrl: 'https://acme.test' },
      tables: { posts: { titleTemplate: 'T2-from-B' } }, // B changed this meanwhile
    }
    expect(mergeDirtyConfig(fresh, aForm, baseline)).toEqual({
      site: { siteName: 'New', siteUrl: 'https://acme.test' },
      tables: { posts: { titleTemplate: 'T2-from-B' } },
    })
  })

  test('TASK 2.2: an undirty toggle passes the fresh indexNow section through untouched', () => {
    const aForm = { ...baseline, siteName: 'New' }
    const fresh: SeoConfigData = {
      site: { siteName: 'Old', siteUrl: 'https://acme.test' },
      indexNow: { enabled: false }, // another admin disabled it meanwhile
    }
    expect(mergeDirtyConfig(fresh, aForm, baseline)).toEqual({
      site: { siteName: 'New', siteUrl: 'https://acme.test' },
      indexNow: { enabled: false },
    })
  })

  test('TASK 2.2: a dirty toggle wins over the fresh document (both directions)', () => {
    // Disable: baseline enabled, user switched off.
    const offForm = { ...baseline, indexNowEnabled: false }
    expect(
      mergeDirtyConfig({ site: { siteName: 'Old', siteUrl: 'https://acme.test' }, tables: { posts: { titleTemplate: 'T1' } } }, offForm, baseline),
    ).toEqual({
      site: { siteName: 'Old', siteUrl: 'https://acme.test' },
      tables: { posts: { titleTemplate: 'T1' } },
      indexNow: { enabled: false },
    })

    // Re-enable: baseline disabled, user switched on → section drops
    // entirely (enabled is the absent default).
    const disabledStored: SeoConfigData = { ...storedAtLoad, indexNow: { enabled: false } }
    const disabledBaseline = formFromConfig(disabledStored)
    const onForm = { ...disabledBaseline, indexNowEnabled: true }
    expect(mergeDirtyConfig(disabledStored, onForm, disabledBaseline)).toEqual({
      site: { siteName: 'Old', siteUrl: 'https://acme.test' },
      tables: { posts: { titleTemplate: 'T1' } },
    })
  })

  test('TASK 2.2: toggle round-trips through form ↔ document', () => {
    expect(formFromConfig({ indexNow: { enabled: false } }).indexNowEnabled).toBe(false)
    expect(formFromConfig({}).indexNowEnabled).toBe(true)
    const offForm = { ...formFromConfig({}), indexNowEnabled: false }
    expect(configFromForm(offForm)).toEqual({ indexNow: { enabled: false } })
    expect(configFromForm(formFromConfig({}))).toEqual({})
  })

  test('undirty site fields keep the FRESH value, not the baseline one', () => {
    const aForm = { ...baseline, siteName: 'New' }
    const fresh: SeoConfigData = {
      site: { siteName: 'Old', siteUrl: 'https://b-changed.test', metaDescription: 'B desc' },
    }
    expect(mergeDirtyConfig(fresh, aForm, baseline)).toEqual({
      site: { siteName: 'New', siteUrl: 'https://b-changed.test', metaDescription: 'B desc' },
    })
  })

  test('a dirty-cleared site field is removed from the fresh document', () => {
    const aForm = { ...baseline, siteName: '' }
    const fresh: SeoConfigData = {
      site: { siteName: 'Old', siteUrl: 'https://acme.test' },
      tables: { posts: { titleTemplate: 'T1' } },
    }
    expect(mergeDirtyConfig(fresh, aForm, baseline)).toEqual({
      site: { siteUrl: 'https://acme.test' },
      tables: { posts: { titleTemplate: 'T1' } },
    })
  })

  test('dirty row wins over fresh; B new table survives alongside', () => {
    const aForm = {
      ...baseline,
      tableRows: [{ ...baseline.tableRows[0]!, titleTemplate: 'T-A' }],
    }
    const fresh: SeoConfigData = {
      site: { siteName: 'Old', siteUrl: 'https://acme.test' },
      tables: {
        posts: { titleTemplate: 'T-B' }, // B's concurrent edit — A's dirty row wins
        docs: { titleTemplate: 'D-B' }, // B's new table — survives
      },
    }
    expect(mergeDirtyConfig(fresh, aForm, baseline)?.tables).toEqual({
      posts: { titleTemplate: 'T-A' },
      docs: { titleTemplate: 'D-B' },
    })
  })

  test('untouched row keeps B fresh change (row not dirty → fresh survives)', () => {
    const fresh: SeoConfigData = {
      tables: { posts: { titleTemplate: 'T-B' } },
    }
    expect(mergeDirtyConfig(fresh, baseline, baseline)).toEqual({
      tables: { posts: { titleTemplate: 'T-B' } },
    })
  })

  test('removed row deletes its slug from the fresh document', () => {
    const aForm = { ...baseline, tableRows: [] }
    const fresh: SeoConfigData = {
      tables: { posts: { titleTemplate: 'T-B' }, docs: { titleTemplate: 'D-B' } },
    }
    expect(mergeDirtyConfig(fresh, aForm, baseline)).toEqual({
      tables: { docs: { titleTemplate: 'D-B' } },
    })
  })

  test('renamed row drops the old slug and writes the new one', () => {
    const aForm = {
      ...baseline,
      tableRows: [{ ...baseline.tableRows[0]!, tableSlug: 'articles' }],
    }
    const fresh: SeoConfigData = {
      tables: { posts: { titleTemplate: 'T1' }, docs: { titleTemplate: 'D-B' } },
    }
    expect(mergeDirtyConfig(fresh, aForm, baseline)?.tables).toEqual({
      articles: { titleTemplate: 'T1' },
      docs: { titleTemplate: 'D-B' },
    })
  })

  test('a row blanked out removes its slug', () => {
    const aForm = {
      ...baseline,
      tableRows: [{ ...baseline.tableRows[0]!, tableSlug: '', titleTemplate: '' }],
    }
    const fresh: SeoConfigData = { tables: { posts: { titleTemplate: 'T1' } } }
    expect(mergeDirtyConfig(fresh, aForm, baseline)).toEqual({})
  })

  test('added row lands in the merged document', () => {
    const aForm = {
      ...baseline,
      tableRows: [...baseline.tableRows, row('faq', 'F-A', 5)],
    }
    const fresh: SeoConfigData = {
      site: { siteName: 'Old', siteUrl: 'https://acme.test' },
      tables: { posts: { titleTemplate: 'T1' } },
    }
    expect(mergeDirtyConfig(fresh, aForm, baseline)?.tables).toEqual({
      posts: { titleTemplate: 'T1' },
      faq: { titleTemplate: 'F-A' },
    })
  })

  test('everything emptied → empty document (routes to DELETE)', () => {
    const emptied = form({})
    const b = formFromConfig({ site: { siteName: 'Old' } })
    const fresh: SeoConfigData = { site: { siteName: 'Old' } }
    expect(mergeDirtyConfig(fresh, emptied, b)).toEqual({})
  })
})

describe('planConfigSave / configEquals', () => {
  test('empty document routes to DELETE', () => {
    expect(planConfigSave({})).toEqual({ kind: 'delete' })
  })

  test('non-empty document routes to POST with an explicit-section body', () => {
    const config: SeoConfigData = { site: { siteName: 'A' } }
    // Task 2.4: the body carries EVERY section this client knows,
    // present-but-empty `{}` for the rest (2.3 presence semantics — an
    // absent key would carry stored sections forward past a clear).
    expect(planConfigSave(config)).toEqual({
      kind: 'post',
      config,
      body: {
        site: { siteName: 'A' },
        tables: {},
        indexNow: {},
        schema: {},
        analytics: {},
        verification: {},
      },
    })
  })

  test('configEquals is order-insensitive and detects changes', () => {
    expect(
      configEquals(
        { site: { siteName: 'A', separator: '|' }, tables: { a: { titleTemplate: 't' } } },
        { tables: { a: { titleTemplate: 't' } }, site: { separator: '|', siteName: 'A' } },
      ),
    ).toBe(true)
    expect(configEquals({ site: { siteName: 'A' } }, { site: { siteName: 'B' } })).toBe(false)
  })
})

describe('template preview', () => {
  test('sample vars fall back to placeholders and default separator', () => {
    expect(sampleTemplateVars(emptyConfigForm())).toEqual({
      title: 'Sample Page',
      site: 'My Site',
      sep: '-',
      slug: 'sample-page',
    })
  })

  test('uses the form values when present', () => {
    const state = form({ siteName: 'Acme', separator: '|' })
    expect(previewTemplate('%title% %sep% %site%', state)).toBe('Sample Page | Acme')
  })

  test('empty template previews as empty string', () => {
    expect(previewTemplate('   ', emptyConfigForm())).toBe('')
  })

  test('sample vars are always non-empty, so separators render literally', () => {
    // Separator collapse only fires when a variable renders EMPTY
    // (templateEngine's hadEmptyVariable); the sample vars always supply
    // placeholders, so a trailing %sep% stays visible in the preview.
    expect(previewTemplate('%title% %sep%', form({ separator: '|' }))).toBe('Sample Page |')
  })
})

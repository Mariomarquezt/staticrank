import { describe, expect, test } from 'bun:test'
import {
  applyFormToMeta,
  formFromMeta,
  isMetaDirty,
  metaEquals,
  mergeMetaFormAfterSave,
  normalizeKeywords,
  planMetaClear,
  scoredFreeKeywords,
  planMetaSave,
} from '../metaForm'
import type { SeoMetaPayload } from '../../../server/seoMeta'

describe('formFromMeta', () => {
  test('absent fields read as empty strings', () => {
    expect(formFromMeta({})).toEqual({ title: '', metaDescription: '', focusKeywords: [] })
  })

  test('present fields pass through', () => {
    expect(formFromMeta({ title: 'T', metaDescription: 'D' })).toEqual({
      title: 'T',
      metaDescription: 'D',
      focusKeywords: [],
    })
  })
})

describe('applyFormToMeta', () => {
  test('preserves fields the panel does not edit (full-replace safety)', () => {
    const existing: SeoMetaPayload = {
      title: 'Old',
      canonical: '/canon',
      robots: { noindex: true },
      ogImage: 'https://x.test/img.png',
      twitterCard: 'summary',
    }
    const next = applyFormToMeta(existing, { title: 'New', metaDescription: 'Desc', focusKeywords: [] })
    expect(next).toEqual({
      title: 'New',
      metaDescription: 'Desc',
      canonical: '/canon',
      robots: { noindex: true },
      ogImage: 'https://x.test/img.png',
      twitterCard: 'summary',
    })
  })

  test('empty / whitespace-only values remove the field', () => {
    const next = applyFormToMeta(
      { title: 'Old', metaDescription: 'Old desc', canonical: '/c' },
      { title: '', metaDescription: '   ', focusKeywords: [] },
    )
    expect(next).toEqual({ canonical: '/c' })
  })

  test('does not mutate the existing payload', () => {
    const existing: SeoMetaPayload = { title: 'Old' }
    applyFormToMeta(existing, { title: '', metaDescription: 'x', focusKeywords: [] })
    expect(existing).toEqual({ title: 'Old' })
  })

  test('normalizes an empty robots object away', () => {
    const next = applyFormToMeta({ robots: {} }, { title: 'T', metaDescription: '', focusKeywords: [] })
    expect(next).toEqual({ title: 'T' })
  })
})

describe('metaEquals', () => {
  test('order-insensitive equality', () => {
    expect(
      metaEquals(
        { title: 'T', robots: { noindex: true, nofollow: false } },
        { robots: { nofollow: false, noindex: true }, title: 'T' },
      ),
    ).toBe(true)
  })

  test('detects differences', () => {
    expect(metaEquals({ title: 'A' }, { title: 'B' })).toBe(false)
    expect(metaEquals({}, { title: 'B' })).toBe(false)
  })

  test('undefined-valued keys equal absent keys', () => {
    expect(metaEquals({ title: undefined }, {})).toBe(true)
  })
})

describe('planMetaSave', () => {
  test('unchanged form → noop', () => {
    const existing: SeoMetaPayload = { title: 'T', canonical: '/c' }
    expect(planMetaSave(existing, { title: 'T', metaDescription: '', focusKeywords: [] })).toEqual({ kind: 'noop' })
    expect(isMetaDirty(existing, { title: 'T', metaDescription: '', focusKeywords: [] })).toBe(false)
  })

  test('edits → post with the FULL grafted payload', () => {
    const existing: SeoMetaPayload = { title: 'T', canonical: '/c' }
    const plan = planMetaSave(existing, { title: 'T2', metaDescription: 'D', focusKeywords: [] })
    expect(plan).toEqual({
      kind: 'post',
      payload: { title: 'T2', metaDescription: 'D', canonical: '/c' },
    })
  })

  test('clearing the only stored fields → delete (never an empty POST)', () => {
    const existing: SeoMetaPayload = { title: 'T', metaDescription: 'D' }
    expect(planMetaSave(existing, { title: '', metaDescription: '', focusKeywords: [] })).toEqual({ kind: 'delete' })
  })

  test('clearing panel fields with other overrides stored → post, not delete', () => {
    const existing: SeoMetaPayload = { title: 'T', canonical: '/c' }
    expect(planMetaSave(existing, { title: '', metaDescription: '', focusKeywords: [] })).toEqual({
      kind: 'post',
      payload: { canonical: '/c' },
    })
  })

  test('nothing stored and empty form → noop', () => {
    expect(planMetaSave({}, { title: '', metaDescription: '', focusKeywords: [] })).toEqual({ kind: 'noop' })
  })

  test('LOST-UPDATE REGRESSION: planning against the FRESH payload keeps a concurrent canonical change', () => {
    // Panel loaded { title:'T', canonical:'/old' }; admin B then changed
    // the canonical to '/new'. A's save plans against the REFETCHED fresh
    // payload — B's canonical must survive the graft, never revert.
    const fresh: SeoMetaPayload = { title: 'T', canonical: '/new' }
    const plan = planMetaSave(fresh, { title: 'T-edited', metaDescription: '', focusKeywords: [] })
    expect(plan).toEqual({
      kind: 'post',
      payload: { title: 'T-edited', canonical: '/new' },
    })
  })
})

describe('dirty graft — only edited panel fields are written (t4-31)', () => {
  const baseline = { title: 'A-title', metaDescription: 'A-desc', focusKeywords: ['a-kw'] }

  test("admin A's description save does NOT revert admin B's title", () => {
    // A loaded the panel (baseline), B then changed the title; A edits
    // only the description. Without the baseline the graft writes A's
    // stale title over B's.
    const fresh: SeoMetaPayload = {
      title: 'B-title',
      metaDescription: 'A-desc',
      focusKeywords: ['a-kw'],
    }
    const form = { ...baseline, metaDescription: 'A-desc-edited' }
    expect(planMetaSave(fresh, form, baseline)).toEqual({
      kind: 'post',
      payload: {
        title: 'B-title',
        metaDescription: 'A-desc-edited',
        focusKeywords: ['a-kw'],
      },
    })
  })

  test("B's concurrent keyword list survives an untouched keyword field", () => {
    const fresh: SeoMetaPayload = { title: 'A-title', focusKeywords: ['b-kw-1', 'b-kw-2'] }
    const form = { ...baseline, title: 'A-title-edited' }
    expect(applyFormToMeta(fresh, form, baseline)).toEqual({
      title: 'A-title-edited',
      focusKeywords: ['b-kw-1', 'b-kw-2'],
    })
  })

  test('a CLEARED field is still dirty — clearing removes it from the payload', () => {
    const fresh: SeoMetaPayload = { title: 'A-title', metaDescription: 'B-desc' }
    const form = { ...baseline, title: '   ' }
    expect(applyFormToMeta(fresh, form, baseline)).toEqual({ metaDescription: 'B-desc' })
  })

  test('nothing edited → the fresh payload is returned untouched (noop plan)', () => {
    const fresh: SeoMetaPayload = { title: 'B-title', metaDescription: 'B-desc', canonical: '/c' }
    expect(planMetaSave(fresh, baseline, baseline)).toEqual({ kind: 'noop' })
  })

  test('omitting the baseline keeps the graft-everything behavior (preview path)', () => {
    const fresh: SeoMetaPayload = { title: 'B-title' }
    expect(applyFormToMeta(fresh, baseline)).toEqual({
      title: 'A-title',
      metaDescription: 'A-desc',
      focusKeywords: ['a-kw'],
    })
  })

  test('a keyword reorder counts as an edit (list compared positionally)', () => {
    const form = { ...baseline, focusKeywords: ['b-kw', 'a-kw'] }
    const fresh: SeoMetaPayload = { focusKeywords: ['server-kw'] }
    expect(applyFormToMeta(fresh, form, baseline)).toEqual({ focusKeywords: ['b-kw', 'a-kw'] })
  })
})

describe('mergeMetaFormAfterSave', () => {
  test('keeps fields typed while the save was in flight', () => {
    const savedForm = { title: 'Foo', metaDescription: 'D', focusKeywords: ['coffee'] }
    const typedDuringSave = {
      title: 'FooBar',
      metaDescription: 'D',
      focusKeywords: ['coffee', 'beans'],
    }
    expect(mergeMetaFormAfterSave({ title: 'Foo', metaDescription: 'D' }, savedForm, typedDuringSave)).toEqual(
      typedDuringSave,
    )
  })

  test('uses the server-normalized value for fields unchanged during the save', () => {
    const savedForm = { title: 'Foo', metaDescription: 'D', focusKeywords: ['coffee'] }
    const currentForm = { title: 'Foo', metaDescription: 'D', focusKeywords: ['coffee'] }
    expect(mergeMetaFormAfterSave({ title: 'Foo', focusKeywords: ['coffee beans'] }, savedForm, currentForm)).toEqual(
      { title: 'Foo', metaDescription: '', focusKeywords: ['coffee beans'] },
    )
  })
})

describe('planMetaClear (panel-owned fields only)', () => {
  test('other stored fields survive as a POST of the remainder', () => {
    const fresh: SeoMetaPayload = {
      title: 'T',
      metaDescription: 'D',
      canonical: '/c',
      robots: { noindex: true },
    }
    expect(planMetaClear(fresh)).toEqual({
      kind: 'post',
      payload: { canonical: '/c', robots: { noindex: true } },
    })
  })

  test('DELETE only when the fresh record holds nothing besides panel fields', () => {
    expect(planMetaClear({ title: 'T', metaDescription: 'D' })).toEqual({ kind: 'delete' })
    expect(planMetaClear({ title: 'T' })).toEqual({ kind: 'delete' })
  })

  test('record already free of panel fields → noop (nothing to clear)', () => {
    expect(planMetaClear({ canonical: '/c' })).toEqual({ kind: 'noop' })
    expect(planMetaClear({})).toEqual({ kind: 'noop' })
  })

  test('LOST-UPDATE REGRESSION: clearing against the FRESH payload keeps a concurrent OG change', () => {
    // Panel loaded { title:'T' } (would have DELETEd); B stored an ogImage
    // meanwhile. Clearing against the fresh payload must POST the
    // remainder, not DELETE B's field.
    const fresh: SeoMetaPayload = { title: 'T', ogImage: 'https://x.test/b.png' }
    expect(planMetaClear(fresh)).toEqual({
      kind: 'post',
      payload: { ogImage: 'https://x.test/b.png' },
    })
  })
})

describe('focusKeywords (panel-owned since task 2.5)', () => {
  test('formFromMeta copies the stored list (never aliases it)', () => {
    const meta: SeoMetaPayload = { focusKeywords: ['a', 'b'] }
    const form = formFromMeta(meta)
    expect(form.focusKeywords).toEqual(['a', 'b'])
    form.focusKeywords.push('c')
    expect(meta.focusKeywords).toEqual(['a', 'b'])
  })

  test('normalizeKeywords trims, drops empties, dedupes (first wins), keeps order', () => {
    expect(normalizeKeywords(['  a  ', '', '   ', 'b', 'a', 'b'])).toEqual(['a', 'b'])
  })

  test('graft stores the normalized list', () => {
    const next = applyFormToMeta(
      { canonical: '/c' },
      { title: '', metaDescription: '', focusKeywords: [' coffee beans ', 'coffee beans', 'mugs'] },
    )
    expect(next).toEqual({ canonical: '/c', focusKeywords: ['coffee beans', 'mugs'] })
  })

  test('an all-empty keyword list removes the field (no empty arrays stored)', () => {
    const next = applyFormToMeta(
      { focusKeywords: ['old'], canonical: '/c' },
      { title: '', metaDescription: '', focusKeywords: ['   '] },
    )
    expect(next).toEqual({ canonical: '/c' })
  })

  test('keyword-only edit marks the form dirty and plans a POST', () => {
    const existing: SeoMetaPayload = { title: 'T' }
    const form = { title: 'T', metaDescription: '', focusKeywords: ['coffee'] }
    expect(isMetaDirty(existing, form)).toBe(true)
    expect(planMetaSave(existing, form)).toEqual({
      kind: 'post',
      payload: { title: 'T', focusKeywords: ['coffee'] },
    })
  })

  test('clearing keywords when they are the only stored field → delete', () => {
    expect(
      planMetaSave({ focusKeywords: ['coffee'] }, { title: '', metaDescription: '', focusKeywords: [] }),
    ).toEqual({ kind: 'delete' })
  })

  test('planMetaClear clears keywords too; other fields survive', () => {
    expect(planMetaClear({ focusKeywords: ['a'], canonical: '/c' })).toEqual({
      kind: 'post',
      payload: { canonical: '/c' },
    })
    expect(planMetaClear({ title: 'T', focusKeywords: ['a'] })).toEqual({ kind: 'delete' })
  })

  test('focusKeywords are PANEL-OWNED: the graft writes the form list verbatim', () => {
    // Panel-owned fields follow the form, not the fresh payload — same
    // semantics as title/metaDescription (a concurrent keyword edit by
    // another admin is last-write-wins, like a concurrent title edit; only
    // NON-panel fields are protected by the refetch-then-graft discipline).
    const fresh: SeoMetaPayload = { title: 'T', focusKeywords: ['theirs'], canonical: '/c' }
    const plan = planMetaSave(fresh, {
      title: 'T',
      metaDescription: '',
      focusKeywords: ['mine'],
    })
    expect(plan).toEqual({
      kind: 'post',
      payload: { title: 'T', focusKeywords: ['mine'], canonical: '/c' },
    })
  })
})

describe('normalizeKeywords server-contract dedupe (NFC + toLowerCase compare keys)', () => {
  test("['SEO','seo','é'(composed),'e+combining accent'] → first originals kept", () => {
    // 'é' composed (U+00E9) vs 'e' + U+0301 — NFC-equal, so the second is
    // a duplicate; 'SEO' vs 'seo' — case-insensitively equal. First
    // occurrence is kept as the display value, order preserved.
    expect(normalizeKeywords(['SEO', 'seo', 'é', 'é'])).toEqual(['SEO', 'é'])
  })

  test('round-trip stability: normalizing a normalized list is identity', () => {
    const once = normalizeKeywords(['  Café  ', 'café', 'beans'])
    expect(once).toEqual(['Café', 'beans'])
    expect(normalizeKeywords(once)).toEqual(once)
  })
})

describe('scoredFreeKeywords (free-tier slot slicing)', () => {
  test('only the PRIMARY slot is scored', () => {
    expect(scoredFreeKeywords(['coffee', 'pro-extra'])).toEqual(['coffee'])
    expect(scoredFreeKeywords(['  coffee  '])).toEqual(['coffee'])
  })

  test('empty primary scores NOTHING even when Pro extras exist (no compaction into the slot)', () => {
    expect(scoredFreeKeywords([])).toEqual([])
    expect(scoredFreeKeywords(['', 'pro-extra'])).toEqual([])
    expect(scoredFreeKeywords(['   ', 'pro-extra'])).toEqual([])
  })

  test('save with an empty primary preserves the extras verbatim in the payload', () => {
    // Scoring slices by slot; SAVING never slices — the graft keeps the
    // whole normalized list, so clearing the primary input must not drop
    // (or reorder) the Pro extras.
    const plan = planMetaSave(
      { focusKeywords: ['old-primary', 'extra-b', 'extra-c'] },
      { title: '', metaDescription: '', focusKeywords: ['', 'extra-b', 'extra-c'] },
    )
    expect(plan).toEqual({ kind: 'post', payload: { focusKeywords: ['extra-b', 'extra-c'] } })
  })
})

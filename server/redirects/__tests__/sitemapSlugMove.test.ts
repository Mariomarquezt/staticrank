/**
 * Wave 3.3 slice A — the `onSlugMove` observation hook threaded through
 * `planSitemapWrite` (server/sitemap.ts). Lives here (not in
 * server/__tests__/sitemap.test.ts) because slice A owns only
 * server/redirects/__tests__ + the sitemap.ts edit.
 */

import { describe, expect, test } from 'bun:test'

import { planSitemapWrite, type PageStash, type SitemapEntry } from '../../sitemap'

const NOW = '2026-08-15T12:00:00.000Z'

function stash(overrides: Partial<PageStash> = {}): PageStash {
  return { slug: 'about', noindex: false, fp: 'aaaa1111', ...overrides }
}

function existing(overrides: Partial<SitemapEntry> = {}): SitemapEntry {
  return { pageId: 'p1', slug: 'about', fp: 'aaaa1111', ...overrides }
}

function capture() {
  const moves: Array<{ pageId: string; fromSlug: string; toSlug: string }> = []
  const onSlugMove = async (move: { pageId: string; fromSlug: string; toSlug: string }) => {
    moves.push(move)
  }
  return { moves, onSlugMove }
}

describe('planSitemapWrite onSlugMove', () => {
  test('fires exactly once on a real slug change, with the old and new slug', () => {
    const { moves, onSlugMove } = capture()
    const plan = planSitemapWrite(existing(), 'p1', stash({ slug: 'about-us' }), NOW, onSlugMove)
    expect(plan.action).toBe('write')
    expect(moves).toEqual([{ pageId: 'p1', fromSlug: 'about', toSlug: 'about-us' }])
  })

  test('does NOT fire when the slug is unchanged (even when content changed)', () => {
    const { moves, onSlugMove } = capture()
    planSitemapWrite(existing(), 'p1', stash(), NOW, onSlugMove) // no change at all
    planSitemapWrite(existing(), 'p1', stash({ fp: 'bbbb2222' }), NOW, onSlugMove) // fp-only change
    planSitemapWrite(existing(), 'p1', stash({ title: 'New title' }), NOW, onSlugMove)
    expect(moves).toEqual([])
  })

  test('does NOT fire for a brand-new page (no stored slug to move from)', () => {
    const { moves, onSlugMove } = capture()
    const plan = planSitemapWrite(undefined, 'p1', stash(), NOW, onSlugMove)
    expect(plan.action).toBe('write')
    expect(moves).toEqual([])
  })

  test('does NOT fire on the noindex delete path', () => {
    const { moves, onSlugMove } = capture()
    const plan = planSitemapWrite(
      existing(),
      'p1',
      stash({ slug: 'renamed', noindex: true }),
      NOW,
      onSlugMove,
    )
    expect(plan).toEqual({ action: 'delete' })
    expect(moves).toEqual([])
  })

  test('a synchronously-throwing callback never escapes', () => {
    const plan = planSitemapWrite(
      existing(),
      'p1',
      stash({ slug: 'about-us' }),
      NOW,
      () => {
        throw new Error('boom')
      },
    )
    expect(plan.action).toBe('write')
  })

  test('a rejecting callback never surfaces an unhandled rejection', async () => {
    let rejected = false
    const plan = planSitemapWrite(existing(), 'p1', stash({ slug: 'about-us' }), NOW, async () => {
      rejected = true
      throw new Error('storage down')
    })
    expect(plan.action).toBe('write')
    // Let the swallowed rejection settle — an unhandled rejection would
    // fail the bun test run on its own.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rejected).toBe(true)
  })

  test('the plan itself is unchanged by the callback (same verdict without it)', () => {
    const withCallback = planSitemapWrite(existing(), 'p1', stash({ slug: 'moved' }), NOW, async () => {})
    const withoutCallback = planSitemapWrite(existing(), 'p1', stash({ slug: 'moved' }), NOW)
    expect(withCallback).toEqual(withoutCallback)
  })
})

import { describe, expect, test } from 'bun:test'
import {
  SERIALIZED_HTML_MAX,
  SERIALIZE_DEPTH_MAX,
  serializePageContent,
  type ContentTree,
} from '../pageContent'
import { analyzeContent, extractTextFromHtml } from '../../../server/lib/analysis'

function node(
  moduleId: string,
  props: Record<string, unknown> = {},
  children: string[] = [],
  extra: Record<string, unknown> = {},
) {
  return { moduleId, props, children, ...extra }
}

function tree(nodes: ContentTree['nodes'], rootNodeId = 'root'): ContentTree {
  return { nodes, rootNodeId }
}

function htmlOf(t: ContentTree): string {
  const serialized = serializePageContent(t)
  expect(serialized).not.toBe(null)
  return (serialized as NonNullable<typeof serialized>).html
}

describe('serializePageContent', () => {
  test('missing root → null (degrade signal)', () => {
    expect(serializePageContent(tree({}, 'nope'))).toBe(null)
    expect(
      serializePageContent({ nodes: { root: node('base.body') }, rootNodeId: 'gone' }),
    ).toBe(null)
  })

  test('empty page serializes to empty html + partial:false, not null', () => {
    expect(serializePageContent(tree({ root: node('base.body') }))).toEqual({
      html: '',
      partial: false,
      skippedCount: 0,
    })
  })

  test('plain page: complete serialization reports partial:false', () => {
    const serialized = serializePageContent(
      tree({
        root: node('base.body', {}, ['h', 'p']),
        h: node('base.text', { text: 'Coffee guide', tag: 'h1' }),
        p: node('base.text', { text: 'All about beans.', tag: 'p' }),
      }),
    )
    expect(serialized).toEqual({
      html: '<div><h1>Coffee guide</h1><p>All about beans.</p></div>',
      partial: false,
      skippedCount: 0,
    })
  })

  test('unknown / missing tag falls back to <p>', () => {
    expect(
      htmlOf(
        tree({
          root: node('base.body', {}, ['a']),
          a: node('base.text', { text: 'x', tag: 'marquee' }),
        }),
      ),
    ).toBe('<div><p>x</p></div>')
  })

  test('tag:"none" is bare text with NO invented boundary — adjacent bare nodes fuse (publisher parity)', () => {
    const html = htmlOf(
      tree({
        root: node('base.body', {}, ['a', 'b']),
        a: node('base.text', { text: 'best', tag: 'none' }),
        b: node('base.text', { text: 'coffee', tag: 'none' }),
      }),
    )
    expect(html).toBe('<div>bestcoffee</div>')
    expect(extractTextFromHtml(html)).toBe('bestcoffee')
  })

  test('text content is HTML-escaped and newlines become <br>', () => {
    expect(
      htmlOf(
        tree({
          root: node('base.body', {}, ['t']),
          t: node('base.text', { text: 'a <b> & "c"\nnext', tag: 'p' }),
        }),
      ),
    ).toBe('<div><p>a &lt;b&gt; &amp; &quot;c&quot;<br>next</p></div>')
  })

  test('list splits items per line (trim, drop blanks), ordered vs unordered', () => {
    expect(
      htmlOf(
        tree({
          root: node('base.body', {}, ['l']),
          l: node('base.list', { items: ' one \n\n two ', listType: 'ordered' }),
        }),
      ),
    ).toBe('<div><ol><li>one</li><li>two</li></ol></div>')
  })

  test('link renders CHILDREN first; props.text is only the childless fallback', () => {
    expect(
      htmlOf(
        tree({
          root: node('base.body', {}, ['a', 'b']),
          a: node('base.link', { href: '/about', text: 'fallback ignored' }, ['inner']),
          inner: node('base.text', { text: 'From child', tag: 'none' }),
          b: node('base.link', { href: '/contact', text: 'From prop' }),
        }),
      ),
    ).toBe('<div><a href="/about">From child</a><a href="/contact">From prop</a></div>')
  })

  test('button emits an anchor with href, a span without', () => {
    expect(
      htmlOf(
        tree({
          root: node('base.body', {}, ['b', 'c']),
          b: node('base.button', { label: 'Go', href: 'https://x.test/p' }),
          c: node('base.button', { label: 'Submit', href: '' }),
        }),
      ),
    ).toBe('<div><a href="https://x.test/p">Go</a><span>Submit</span></div>')
  })

  test('image emits src only (alt is unknowable from the tree); empty src skipped', () => {
    expect(
      htmlOf(
        tree({
          root: node('base.body', {}, ['i', 'j']),
          i: node('base.image', { src: '/uploads/a.jpg' }),
          j: node('base.image', { src: '' }),
        }),
      ),
    ).toBe('<div><img src="/uploads/a.jpg"></div>')
  })

  test('hidden nodes are skipped (publisher parity)', () => {
    expect(
      htmlOf(
        tree({
          root: node('base.body', {}, ['a', 'b']),
          a: node('base.text', { text: 'visible', tag: 'p' }),
          b: node('base.text', { text: 'invisible', tag: 'p' }, [], { hidden: true }),
        }),
      ),
    ).toBe('<div><p>visible</p></div>')
  })

  test('VC ref: slot-fill content IS analyzed, the VC itself counts as skipped', () => {
    const serialized = serializePageContent(
      tree({
        root: node('base.body', {}, ['vc']),
        vc: node('base.visual-component-ref', { vcId: 'vc-1' }, ['slot']),
        slot: node('base.slot-instance', { slotName: 'children' }, ['fill'], { locked: true }),
        fill: node('base.text', { text: 'Slot fill copy', tag: 'p' }),
      }),
    )
    expect(serialized).toEqual({
      html: '<div><div><div><p>Slot fill copy</p></div></div></div>',
      partial: true,
      skippedCount: 1,
    })
  })

  test('loop nodes are skipped entirely and counted (unbound template must not score)', () => {
    const serialized = serializePageContent(
      tree({
        root: node('base.body', {}, ['loop', 't']),
        loop: node('base.loop', { tableSlug: 'posts' }, ['tpl']),
        tpl: node('base.text', { text: 'TEMPLATE %title%', tag: 'p' }),
        t: node('base.text', { text: 'real', tag: 'p' }),
      }),
    )
    expect(serialized).toEqual({
      html: '<div><p>real</p></div>',
      partial: true,
      skippedCount: 1,
    })
  })

  test('unknown modules with children are skipped + counted; childless/known leaves are silent', () => {
    const serialized = serializePageContent(
      tree({
        root: node('base.body', {}, ['custom', 'svg', 'mystery']),
        custom: node('acme.hero', { headline: 'never analyzed' }, ['inner']),
        inner: node('base.text', { text: 'inside custom', tag: 'p' }),
        svg: node('base.svg', { markup: '<svg/>' }),
        mystery: node('acme.widget', {}),
      }),
    )
    expect(serialized).toEqual({ html: '', partial: true, skippedCount: 1 })
  })

  test('missing child ids and cycles never loop or throw', () => {
    expect(
      htmlOf(
        tree({
          root: node('base.body', {}, ['ghost', 'loopback', 't']),
          loopback: node('base.container', {}, ['root']), // cycle back to root
          t: node('base.text', { text: 'safe', tag: 'p' }),
        }),
      ),
    ).toBe('<div><p>safe</p></div>')
  })

  // ── Bounds (round-5 t4-37): size ceiling, depth bound, data: srcs ──────

  test('data: image src is dropped but the <img> (and image count) stays', () => {
    const dataUri = `data:image/png;base64,${'A'.repeat(5000)}`
    const serialized = serializePageContent(
      tree({
        root: node('base.body', {}, ['img']),
        img: node('base.image', { src: dataUri }),
      }),
    )
    expect(serialized).toEqual({ html: '<div><img></div>', partial: false, skippedCount: 0 })
    // The image still counts for the analysis — only the payload is gone.
    expect(analyzeContent({ html: htmlOf(tree({
      root: node('base.body', {}, ['img']),
      img: node('base.image', { src: dataUri }),
    })), focusKeywords: [] }).stats.imageCount).toBe(1)
  })

  test('data: detection tolerates leading whitespace and case', () => {
    expect(
      htmlOf(
        tree({
          root: node('base.body', {}, ['a', 'b']),
          a: node('base.image', { src: '  DATA:image/gif;base64,R0lGOD' }),
          b: node('base.image', { src: '/uploads/real.png' }),
        }),
      ),
    ).toBe('<div><img><img src="/uploads/real.png"></div>')
  })

  test('src and href attributes are bounded at URL_MAX (2000)', () => {
    const long = `/uploads/${'x'.repeat(4000)}.jpg`
    const html = htmlOf(
      tree({
        root: node('base.body', {}, ['img', 'l']),
        img: node('base.image', { src: long }),
        l: node('base.link', { href: long, text: 'go' }),
      }),
    )
    const src = /<img src="([^"]*)">/.exec(html)?.[1] ?? ''
    const href = /<a href="([^"]*)">/.exec(html)?.[1] ?? ''
    expect(src.length).toBe(2000)
    expect(href.length).toBe(2000)
  })

  test('output ceiling: a multi-megabyte text prop truncates instead of stalling', () => {
    const serialized = serializePageContent(
      tree({
        root: node('base.body', {}, ['small', 'huge', 'after']),
        small: node('base.text', { text: 'Readable intro.', tag: 'p' }),
        huge: node('base.text', { text: 'x'.repeat(SERIALIZED_HTML_MAX + 1), tag: 'p' }),
        after: node('base.text', { text: 'Trailing copy.', tag: 'p' }),
      }),
    )
    expect(serialized).not.toBe(null)
    const result = serialized as NonNullable<typeof serialized>
    expect(result.html.length).toBeLessThanOrEqual(SERIALIZED_HTML_MAX)
    expect(result.html).toContain('Readable intro.')
    // The oversized node and everything after it are reported, not silently
    // dropped — one cut, one skipped section.
    expect(result.html).not.toContain('Trailing copy.')
    expect(result.partial).toBe(true)
    expect(result.skippedCount).toBe(1)
  })

  test('output ceiling: many medium nodes stop at the ceiling, keeping what fits', () => {
    const nodes: ContentTree['nodes'] = { root: node('base.body', {}, []) }
    const childIds: string[] = []
    for (let i = 0; i < 400; i++) {
      const id = `n${i}`
      childIds.push(id)
      nodes[id] = node('base.text', { text: 'y'.repeat(1000), tag: 'p' })
    }
    nodes.root = node('base.body', {}, childIds)
    const result = serializePageContent({ nodes, rootNodeId: 'root' })
    expect(result).not.toBe(null)
    const out = result as NonNullable<typeof result>
    expect(out.html.length).toBeLessThanOrEqual(SERIALIZED_HTML_MAX)
    expect(out.partial).toBe(true)
    expect(out.skippedCount).toBe(1)
    // Everything that fit is still analyzable content, not a torn tag. The
    // root wrapper <div> is what gets dropped when the ceiling lands on it
    // — the children already paid for themselves and are kept verbatim.
    expect(out.html.startsWith('<p>yyy')).toBe(true)
    expect(out.html.endsWith('</p>')).toBe(true)
    expect(extractTextFromHtml(out.html).includes('<')).toBe(false)
  })

  test('depth bound: a pathological container chain degrades, never RangeErrors', () => {
    const nodes: ContentTree['nodes'] = {}
    const CHAIN = SERIALIZE_DEPTH_MAX + 200
    for (let i = 0; i < CHAIN; i++) {
      nodes[`c${i}`] = node('base.container', {}, [`c${i + 1}`])
    }
    nodes[`c${CHAIN}`] = node('base.text', { text: 'too deep to read', tag: 'p' })
    const result = serializePageContent({ nodes, rootNodeId: 'c0' })
    expect(result).not.toBe(null)
    const out = result as NonNullable<typeof result>
    // The deepest text never serializes; the bail is reported, not hidden.
    expect(out.html).not.toContain('too deep to read')
    expect(out.partial).toBe(true)
    expect(out.skippedCount).toBeGreaterThan(0)
  })

  test('depth bound does not fire on ordinary nesting', () => {
    const nodes: ContentTree['nodes'] = {}
    for (let i = 0; i < 40; i++) nodes[`c${i}`] = node('base.container', {}, [`c${i + 1}`])
    nodes.c40 = node('base.text', { text: 'still fine', tag: 'p' })
    expect(serializePageContent({ nodes, rootNodeId: 'c0' })?.partial).toBe(false)
    expect(serializePageContent({ nodes, rootNodeId: 'c0' })?.html).toContain('still fine')
  })

  // Round-5 wave-2 O#3 — the ceiling is charged against the ESCAPED
  // string, so before the clamp a huge escapable prop was fully expanded
  // (5-6x) and only THEN rejected. These cases assert the two things that
  // matter: the emitted result is unchanged, and the work is proportional
  // to the ceiling instead of to the input.
  describe('escaping is budget-aware, not input-proportional', () => {
    /** ~20M chars, every one of which escapes to 5 (`&` → `&amp;`). */
    const HUGE = '&'.repeat(20_000_000)

    test('a 20M-character escapable text node is rejected without expanding it', () => {
      const started = Date.now()
      const serialized = serializePageContent(
        tree({
          root: node('base.body', {}, ['small', 'huge', 'after']),
          small: node('base.text', { text: 'Readable intro.', tag: 'p' }),
          huge: node('base.text', { text: HUGE, tag: 'p' }),
          after: node('base.text', { text: 'Trailing copy.', tag: 'p' }),
        }),
      )
      const elapsed = Date.now() - started

      // Identical verdict to the plain 'x'.repeat ceiling case above: the
      // clamp must change the COST, never the OUTPUT.
      const result = serialized as NonNullable<typeof serialized>
      expect(result.html).toContain('Readable intro.')
      expect(result.html).not.toContain('&amp;')
      expect(result.html).not.toContain('Trailing copy.')
      expect(result.partial).toBe(true)
      expect(result.skippedCount).toBe(1)
      // Measured on this machine: escaping the whole node costs ~540 ms
      // (~100M characters built across four sequential passes), clamping
      // first ~7 ms. The bound sits ~28x above the fixed path and ~2.7x
      // below the broken one, so it is a real assertion, not a stopwatch.
      expect(elapsed).toBeLessThan(200)
    })

    test('a 20M-character list item is rejected without expanding it', () => {
      const started = Date.now()
      const serialized = serializePageContent(
        tree({
          root: node('base.body', {}, ['l']),
          l: node('base.list', { items: `ok\n${HUGE}` }),
        }),
      )
      const elapsed = Date.now() - started
      const result = serialized as NonNullable<typeof serialized>
      expect(result.html).toBe('')
      expect(result.partial).toBe(true)
      expect(elapsed).toBeLessThan(200)
    })

    test('20M blank list lines are capped before splitting', () => {
      const blankLines = '\n'.repeat(20_000_000)
      const started = Date.now()
      const serialized = serializePageContent(
        tree({
          root: node('base.body', {}, ['l']),
          l: node('base.list', { items: blankLines }),
        }),
      )
      const elapsed = Date.now() - started

      expect(serialized).toEqual({ html: '', partial: false, skippedCount: 0 })
      expect(elapsed).toBeLessThan(200)
    })

    test('a value that FITS is still escaped in full (clamp changes nothing)', () => {
      const text = '&'.repeat(1000)
      const html = htmlOf(
        tree({
          root: node('base.body', {}, ['t']),
          t: node('base.text', { text, tag: 'p' }),
        }),
      )
      expect(html).toBe(`<div><p>${'&amp;'.repeat(1000)}</p></div>`)
    })

    test('a list whose items fit is escaped and emitted in full', () => {
      const html = htmlOf(
        tree({
          root: node('base.body', {}, ['l']),
          l: node('base.list', { items: 'A & B\nC "D"' }),
        }),
      )
      expect(html).toBe('<div><ul><li>A &amp; B</li><li>C &quot;D&quot;</li></ul></div>')
    })

    test('blank list lines do not consume the output budget or drop later items', () => {
      const prefix = 'x'.repeat(SERIALIZED_HTML_MAX - 40)
      const serialized = serializePageContent(
        tree({
          root: node('base.body', {}, ['prefix', 'list']),
          prefix: node('base.text', { text: prefix, tag: 'none' }),
          list: node('base.list', { items: `A${'\n'.repeat(50)}B` }),
        }),
      )

      expect(serialized).toEqual({
        html: `<div>${prefix}<ul><li>A</li><li>B</li></ul></div>`,
        partial: false,
        skippedCount: 0,
      })
      expect(serialized?.html.length).toBe(SERIALIZED_HTML_MAX)
    })
  })

  test('serialized output round-trips through the analysis extractor', () => {
    const html = htmlOf(
      tree({
        root: node('base.body', {}, ['h', 'p1', 'img', 'l']),
        h: node('base.text', { text: 'Best coffee beans', tag: 'h2' }),
        p1: node('base.text', { text: 'Coffee beans taste great.', tag: 'p' }),
        img: node('base.image', { src: '/uploads/beans.jpg' }),
        l: node('base.link', { href: '/shop', text: 'Shop beans' }),
      }),
    )
    expect(extractTextFromHtml(html)).toBe(
      'Best coffee beans\nCoffee beans taste great.\nShop beans',
    )
    const result = analyzeContent({ html, focusKeywords: ['coffee beans'] })
    expect(result.stats.headingCount).toBe(1)
    expect(result.stats.imageCount).toBe(1)
    expect(result.stats.linkCount).toBe(1)
    const heading = result.checks.find((c) => c.id === 'keyword-in-heading')
    expect(heading?.status).toBe('good')
  })
})

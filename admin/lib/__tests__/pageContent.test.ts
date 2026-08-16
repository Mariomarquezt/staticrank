import { describe, expect, test } from 'bun:test'
import { serializePageContent, type ContentTree } from '../pageContent'
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

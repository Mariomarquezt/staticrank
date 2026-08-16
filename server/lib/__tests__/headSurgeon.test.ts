import { describe, expect, test } from 'bun:test'
import { applySeoHead, escapeAttr, escapeHtml, type SeoHeadPayload } from '../headSurgeon'

const BLOCK =
  '<link rel="canonical" href="https://example.com/page/">\n' +
  '<meta property="og:title" content="Page">\n' +
  '<script type="application/ld+json">{"@type":"WebPage"}</script>'

const PAYLOAD: SeoHeadPayload = {
  title: 'My Page — Site',
  metaDescription: 'A tidy description.',
  block: BLOCK,
}

function page(headInner: string, body = '<body><h1>Hi</h1></body>'): string {
  return `<!doctype html>\n<html>\n<head>\n${headInner}\n</head>\n${body}\n</html>`
}

/** Body region = everything from the first `</head>` onward. */
function tail(html: string): string {
  const i = html.search(/<\/head\s*>/i)
  return i === -1 ? html : html.slice(i)
}

describe('idempotency', () => {
  test('double apply without pre-existing block is byte-stable', () => {
    const input = page('<meta charset="utf-8">\n<title>Old</title>\n<meta name="description" content="old">')
    const once = applySeoHead(input, PAYLOAD)
    const twice = applySeoHead(once, PAYLOAD)
    expect(twice).toBe(once)
  })

  test('double apply with a pre-existing plugin block is byte-stable', () => {
    const input = page(
      '<title>Old</title>\n<!--seo:start-->\n<meta property="og:title" content="Stale">\n<!--seo:end-->\n<meta name="description" content="old">'
    )
    const once = applySeoHead(input, PAYLOAD)
    const twice = applySeoHead(once, PAYLOAD)
    expect(twice).toBe(once)
    // exactly one marker pair survives
    expect(once.split('<!--seo:start-->').length - 1).toBe(1)
    expect(once.split('<!--seo:end-->').length - 1).toBe(1)
    expect(once).not.toContain('Stale')
  })

  test('triple apply on a page with two stale seo marker blocks converges after one pass', () => {
    const input = page(
      '<!--seo:start-->\n<meta name="robots" content="stale-one">\n<!--seo:end-->\n' +
        '<title>Old</title>\n' +
        '<!--seo:start-->\n<meta name="robots" content="stale-two">\n<!--seo:end-->\n' +
        '<meta name="description" content="old">'
    )
    const once = applySeoHead(input, PAYLOAD)
    const twice = applySeoHead(once, PAYLOAD)
    const thrice = applySeoHead(twice, PAYLOAD)
    expect(twice).toBe(once)
    expect(thrice).toBe(once)
    expect(once).not.toContain('stale-one')
    expect(once).not.toContain('stale-two')
    expect(once.split('<!--seo:start-->').length - 1).toBe(1)
  })
})

describe('title handling', () => {
  test('replaces title text, tolerating attributes and multiline content', () => {
    const input = page('<title data-x="y">\n  Old\n  Title\n</title>')
    const out = applySeoHead(input, { title: 'New Title' })
    expect(out).toContain('<title data-x="y">New Title</title>')
    expect(out).not.toContain('Old')
  })

  test('escapes quotes, ampersands, a nested </title>, and passes unicode/emoji through', () => {
    const input = page('<title>Old</title>')
    const out = applySeoHead(input, {
      title: `Quotes "double" & 'single' </title> & Zoë 🚀 日本語`,
    })
    expect(out).toContain(
      '<title>Quotes &quot;double&quot; &amp; &#39;single&#39; &lt;/title&gt; &amp; Zoë 🚀 日本語</title>'
    )
    // the raw closing tag from the payload must never appear inside the title text
    expect(out.split('</title>').length - 1).toBe(1)
  })

  test('UPPERCASE <HEAD>/</HEAD> and <TITLE> are handled', () => {
    const input = `<HTML><HEAD><TITLE>Old</TITLE></HEAD><BODY>x</BODY></HTML>`
    const out = applySeoHead(input, PAYLOAD)
    expect(out).toContain(`<TITLE>${escapeHtml(PAYLOAD.title!)}</TITLE>`)
    expect(out).toContain('<!--seo:start-->')
    expect(out.indexOf('<!--seo:end-->')).toBeLessThan(out.indexOf('</HEAD>'))
    expect(tail(out)).toBe('</HEAD><BODY>x</BODY></HTML>')
  })

  test('missing <title>: fallback emitted inside the plugin block', () => {
    const input = page('<meta charset="utf-8">')
    const out = applySeoHead(input, { title: 'Fallback Title', block: BLOCK })
    const blockRegion = out.slice(out.indexOf('<!--seo:start-->'), out.indexOf('<!--seo:end-->'))
    expect(blockRegion).toContain('<title>Fallback Title</title>')
    // idempotent too
    expect(applySeoHead(out, { title: 'Fallback Title', block: BLOCK })).toBe(out)
  })

  test('undefined title leaves the existing title untouched', () => {
    const input = page('<title>Keep Me</title>')
    const out = applySeoHead(input, { metaDescription: 'x' })
    expect(out).toContain('<title>Keep Me</title>')
  })

  test('empty-string title sets an empty title', () => {
    const input = page('<title>Old</title>')
    const out = applySeoHead(input, { title: '' })
    expect(out).toContain('<title></title>')
  })
})

describe('meta description handling', () => {
  test('replaces content with quotes and angle brackets escaped, any attribute order/quoting', () => {
    const input = page(`<meta content='old' name=description>`)
    const out = applySeoHead(input, { metaDescription: `He said "hi" & <b>bold</b>` })
    expect(out).toContain(`content="He said &quot;hi&quot; &amp; &lt;b&gt;bold&lt;/b&gt;"`)
    expect(out).not.toContain("'old'")
  })

  test('first description meta wins; duplicates are removed', () => {
    const input = page(
      '<meta name="description" content="one">\n' +
        '<meta name="viewport" content="width=device-width">\n' +
        `<meta content="two" name='description'>\n` +
        '<meta name=description content=three>'
    )
    const out = applySeoHead(input, { metaDescription: 'fresh' })
    const head = out.slice(0, out.search(/<\/head\s*>/i))
    const descriptions = head.match(/<meta\b[^>]*\/?>/gi)!.filter((t) => /\bname\s*=\s*(?:"description"|'description'|description(?=[\s/>]))/i.test(t))
    expect(descriptions).toHaveLength(1)
    expect(descriptions[0]).toContain('content="fresh"')
    // unrelated meta survives
    expect(out).toContain('<meta name="viewport" content="width=device-width">')
    // idempotent
    expect(applySeoHead(out, { metaDescription: 'fresh' })).toBe(out)
  })

  test('description meta without a content attribute gets one added', () => {
    const input = page('<meta name="description">')
    const out = applySeoHead(input, { metaDescription: 'added' })
    expect(out).toContain('<meta name="description" content="added">')
  })

  test('missing description: fallback emitted inside the plugin block', () => {
    const input = page('<title>T</title>')
    const out = applySeoHead(input, { metaDescription: 'made fresh', block: BLOCK })
    const blockRegion = out.slice(out.indexOf('<!--seo:start-->'), out.indexOf('<!--seo:end-->'))
    expect(blockRegion).toContain('<meta name="description" content="made fresh">')
    expect(applySeoHead(out, { metaDescription: 'made fresh', block: BLOCK })).toBe(out)
  })

  test('undefined description leaves existing metas (even duplicates) untouched', () => {
    const input = page('<meta name="description" content="a">\n<meta name="description" content="b">')
    const out = applySeoHead(input, { title: 'x' })
    expect(out).toContain('content="a"')
    expect(out).toContain('content="b"')
  })

  test('og:description / twitter:description are NOT mistaken for the description meta', () => {
    const input = page(
      '<meta name="description" content="real">\n<meta property="og:description" content="og">\n<meta name="twitter:description" content="tw">'
    )
    const out = applySeoHead(input, { metaDescription: 'new' })
    expect(out).toContain('content="og"')
    expect(out).toContain('content="tw"')
    expect(out).toContain('content="new"')
  })
})

describe('plugin block', () => {
  test('block content is inserted verbatim immediately before </head>', () => {
    const input = page('<title>T</title>\n<meta name="description" content="d">')
    const out = applySeoHead(input, PAYLOAD)
    expect(out).toContain(`<!--seo:start-->\n${BLOCK}\n<!--seo:end-->\n</head>`)
  })

  test('no block and no fallbacks needed: no marker pair emitted, stale blocks still removed', () => {
    const input = page('<title>T</title>\n<!--seo:start-->\nstale\n<!--seo:end-->\n<meta name="description" content="d">')
    const out = applySeoHead(input, { title: 'New', metaDescription: 'nd' })
    expect(out).not.toContain('<!--seo:start-->')
    expect(out).not.toContain('stale')
  })

  test('empty-string block emits an empty marker pair (set-to-empty semantics)', () => {
    const input = page('<title>T</title>')
    const out = applySeoHead(input, { block: '' })
    expect(out).toContain('<!--seo:start-->\n<!--seo:end-->\n</head>')
    expect(applySeoHead(out, { block: '' })).toBe(out)
  })
})

describe('document boundaries', () => {
  test('document without a head returns the input unchanged', () => {
    const input = '<html><body><p>No head here.</p></body></html>'
    expect(applySeoHead(input, PAYLOAD)).toBe(input)
  })

  test('everything from </head> onward is byte-identical', () => {
    const body =
      '<body><h1>Hi</h1><p>a &amp; b <meta name="description" content="decoy"> ' +
      '<!--seo:start-->body-marker<!--seo:end--> <title>body title</title></p></body>'
    const input = page('<title>Old</title>\n<meta name="description" content="old">', body)
    const out = applySeoHead(input, PAYLOAD)
    expect(tail(out)).toBe(tail(input))
    // and the decoys in the body were not treated as head tags
    expect(out).toContain('content="decoy"')
    expect(out).toContain('body-marker')
  })
})

describe('escaping helpers', () => {
  test('escapeHtml covers the five significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
    expect(escapeHtml('plain ünïcode 🚀')).toBe('plain ünïcode 🚀')
  })

  test('escapeAttr prevents attribute breakout', () => {
    expect(escapeAttr('" onmouseover="x')).toBe('&quot; onmouseover=&quot;x')
  })
})

describe('adversarial regressions', () => {
  test('finding 1: String.replace replacement tokens in payload values are inert', () => {
    const input = page('<title>Old</title>\n<meta name="description" content="old" data-x="y">')
    const p: SeoHeadPayload = { title: 'A $& B $` C $\' D $$', metaDescription: '$` $$ $&' }
    const out = applySeoHead(input, p)
    // tokens land literally — no matched text, no preceding/following context, no dollar collapsing
    expect(out).toContain(`<title>A $&amp; B $\` C $&#39; D $$</title>`)
    expect(out).toContain(`content="$\` $$ $&amp;"`)
    expect(out).toContain('data-x="y"')
    expect(out).not.toContain('content="old"')
    expect(applySeoHead(out, p)).toBe(out)
  })

  test('finding 2: 10k orphan start markers stay linear and are left alone', () => {
    const orphans = '<!--seo:start-->\n'.repeat(10_000)
    const input = page(`<title>T</title>\n${orphans}<meta name="description" content="old">`)
    const start = performance.now()
    const once = applySeoHead(input, PAYLOAD)
    const twice = applySeoHead(once, PAYLOAD)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(500)
    // all 10k orphans survive; exactly one full block (ours) exists
    expect(once.split('<!--seo:start-->').length - 1).toBe(10_001)
    expect(once.split('<!--seo:end-->').length - 1).toBe(1)
    expect(twice).toBe(once)
  })

  test('finding 3: payload with no defined fields is a pure byte-identical no-op', () => {
    const input = page(
      '<!--seo:start-->\n<meta name="robots" content="stale">\n<!--seo:end-->\n<title>T</title>\n<meta name="description" content="d">\n<meta name="description" content="dup">'
    )
    expect(applySeoHead(input, {})).toBe(input)
  })

  test('finding 4: decoy title inside a comment is ignored, real title edited', () => {
    const input = page('<!-- <title>fake</title> -->\n<title>real</title>')
    const out = applySeoHead(input, { title: 'New' })
    expect(out).toContain('<!-- <title>fake</title> -->')
    expect(out).toContain('<title>New</title>')
    expect(out).not.toContain('<title>real</title>')
    expect(applySeoHead(out, { title: 'New' })).toBe(out)
  })

  test('finding 4: decoy description meta inside a script string is ignored', () => {
    const decoy = `var x = '<meta name="description" content="fake">';`
    const input = page(`<script>${decoy}</script>\n<meta name="description" content="real">`)
    const out = applySeoHead(input, { metaDescription: 'new' })
    expect(out).toContain(decoy) // script body untouched, not rewritten, not removed as duplicate
    expect(out).toContain('content="new"')
    expect(out).not.toContain('content="real"')
    expect(applySeoHead(out, { metaDescription: 'new' })).toBe(out)
  })

  test('finding 4: decoys in style and noscript are ignored too', () => {
    const input = page(
      '<style>/* <meta name="description" content="css"> */</style>\n' +
        '<noscript><meta name="description" content="ns"></noscript>\n' +
        '<meta name="description" content="real">'
    )
    const out = applySeoHead(input, { metaDescription: 'new' })
    expect(out).toContain('content="css"')
    expect(out).toContain('content="ns"')
    expect(out).toContain('content="new"')
    expect(out).not.toContain('content="real"')
  })

  test('finding 5: name=description inside another attribute value never matches', () => {
    const viewport = `<meta name="viewport" data="name=description content='fake'">`
    const input = page(`${viewport}\n<meta name="description" content="real">`)
    const out = applySeoHead(input, { metaDescription: 'clean' })
    expect(out).toContain(viewport) // byte-identical, data value NOT rewritten
    expect(out).toContain('content="clean"')
    expect(out).not.toContain('content="real"')
  })

  test('finding 5: unquoted attribute values containing "/" are parsed, not mangled', () => {
    const input = page('<meta name=description content=old/path data-keep=1>')
    const out = applySeoHead(input, { metaDescription: 'fresh' })
    expect(out).toContain('<meta name="description" content="fresh" data-keep="1">')
    expect(out).not.toContain('old/path')
    expect(applySeoHead(out, { metaDescription: 'fresh' })).toBe(out)
  })

  test('finding 6: literal marker strings inside payload.block are stripped, idempotency holds', () => {
    const trick = 'A<!--seo:end-->B<!--seo:start-->C'
    const p: SeoHeadPayload = { block: trick }
    const input = page('<title>T</title>\n<meta name="description" content="d">')
    const once = applySeoHead(input, p)
    expect(once).toContain('<!--seo:start-->\nABC\n<!--seo:end-->\n</head>')
    expect(once.split('<!--seo:start-->').length - 1).toBe(1)
    expect(once.split('<!--seo:end-->').length - 1).toBe(1)
    expect(applySeoHead(once, p)).toBe(once)
  })
})

describe('performance sanity', () => {
  test('a ~300KB document processes quickly', () => {
    const filler = Array.from(
      { length: 3000 },
      (_, i) => `<p class="row-${i}">Lorem ipsum dolor sit amet, consectetur adipiscing elit ${i}.</p>`
    ).join('\n')
    const headFiller = Array.from(
      { length: 200 },
      (_, i) => `<link rel="preload" href="/assets/chunk-${i}.css" as="style">`
    ).join('\n')
    const input = page(`<title>Big</title>\n${headFiller}\n<meta name="description" content="old">`, `<body>${filler}</body>`)
    expect(input.length).toBeGreaterThan(250_000)

    const start = performance.now()
    const once = applySeoHead(input, PAYLOAD)
    const twice = applySeoHead(once, PAYLOAD)
    const elapsed = performance.now() - start

    expect(twice).toBe(once)
    expect(tail(once)).toBe(tail(input))
    // generous sanity bound, not a benchmark
    expect(elapsed).toBeLessThan(1000)
  })
})

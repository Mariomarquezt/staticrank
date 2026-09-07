/**
 * Task 2.4 — CSP meta surgery for filter-injected inline scripts: hash
 * computation, script-src editing rules ('none' drop, dedupe, the
 * critical 'unsafe-inline' skip), meta rewriting, and the importmap
 * extraction feeding the G14 workaround.
 */

import { describe, expect, test } from 'bun:test'
import {
  addScriptSrcSources,
  allowInlineScripts,
  bytesToBase64,
  extractImportmapText,
  findCspMetas,
  patchPolicyScriptSrc,
  planInlineCsp,
  rewriteCspMetaContent,
  scriptHashSource,
  utf8Bytes,
} from '../cspPatch'

const CSP_META = (policy: string) =>
  `<meta http-equiv="Content-Security-Policy" content="${policy}">`

const DOC = (policy: string, body = '') =>
  `<!doctype html><html><head>${CSP_META(policy)}<title>t</title></head><body>${body}</body></html>`

describe('utf8Bytes / bytesToBase64', () => {
  test('matches TextEncoder for ASCII, BMP and astral text', () => {
    for (const text of ['hello', 'çäßé — ünïcode', '日本語', 'emoji 🎉 pair']) {
      expect([...utf8Bytes(text)]).toEqual([...new TextEncoder().encode(text)])
    }
  })

  test('base64 vectors', () => {
    expect(bytesToBase64(new TextEncoder().encode(''))).toBe('')
    expect(bytesToBase64(new TextEncoder().encode('f'))).toBe('Zg==')
    expect(bytesToBase64(new TextEncoder().encode('fo'))).toBe('Zm8=')
    expect(bytesToBase64(new TextEncoder().encode('foo'))).toBe('Zm9v')
    expect(bytesToBase64(new TextEncoder().encode('foobar'))).toBe('Zm9vYmFy')
  })
})

describe('scriptHashSource', () => {
  test('produces the CSP sha256 token of the exact script text', async () => {
    const text = 'window.__mwSeoAnalytics={"enabled":true};'
    const expectedDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    const expected = `'sha256-${bytesToBase64(new Uint8Array(expectedDigest))}'`
    expect(await scriptHashSource(text)).toBe(expected)
  })
})

describe('addScriptSrcSources', () => {
  test("drops the lone 'none' when adding sources", () => {
    expect(addScriptSrcSources("default-src 'self'; script-src 'none'", ["'sha256-X'"])).toBe(
      "default-src 'self'; script-src 'sha256-X'",
    )
  })

  test('appends to existing sources and dedupes (idempotent)', () => {
    const once = addScriptSrcSources("script-src 'self'", ["'sha256-X'"])
    expect(once).toBe("script-src 'self' 'sha256-X'")
    expect(addScriptSrcSources(once, ["'sha256-X'"])).toBe(once)
  })

  test("SKIPS entirely when 'unsafe-inline' is present (a hash would disable it)", () => {
    const policy = "script-src 'self' 'unsafe-inline'; style-src 'self'"
    expect(addScriptSrcSources(policy, ["'sha256-X'"])).toBe(policy)
  })

  test('matches CSP keyword source expressions case-insensitively', () => {
    const inline = "script-src 'self' 'UNSAFE-INLINE'"
    expect(addScriptSrcSources(inline, ["'sha256-X'"])).toBe(inline)
    expect(addScriptSrcSources("script-src 'NONE'", ["'sha256-X'"])).toBe(
      "script-src 'sha256-X'",
    )
  })

  test('NEVER creates a missing directive (review B2#3 — would strip the default-src fallback for external scripts)', () => {
    const policy = "default-src 'self'"
    expect(addScriptSrcSources(policy, ["'sha256-X'"])).toBe(policy)
    expect(patchPolicyScriptSrc(policy, ["'sha256-X'"])).toEqual({ policy, ok: false })
  })

  test('patchPolicyScriptSrc reports ok for patched and unsafe-inline policies', () => {
    expect(patchPolicyScriptSrc("script-src 'none'", ["'sha256-X'"])).toEqual({
      policy: "script-src 'sha256-X'", // 'none' REPLACED, never emitted alongside
      ok: true,
    })
    const inline = "script-src 'self' 'unsafe-inline'"
    expect(patchPolicyScriptSrc(inline, ["'sha256-X'"])).toEqual({ policy: inline, ok: true })
  })
})

describe('rewriteCspMetaContent / planInlineCsp', () => {
  test('rewrites only the CSP meta, leaves the rest byte-identical', () => {
    const doc = DOC("script-src 'self'")
    const out = rewriteCspMetaContent(doc, (p) => addScriptSrcSources(p, ["'sha256-X'"]))
    expect(out).toBe(DOC("script-src 'self' 'sha256-X'"))
  })

  test('null when no CSP meta exists; planInlineCsp mirrors that', () => {
    const doc = '<html><head><title>t</title></head><body></body></html>'
    expect(rewriteCspMetaContent(doc, (p) => p + ' x')).toBeNull()
    expect(planInlineCsp(doc)).toEqual({ mode: 'no-csp' })
    expect(planInlineCsp(DOC("script-src 'self'"))).toEqual({ mode: 'patch' })
  })

  test('unchanged policy returns the document unchanged', () => {
    const doc = DOC("script-src 'self' 'unsafe-inline'")
    expect(rewriteCspMetaContent(doc, (p) => addScriptSrcSources(p, ["'sha256-X'"]))).toBe(doc)
  })
})

describe('extractImportmapText', () => {
  test('captures the exact importmap body', () => {
    const body = '{"imports":{"lit":"/runtime/lit.js"}}'
    const doc = DOC("script-src 'self'", `<script type="importmap">${body}</script>`)
    expect(extractImportmapText(doc)).toBe(body)
    expect(extractImportmapText(DOC("script-src 'self'"))).toBeUndefined()
  })
})

describe('findCspMetas — serialization variants (review B2#3)', () => {
  test('attribute order: content BEFORE http-equiv', () => {
    const doc = `<head><meta content="script-src 'self'" http-equiv="Content-Security-Policy"></head>`
    const metas = findCspMetas(doc)
    expect(metas.length).toBe(1)
    expect(metas[0]!.policy).toBe("script-src 'self'")
  })

  test('single-quoted attributes and case-insensitive http-equiv value', () => {
    const doc = `<head><meta http-equiv='content-security-policy' content='script-src "x" self'></head>`
    const metas = findCspMetas(doc)
    expect(metas.length).toBe(1)
    expect(metas[0]!.policy).toBe('script-src "x" self')
  })

  test('multiple CSP metas are all found; non-CSP metas ignored', () => {
    const doc = `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'self'"><meta name="x" content="y"><meta content="script-src 'none'" http-equiv="CONTENT-SECURITY-POLICY"></head>`
    const metas = findCspMetas(doc)
    expect(metas.map((m) => m.policy)).toEqual(["script-src 'self'", "script-src 'none'"])
  })

  test('a CSP meta without a content attribute is ignored', () => {
    expect(findCspMetas('<meta http-equiv="Content-Security-Policy">').length).toBe(0)
  })

  test('an unterminated quoted tag does not hide a later CSP meta', () => {
    const doc =
      '<head><meta name="broken" content="unclosed >' +
      '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'"></head>'
    expect(findCspMetas(doc).map((meta) => meta.policy)).toEqual(["script-src 'self'"])
  })
})

describe('allowInlineScripts (end to end)', () => {
  test('adds one hash per script text, idempotently', async () => {
    const doc = DOC("default-src 'self'; script-src 'self'")
    const texts = ['alert(1);', '{"imports":{}}']
    const once = await allowInlineScripts(doc, texts)
    expect(once).not.toBeNull()
    const hashA = await scriptHashSource(texts[0]!)
    const hashB = await scriptHashSource(texts[1]!)
    expect(once!).toContain(hashA)
    expect(once!).toContain(hashB)
    const twice = await allowInlineScripts(once!, texts)
    expect(twice).toBe(once)
  })

  test('no CSP meta at all → document unchanged (nothing blocks inline)', async () => {
    const doc = '<html><head></head><body></body></html>'
    expect(await allowInlineScripts(doc, ['x'])).toBe(doc)
  })

  test('TWO CSP metas: both policies get the hash (policies combine)', async () => {
    const doc =
      `<head>` +
      `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">` +
      `<meta content="script-src 'none'" http-equiv="Content-Security-Policy">` +
      `</head>`
    const out = await allowInlineScripts(doc, ['alert(1);'])
    expect(out).not.toBeNull()
    const hash = await scriptHashSource('alert(1);')
    expect(out!).toContain(`content="script-src 'self' ${hash}"`)
    // 'none' REPLACED by the hash — never emitted alongside it.
    expect(out!).toContain(`content="script-src ${hash}"`)
    expect(out!.includes("'none'")).toBe(false)
  })

  test("a meta whose script-src has 'unsafe-inline' is left untouched but counts as satisfied", async () => {
    const doc =
      `<head>` +
      `<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline'">` +
      `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">` +
      `</head>`
    const out = await allowInlineScripts(doc, ['alert(1);'])
    expect(out).not.toBeNull()
    const hash = await scriptHashSource('alert(1);')
    expect(out!).toContain("script-src 'self' 'unsafe-inline'")
    expect(out!).toContain(`script-src 'self' ${hash}`)
  })

  test('null (all-or-nothing, no edits) when ANY policy lacks a script-src', async () => {
    const doc =
      `<head>` +
      `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">` +
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">` +
      `</head>`
    expect(await allowInlineScripts(doc, ['alert(1);'])).toBeNull()
  })

  test('empty text list is a no-op', async () => {
    const doc = DOC("script-src 'none'")
    expect(await allowInlineScripts(doc, [])).toBe(doc)
  })

  test('escapes a hash when the content attribute uses single quotes', async () => {
    const doc = `<meta http-equiv="Content-Security-Policy" content='script-src self'>`
    const text = 'alert(1);'
    const hash = await scriptHashSource(text)
    const out = await allowInlineScripts(doc, [text])
    expect(out).toBe(`<meta http-equiv="Content-Security-Policy" content='script-src self ${hash.replaceAll("'", '&#39;')}'>`)
    expect(findCspMetas(out!).map((meta) => meta.policy)).toEqual([`script-src self ${hash}`])
  })

  test('quotes an originally unquoted content attribute before adding the hash', async () => {
    const text = 'alert(1);'
    const hash = await scriptHashSource(text)
    const out = await allowInlineScripts(
      '<meta http-equiv="Content-Security-Policy" content=script-src>',
      [text],
    )
    expect(out).toContain(`content="script-src ${hash}"`)
    expect(findCspMetas(out!).map((meta) => meta.policy)).toEqual([`script-src ${hash}`])
  })

  test('patches script-src-elem because it governs classic inline script tags', async () => {
    const text = 'alert(1);'
    const hash = await scriptHashSource(text)
    const out = await allowInlineScripts(DOC("script-src 'self'; script-src-elem 'self'"), [text])
    expect(out).toContain(`script-src 'self' ${hash}`)
    expect(out).toContain(`script-src-elem 'self' ${hash}`)
  })
})

/**
 * cspPatch — CSP `<meta>` surgery for filter-injected inline scripts
 * (task 2.4).
 *
 * CSP verdict at pin 6b055cf78 (spike evidence): published pages carry a
 * `<meta http-equiv="Content-Security-Policy">` whose `script-src` is
 * `'none'` by default, relaxed to `'self'` (+ the importmap sha256) when
 * the page has script tags (vendor src/core/publisher/cspPlan.ts:69-97,
 * render.ts:381-387,411-426). When ANY plugin ships `frontend.assets[]`
 * scripts, the injection pipeline REPLACES `script-src` with `'self'`
 * (or `'self' 'unsafe-inline'` for declared inline assets) — vendor
 * server/publish/frontendInjections.ts:373-379. Two consequences:
 *
 *   1. An inline `<script>` injected by the `publish.html` filter (our
 *      analytics config tag) is BLOCKED unless the policy carries its
 *      sha256 hash (or 'unsafe-inline'). We add the hash here — precise,
 *      per-page, and only when the tag is actually injected; a blanket
 *      manifest `script-inline` stub would weaken every page sitewide.
 *   2. The host's replacement WIPES the importmap's sha256 from
 *      `script-src` (frontendInjections.ts:377 replaces; render.ts:383
 *      pinned it), so runtime-package importmaps break on any page as
 *      soon as a frontend-asset plugin is enabled — including ours. As a
 *      workaround this module re-hashes the page's own
 *      `<script type="importmap">` and restores its hash (upstream gap,
 *      see docs/SPIKES.md G14).
 *
 * Robustness (review B2#3): the pinned host emits ONE deterministic tag
 * (`cspMetaTag`, cspPlan.ts:136-138), but this module hardens beyond
 * that shape — attribute order variants (`content` before `http-equiv`),
 * single- OR double-quoted attributes, and MULTIPLE CSP metas. Multiple
 * policies COMBINE (a script must satisfy every policy), so:
 *
 *   - every CSP meta whose policy HAS a `script-src` gets the hashes
 *     (its lone `'none'` is REPLACED by them, never emitted alongside);
 *   - a policy whose `script-src` already carries `'unsafe-inline'` is
 *     left untouched (per CSP2+ a hash's presence makes browsers IGNORE
 *     'unsafe-inline' — adding ours would break every OTHER inline
 *     script relying on it; under 'unsafe-inline' our tag runs anyway);
 *   - a CSP meta WITHOUT `script-src` is never given one (creating the
 *     directive would cut external scripts governed by `default-src`),
 *     and since that policy would still block our inline, the overall
 *     patch FAILS (null) and the caller must skip the injection.
 *
 * CSP hash semantics: base64(SHA-256(exact script text between the
 * tags)). The QuickJS sandbox has `crypto.subtle.digest` (host-bridged —
 * vendor server/plugins/quickjs/bootstrap/crypto.ts); inputs are passed
 * as Uint8Array so the same code also runs under Bun in tests. Base64 is
 * implemented locally (no `btoa` in the sandbox).
 *
 * The filter runs AFTER the host writes the CSP meta (pipeline stage 3
 * vs 2 — publishedHtmlPipeline.ts:49-65), so edits here are final.
 * All edits are idempotent (token-presence checks) and pure string
 * surgery — value spans are spliced in place; no String.replace with
 * payload-derived text (replacement-token hygiene, same rule as
 * headSurgeon).
 */

// ---------------------------------------------------------------------------
// CSP meta scanning — quote-aware, attribute-order-agnostic
// ---------------------------------------------------------------------------

interface AttrSpan {
  name: string
  /** Attribute value (quotes excluded); '' for valueless attributes. */
  value: string
  /** [valueStart, valueEnd) span of the value inside the document. */
  valueStart: number
  valueEnd: number
}

/** Find a tag's closing `>` respecting both quote types (cf. imageAudit). */
function findTagEnd(html: string, start: number): number {
  let quote = 0
  for (let i = start + 1; i < html.length; i++) {
    const code = html.charCodeAt(i)
    if (quote !== 0) {
      if (code === quote) quote = 0
    } else if (code === 34 || code === 39) {
      quote = code
    } else if (code === 62) {
      return i + 1
    }
  }
  return html.length
}

function isSpace(code: number): boolean {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32
}

/** Tokenize attributes in [start, end) with document-absolute value spans. */
function parseAttrSpans(html: string, start: number, end: number): AttrSpan[] {
  const attrs: AttrSpan[] = []
  let i = start
  while (i < end) {
    while (i < end && isSpace(html.charCodeAt(i))) i++
    if (i >= end) break
    const nameStart = i
    while (i < end && !isSpace(html.charCodeAt(i)) && html.charCodeAt(i) !== 61 && html.charCodeAt(i) !== 62) i++
    if (i === nameStart) {
      i++
      continue
    }
    const name = html.slice(nameStart, i).toLowerCase()
    while (i < end && isSpace(html.charCodeAt(i))) i++
    let value = ''
    let valueStart = i
    let valueEnd = i
    if (i < end && html.charCodeAt(i) === 61) {
      i++
      while (i < end && isSpace(html.charCodeAt(i))) i++
      if (i < end && (html.charCodeAt(i) === 34 || html.charCodeAt(i) === 39)) {
        const quote = html.charCodeAt(i++)
        valueStart = i
        while (i < end && html.charCodeAt(i) !== quote) i++
        valueEnd = i
        value = html.slice(valueStart, valueEnd)
        if (i < end) i++
      } else {
        valueStart = i
        while (i < end && !isSpace(html.charCodeAt(i)) && html.charCodeAt(i) !== 62) i++
        valueEnd = i
        value = html.slice(valueStart, valueEnd)
      }
    }
    if (name !== '/') attrs.push({ name, value, valueStart, valueEnd })
  }
  return attrs
}

export interface CspMetaMatch {
  /** The policy text (the `content` attribute's value). */
  policy: string
  /** [start, end) span of the policy inside the document, for splicing. */
  valueStart: number
  valueEnd: number
}

/**
 * Every `<meta http-equiv="Content-Security-Policy" content="…">` in the
 * document, regardless of attribute order or quote style. Metas without a
 * `content` attribute are ignored (they declare no policy).
 */
export function findCspMetas(html: string): CspMetaMatch[] {
  const lower = html.toLowerCase()
  const out: CspMetaMatch[] = []
  let i = 0
  while (i < html.length) {
    const at = lower.indexOf('<meta', i)
    if (at === -1) break
    const tagEnd = findTagEnd(html, at)
    const attrsEnd = tagEnd > at && html.charCodeAt(tagEnd - 1) === 62 ? tagEnd - 1 : tagEnd
    const attrs = parseAttrSpans(html, at + 5, attrsEnd)
    const httpEquiv = attrs.find((a) => a.name === 'http-equiv')
    if (httpEquiv !== undefined && httpEquiv.value.trim().toLowerCase() === 'content-security-policy') {
      const content = attrs.find((a) => a.name === 'content')
      if (content !== undefined) {
        out.push({ policy: content.value, valueStart: content.valueStart, valueEnd: content.valueEnd })
      }
    }
    i = tagEnd
  }
  return out
}

export type InlineCspPlan =
  /** No CSP meta on the document — inline scripts run unrestricted. */
  | { mode: 'no-csp' }
  /** CSP meta(s) found — inline needs its sha256 in each script-src. */
  | { mode: 'patch' }

/**
 * Classify the document BEFORE injecting an inline tag. The host always
 * emits the CSP meta on published pages, so 'no-csp' only shows up for
 * exotic/legacy documents — where inline runs anyway.
 */
export function planInlineCsp(html: string): InlineCspPlan {
  return findCspMetas(html).length > 0 ? { mode: 'patch' } : { mode: 'no-csp' }
}

// ---------------------------------------------------------------------------
// SHA-256 → CSP source token
// ---------------------------------------------------------------------------

/** Minimal UTF-8 encoder (the sandbox has no TextEncoder guarantee). */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i)
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++
        code = 0x10000 + (((code & 0x3ff) << 10) | (next & 0x3ff))
        out.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        )
      } else {
        out.push(0xef, 0xbf, 0xbd) // unpaired surrogate → U+FFFD
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out.push(0xef, 0xbf, 0xbd)
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  return new Uint8Array(out)
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard base64 (with padding) over raw bytes — no `btoa` dependency. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0
    out += B64_ALPHABET[a >> 2]! + B64_ALPHABET[((a & 3) << 4) | (b >> 4)]!
    out += i + 1 < bytes.length ? B64_ALPHABET[((b & 15) << 2) | (c >> 6)]! : '='
    out += i + 2 < bytes.length ? B64_ALPHABET[c & 63]! : '='
  }
  return out
}

/**
 * CSP source token `'sha256-<base64>'` for a script's exact text.
 * `crypto.subtle.digest` accepts a Uint8Array both in the sandbox shim
 * and under Bun/WebCrypto.
 */
export async function scriptHashSource(scriptText: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8Bytes(scriptText))
  return `'sha256-${bytesToBase64(new Uint8Array(digest))}'`
}

// ---------------------------------------------------------------------------
// Policy editing — pure string surgery on a serialized policy
// ---------------------------------------------------------------------------

/**
 * Patch ONE policy's `script-src` so the given inline-script sources are
 * allowed. Semantics (see module header, review B2#3):
 *
 *   - `'unsafe-inline'` present → untouched, ok (inline already runs;
 *     adding a hash would DISABLE 'unsafe-inline' per CSP2+).
 *   - `script-src` present → lone `'none'` REPLACED by the sources
 *     (never emitted alongside — 'none' must be the sole value),
 *     already-present tokens skipped (idempotency).
 *   - NO `script-src` directive → policy returned unchanged, ok:false.
 *     The directive is never created: doing so would strip external
 *     scripts of their `default-src` fallback.
 */
export function patchPolicyScriptSrc(
  policy: string,
  sources: readonly string[],
): { policy: string; ok: boolean } {
  const directives = policy
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  let found = false
  let ok = false
  const next = directives.map((directive) => {
    const spaceAt = directive.indexOf(' ')
    const name = (spaceAt === -1 ? directive : directive.slice(0, spaceAt)).toLowerCase()
    if (name !== 'script-src' || found) return directive
    found = true
    const existing =
      spaceAt === -1 ? [] : directive.slice(spaceAt + 1).split(/\s+/).filter((s) => s !== '')
    if (existing.includes("'unsafe-inline'")) {
      ok = true
      return directive
    }
    const set = existing.filter((s) => s !== "'none'")
    for (const source of sources) {
      if (!set.includes(source)) set.push(source)
    }
    ok = true
    return `script-src ${set.join(' ')}`
  })
  if (!found) return { policy, ok: false }
  return { policy: next.join('; '), ok }
}

/**
 * Back-compat helper (tests, generic edits): patch a policy's script-src
 * with the given sources, returning the policy unchanged when it has no
 * `script-src` or already carries `'unsafe-inline'`.
 */
export function addScriptSrcSources(policy: string, sources: readonly string[]): string {
  return patchPolicyScriptSrc(policy, sources).policy
}

/**
 * Rewrite EVERY CSP meta's policy by mapping it through `edit`. Returns
 * null when no CSP meta exists. Value spans are spliced right-to-left so
 * earlier offsets stay valid.
 */
export function rewriteCspMetaContent(
  html: string,
  edit: (policy: string) => string,
): string | null {
  const metas = findCspMetas(html)
  if (metas.length === 0) return null
  let next = html
  for (let i = metas.length - 1; i >= 0; i--) {
    const meta = metas[i]!
    const edited = edit(meta.policy)
    if (edited === meta.policy) continue
    next = next.slice(0, meta.valueStart) + edited + next.slice(meta.valueEnd)
  }
  return next
}

// ---------------------------------------------------------------------------
// Importmap re-hash (upstream gap G14 workaround)
// ---------------------------------------------------------------------------

const IMPORTMAP_RE = /<script type="importmap">([\s\S]*?)<\/script>/i

/**
 * The exact text of the page's inline `<script type="importmap">` body, if
 * any (the host emits at most one — render.ts:384-387).
 */
export function extractImportmapText(html: string): string | undefined {
  const match = IMPORTMAP_RE.exec(html)
  return match === null ? undefined : match[1]!
}

/**
 * Ensure EVERY CSP policy on the page allows the given inline script
 * texts by hash. Policies combine — the inline must satisfy each — so
 * the patch succeeds only when every CSP meta's policy ends up allowing
 * it (hash added, or 'unsafe-inline' already present). Returns:
 *
 *   - the (possibly unchanged) document when every policy allows the
 *     scripts — including the trivial no-CSP-meta case;
 *   - null when ANY policy cannot be satisfied (no `script-src`
 *     directive to patch) — the caller must then skip its inline
 *     injection (a blocked tag would just spray console violations).
 *
 * All-or-nothing: on failure NO policy is modified.
 */
export async function allowInlineScripts(
  html: string,
  scriptTexts: readonly string[],
): Promise<string | null> {
  if (scriptTexts.length === 0) return html
  const metas = findCspMetas(html)
  if (metas.length === 0) return html
  const sources: string[] = []
  for (const text of scriptTexts) {
    sources.push(await scriptHashSource(text))
  }
  // Compute every patch first — apply only when ALL policies are ok.
  const patched: string[] = []
  for (const meta of metas) {
    const result = patchPolicyScriptSrc(meta.policy, sources)
    if (!result.ok) return null
    patched.push(result.policy)
  }
  let next = html
  for (let i = metas.length - 1; i >= 0; i--) {
    const meta = metas[i]!
    if (patched[i] === meta.policy) continue
    next = next.slice(0, meta.valueStart) + patched[i]! + next.slice(meta.valueEnd)
  }
  return next
}

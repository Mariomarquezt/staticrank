/**
 * Page-content source for the editor panel's content analysis (task 2.5).
 *
 * CONTENT SOURCE DECISION — option (a), live tree serialization:
 * the editor store's `site.pages[]` entries ARE full `Page` objects — a
 * NodeTree (flat `nodes` map + `rootNodeId`) plus metadata (vendor/Instatic
 * src/core/page-tree/page.ts:30-53, hydrated from data rows by
 * src/core/data/pageFromRow.ts:38-73). The panel already reads them through
 * `useEditorStore` (`editor.store.read` grant), so the DRAFT content is
 * available client-side with live updates — no publish round-trip, no
 * staleness. This module walks that tree and emits lightweight semantic
 * HTML shaped for `server/lib/analysis` (`parseHtml` in
 * server/lib/analysis/extract.ts: block tags = paragraph boundaries,
 * h1–h6 = headings, `<a href>` = links, `<img>` = images).
 *
 * The rejected alternatives:
 *   (b) fetching the published page HTML (same-origin — the vite dev server
 *       proxies public-site requests to the CMS, vendor/Instatic
 *       vite.config.ts `instatic-public-site-dev-proxy`) reflects the LAST
 *       PUBLISH, not the draft being edited, and 404s for never-published
 *       pages;
 *   (c) no content at all (title/description/keyword checks only) — kept as
 *       the RUNTIME FALLBACK when serialization fails.
 *
 * Honesty caveat baked into the serialized shape: image ALT text is not in
 * the page tree — the media library asset is the single source of truth,
 * resolved server-side at render time (vendor/Instatic
 * src/modules/base/image/index.ts:181-187; ImagePropsSchema has no alt
 * field, src/modules/base/image/props.ts:4-16). Serialized `<img>` tags
 * therefore carry only `src`, and the VIEW layer (analysisView.ts) treats
 * alt- and dimension-dependent results as unknowable for this source
 * instead of reporting false "missing alt" findings.
 *
 * Module coverage mirrors what the publisher emits as indexable text
 * (module prop shapes: vendor/Instatic src/modules/base/&#42;/props.ts):
 *   base.text   → `<tag>` from props.tag (p / h1–h6 / span / div / small /
 *                 strong / em), newlines become <br> (textToBreakHtml
 *                 semantics); tag 'none' = bare text CONCATENATED with its
 *                 siblings, no invented boundary (the publisher emits the
 *                 escaped text verbatim — src/modules/base/text/index.ts:75-79)
 *   base.list   → <ul>/<ol> + <li> per non-empty line of props.items
 *                 (split rule: src/modules/base/list/items.ts:17-21)
 *   base.link   → <a href>…children…</a>, falling back to props.text only
 *                 when the link has no rendered children — mirroring
 *                 linkUsesChildren in src/modules/base/link/index.ts
 *   base.button → <a href>label</a> (or <span>label</span> without href)
 *   base.image  → <img src> (skipped when src is empty, matching render)
 *   base.body / base.container / base.slot-instance → <div> wrapper around
 *                 children (block boundary). Slot-instance children are the
 *                 REAL slot-fill nodes materialized in the consumer page's
 *                 tree (src/modules/base/slotInstance/index.ts:1-18), so
 *                 they analyze like any other page content.
 *
 * NOT analyzable — reported via `partial` / `skippedCount` instead of
 * being silently mis-scored:
 *   base.visual-component-ref → its slot-instance CHILDREN are analyzed
 *                 (they live in the page tree), but the VC's own definition
 *                 tree does not exist in the page and would need the
 *                 publisher's VC/outlet pairing to materialize — counted
 *                 as a skipped section.
 *   base.loop   → repeats a template over data rows resolved at publish
 *                 time; the page tree holds only the unbound template —
 *                 skipped entirely, counted.
 *   unknown module ids with children → the publisher drops unknown modules
 *                 (renderNode.ts:307-310 emits only a comment); skipped and
 *                 counted. Childless unknown leaves (svg, video, …)
 *                 contribute no analyzable text and are silently ignored.
 *
 * `hidden: true` nodes are skipped — the publisher does the same
 * (vendor/Instatic src/core/publisher/renderNode.ts:304).
 *
 * Pure TypeScript, no React, no SDK imports — unit-tests under plain
 * `bun test` and bundles into the browser editor bundle unchanged.
 */

// ---------------------------------------------------------------------------
// Structural input types (the panel casts the store's Page down to this)
// ---------------------------------------------------------------------------

export interface ContentTreeNode {
  moduleId: string
  props?: Record<string, unknown>
  children?: string[]
  hidden?: boolean
}

export interface ContentTree {
  nodes: Record<string, ContentTreeNode>
  rootNodeId: string
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Escaped text with authored newlines as `<br>` (textToBreakHtml parity). */
function textToHtml(value: string): string {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, '<br>')
}

/**
 * Clamp a RAW prop value to what could still fit in `budget` output
 * characters, BEFORE escaping allocates (round-5 wave-2 O#3).
 *
 * `SERIALIZED_HTML_MAX` is charged against the ESCAPED string, so it only
 * bounds what is kept — not what is built. Escaping is monotonic (every
 * source character costs at least one output character: `"` costs six,
 * `&` five, a newline four through `textToHtml`), so a raw value longer
 * than the remaining budget can never be emitted no matter what it
 * contains. Without this clamp a 50 MB `base.text` node materialized
 * ~250 MB of intermediate string inside `escapeHtml` before `charge`
 * rejected it — the editor froze or OOMed instead of returning a
 * truncated analysis.
 *
 * `budget + 1` is deliberate: it keeps the clamped value strictly longer
 * than the budget whenever the original was, so `charge` still rejects
 * exactly the same inputs it rejected before. Values that fit are
 * untouched, so every non-pathological tree serializes byte-identically.
 */
function clampRaw(value: string, budget: number): string {
  const limit = budget + 1
  return value.length > limit ? value.slice(0, limit) : value
}

// ---------------------------------------------------------------------------
// base.text tag normalization (mirror of src/modules/base/text/tags.ts)
// ---------------------------------------------------------------------------

const TEXT_TAGS = new Set([
  'p',
  'none',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'span',
  'div',
  'small',
  'strong',
  'em',
])

function normalizeTextTag(raw: unknown): string {
  return typeof raw === 'string' && TEXT_TAGS.has(raw) ? raw : 'p'
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function stringProp(props: Record<string, unknown> | undefined, key: string): string {
  const value = props?.[key]
  return typeof value === 'string' ? value : ''
}

/** Structural modules whose children are plain page content. */
const RECURSE_MODULES = new Set(['base.body', 'base.container', 'base.slot-instance'])

/** Known leaf modules that legitimately contribute no analyzable text. */
const SILENT_LEAF_MODULES = new Set(['base.svg', 'base.video', 'base.slot-outlet'])

/**
 * Output ceiling, in characters (~256 KB). The editor panel re-serializes
 * and re-analyzes the whole tree on the analysis key (SeoPanel's debounced
 * effect), so an unbounded serialization turns one multi-megabyte text or
 * data-URI prop into a per-keystroke stall. Everything past the ceiling is
 * dropped and reported as a skipped section — the analysis stays scored on
 * what IS analyzable, exactly like the VC/loop skips.
 *
 * 256 KB is far above any hand-authored page (the largest real trees
 * serialize in the low tens of KB) and far below the size where the
 * extractor's linear scan becomes noticeable.
 */
export const SERIALIZED_HTML_MAX = 256 * 1024

/**
 * Recursion depth bound. `visited` bounds total WORK (each node once) but
 * not DEPTH — a thousands-deep container chain (imported or hand-crafted)
 * would throw RangeError and kill content analysis outright. Bail past the
 * bound and count it instead; 256 is orders of magnitude deeper than any
 * authored layout.
 */
export const SERIALIZE_DEPTH_MAX = 256

/**
 * URL attribute ceiling — the server's own `URL_MAX` (server/seoMeta.ts).
 * A longer value is not storable meta anywhere in the product, so keeping
 * it verbatim in the analysis HTML only costs memory.
 */
const URL_ATTR_MAX = 2000

/** `data:` URI test — leading whitespace and case are both tolerated. */
function isDataUri(value: string): boolean {
  return /^\s*data:/i.test(value)
}

/** URL attribute value, length-bounded (see URL_ATTR_MAX). */
function boundedUrl(value: string): string {
  return value.length > URL_ATTR_MAX ? value.slice(0, URL_ATTR_MAX) : value
}

interface SerializeState {
  visited: Set<string>
  /** Sections whose content cannot be analyzed from the tree (VC/loop/unknown). */
  skippedCount: number
  /** Characters still available before SERIALIZED_HTML_MAX is reached. */
  remaining: number
  /** True once the ceiling or the depth bound stopped serialization. */
  truncated: boolean
  /** Current recursion depth (see SERIALIZE_DEPTH_MAX). */
  depth: number
}

/**
 * Charge `cost` characters against the output ceiling. Returns false when
 * the ceiling is reached — the caller emits nothing, serialization stops,
 * and the cut counts as ONE skipped section (everything after it).
 *
 * Each node charges only what IT adds; children have already paid for
 * their own output by the time a wrapper charges its tags.
 */
function charge(state: SerializeState, cost: number): boolean {
  if (state.truncated) return false
  if (cost > state.remaining) {
    state.truncated = true
    state.skippedCount += 1
    return false
  }
  state.remaining -= cost
  return true
}

function serializeChildren(
  tree: ContentTree,
  children: string[],
  state: SerializeState,
): string {
  const inner: string[] = []
  state.depth += 1
  for (const childId of children) serializeNode(tree, childId, state, inner)
  state.depth -= 1
  return inner.join('')
}

function serializeNode(
  tree: ContentTree,
  nodeId: string,
  state: SerializeState,
  out: string[],
): void {
  // Ceiling reached earlier in the walk — stop, do not keep building.
  if (state.truncated) return
  // Depth bound BEFORE the visited mark: a node bailed for depth may still
  // be reachable (and serializable) on a shallower path.
  if (state.depth > SERIALIZE_DEPTH_MAX) {
    state.skippedCount += 1
    return
  }
  // Cycle / duplicate guard: a corrupt tree must never loop the panel.
  if (state.visited.has(nodeId)) return
  state.visited.add(nodeId)
  const node = tree.nodes[nodeId]
  if (node === undefined || node.hidden === true) return

  const props = node.props

  switch (node.moduleId) {
    case 'base.text': {
      // Clamped to the remaining budget BEFORE escaping — see clampRaw.
      const text = clampRaw(stringProp(props, 'text'), state.remaining)
      if (text === '') return
      const tag = normalizeTextTag(props?.tag)
      if (tag === 'none') {
        // Publisher parity (text/index.ts:75-79): a no-wrapper text node
        // emits the escaped text VERBATIM — no invented boundary, so
        // adjacent bare nodes concatenate exactly like the published DOM.
        const bare = escapeHtml(text)
        if (!charge(state, bare.length)) return
        out.push(bare)
        return
      }
      const html = `<${tag}>${textToHtml(text)}</${tag}>`
      if (!charge(state, html.length)) return
      out.push(html)
      return
    }
    case 'base.list': {
      const tag = props?.listType === 'ordered' ? 'ol' : 'ul'
      // Scan non-empty raw lines incrementally instead of splitting or
      // clamping the whole blob. Blank lines and trim-only content cost no
      // HTML, so raw length cannot predict whether the serialized list fits.
      // `/[^\n]+/g` also skips arbitrarily long newline runs without
      // allocating one array entry per authored line.
      const rawItems = stringProp(props, 'items')
      const lines = rawItems.matchAll(/[^\n]+/g)
      const parts: string[] = []
      let cost = `<${tag}>`.length + `</${tag}>`.length
      for (const line of lines) {
        const item = line[0].trim()
        if (item === '') continue
        const li = `<li>${escapeHtml(clampRaw(item, state.remaining))}</li>`
        parts.push(li)
        cost += li.length
        // The list is charged as a whole. Once its predicted cost is over
        // budget it cannot emit, so scanning or escaping later lines cannot
        // change the result.
        if (cost > state.remaining) break
      }
      if (parts.length === 0) return
      const html = `<${tag}>${parts.join('')}</${tag}>`
      if (!charge(state, html.length)) return
      out.push(html)
      return
    }
    case 'base.link': {
      // Children-first, exactly like the renderer's linkUsesChildren guard
      // (link/index.ts): props.text is the fallback when no children render.
      const href = escapeHtml(boundedUrl(stringProp(props, 'href')))
      const inner = serializeChildren(tree, node.children ?? [], state)
      // `inner` already paid for itself — charge only the wrapper plus the
      // fallback text when no child rendered.
      const fallback =
        inner !== '' ? '' : textToHtml(clampRaw(stringProp(props, 'text'), state.remaining))
      const content = inner !== '' ? inner : fallback
      if (href === '' && content === '') return
      const open = `<a href="${href}">`
      if (!charge(state, open.length + fallback.length + '</a>'.length)) {
        // The ceiling hit on the wrapper: keep the children's already-paid
        // content rather than throwing away analyzable text.
        if (inner !== '') out.push(inner)
        return
      }
      out.push(`${open}${content}</a>`)
      return
    }
    case 'base.button': {
      const label = clampRaw(stringProp(props, 'label'), state.remaining)
      const href = stringProp(props, 'href')
      if (label === '') return
      const html =
        href !== ''
          ? `<a href="${escapeHtml(boundedUrl(href))}">${textToHtml(label)}</a>`
          : `<span>${textToHtml(label)}</span>`
      if (!charge(state, html.length)) return
      out.push(html)
      return
    }
    case 'base.image': {
      const src = stringProp(props, 'src')
      // The renderer emits nothing for an empty src (image/index.ts render).
      // NOTE: no alt on purpose — alt lives in the media library, not the
      // tree; analysisView treats it as unknowable for this source.
      if (src === '') return
      // A `data:` src is an inlined payload — potentially megabytes — with
      // ZERO analyzable value (the extractor only counts <img> tags and
      // reads `alt`), and the publish sanitizer rejects data: URIs anyway.
      // Emit the tag WITHOUT the src so the image still counts, and drop
      // the blob. Non-data srcs are length-bounded at URL_MAX.
      const html = isDataUri(src) ? '<img>' : `<img src="${escapeHtml(boundedUrl(src))}">`
      if (!charge(state, html.length)) return
      out.push(html)
      return
    }
    case 'base.visual-component-ref': {
      // The VC's own definition tree is NOT in the page and would need the
      // publisher's outlet pairing to materialize — count it as a skipped
      // section. Its slot-instance children ARE materialized page-tree
      // nodes (slotInstance/index.ts:1-18), so the slot FILLS analyze.
      state.skippedCount += 1
      const inner = serializeChildren(tree, node.children ?? [], state)
      if (inner === '') return
      if (!charge(state, '<div></div>'.length)) {
        out.push(inner)
        return
      }
      out.push(`<div>${inner}</div>`)
      return
    }
    case 'base.loop': {
      // Loop children are an unbound template repeated over data rows at
      // publish time — analyzing the raw template would mis-score both
      // word counts and keyword density. Skip entirely, count.
      state.skippedCount += 1
      return
    }
    default: {
      if (RECURSE_MODULES.has(node.moduleId)) {
        const inner = serializeChildren(tree, node.children ?? [], state)
        if (inner === '') return
        if (!charge(state, '<div></div>'.length)) {
          out.push(inner)
          return
        }
        out.push(`<div>${inner}</div>`)
        return
      }
      // Unknown modules: the publisher drops them (renderNode.ts:307-310),
      // so recursing would analyze content that never publishes. A node
      // WITH children is a potential content container → counted as a
      // skipped section; a childless leaf (and the known text-free leaves)
      // contributes nothing either way.
      if (!SILENT_LEAF_MODULES.has(node.moduleId) && (node.children ?? []).length > 0) {
        state.skippedCount += 1
      }
      return
    }
  }
}

export interface SerializedPageContent {
  html: string
  /** True when at least one section could not be analyzed from the tree. */
  partial: boolean
  /** Number of skipped sections (VC refs, loops, unknown content modules). */
  skippedCount: number
}

/**
 * Serialize a page tree to analysis-shaped HTML. Returns `null` when the
 * tree is structurally unusable (missing root) — the caller then degrades
 * to the no-content analysis mode. An EMPTY page serializes to
 * `html: ''`, which is a valid (all-content-checks-fail) analysis input,
 * not an error. `partial`/`skippedCount` report sections whose content is
 * not representable from the tree (see the module header) — content
 * checks stay scored on what IS analyzable; the view renders an explicit
 * note instead of blanket-na.
 *
 * BOUNDED BY CONSTRUCTION (round-5 t4-37): output stops at
 * `SERIALIZED_HTML_MAX` characters and recursion stops at
 * `SERIALIZE_DEPTH_MAX` levels; each cut counts as one skipped section, so
 * a pathological tree degrades to a partial analysis instead of stalling
 * the panel or throwing RangeError. `data:` image srcs are dropped from
 * the emitted `<img>` (the tag — and therefore the image count — stays).
 */
export function serializePageContent(tree: ContentTree): SerializedPageContent | null {
  if (typeof tree.rootNodeId !== 'string' || tree.nodes[tree.rootNodeId] === undefined) {
    return null
  }
  const state: SerializeState = {
    visited: new Set(),
    skippedCount: 0,
    remaining: SERIALIZED_HTML_MAX,
    truncated: false,
    depth: 0,
  }
  const out: string[] = []
  serializeNode(tree, tree.rootNodeId, state, out)
  return { html: out.join(''), partial: state.skippedCount > 0, skippedCount: state.skippedCount }
}

/**
 * SEO editor panel (task 1.5) — mounts in the site editor's left rail via
 * `editor.panels.register`. Runs UNSANDBOXED in the host admin window:
 * `react`, `@instatic/host-ui`, and `@instatic/host-hooks` are build-time
 * externals resolved by the host's import map to the host React instance
 * and design system (vendor/Instatic src/core/plugin-sdk/cli/build.ts:73-81).
 *
 * Entry identity: the site editor edits PAGES, which are data rows of the
 * system `pages` table whose row id IS the page id (vendor/Instatic
 * src/core/data/pageFromRow.ts:60), so the panel reads/writes
 * `/meta?table=pages&entry=<activePageId>` — the same key the publish
 * filter resolves. The active page comes from the editor store
 * (`activeDocument` / `activePageId`, uiSlice), which requires the
 * `editor.store.read` permission.
 *
 * Save model: EXPLICIT Save button (no debounced autosave). POST /meta is
 * a full replace, so a debounce could race a half-typed form into storage
 * or POST a transiently-empty payload (a 400 by design); an explicit save
 * keeps one predictable write per user intent. Dirty state and the SERP
 * preview still update live on every keystroke.
 *
 * Concurrency discipline (lost-update fix): Save and Clear both REFETCH
 * the entry's meta immediately before writing and graft/clear only the
 * panel-owned fields (title, metaDescription, focusKeywords) onto that
 * FRESH payload — see admin/lib/metaForm.ts. Another admin's concurrent change to e.g.
 * the canonical survives; the residual fetch→POST window is accepted at
 * this pin (no server revision mechanism, G10-adjacent).
 *
 * Staleness discipline: every async completion carries the request
 * GENERATION captured at its start; the generation bumps whenever the
 * edited page changes (or the panel reloads/unmounts), so a completion
 * for page A can never commit state after the panel switched to page B.
 * The /config document feeding the preview is refetched on window
 * focus/visibility and after every save/clear; an open-but-unfocused
 * panel can still show a preview against a config another admin changed
 * since — accepted residual staleness at this pin.
 *
 * Content analysis (task 2.5): the CONTENT the checks run over is
 * serialized CLIENT-SIDE from the live editor page tree — the store's
 * `site.pages[]` entries are full Page objects carrying `nodes` +
 * `rootNodeId` (see admin/lib/pageContent.ts for the source decision and
 * vendor evidence), so the analysis follows every draft edit with no
 * publish round-trip. Analysis recomputes DEBOUNCED (~300 ms) on every
 * title/description/keyword keystroke and on page-tree changes (the store
 * subscription re-renders with a fresh page object). Any serialization or
 * engine failure degrades to the no-content mode (title/description/
 * keyword checks only; content/readability report 'na' with an honest
 * note) — the panel never breaks over a corrupt tree. Free-tier gate: ONE
 * focus keyword is editable and fed to the engine (the engine itself is
 * gating-free; extra stored keywords are preserved on save, shown
 * read-only, and hinted as Pro).
 *
 * Pro unlock (task 3.4): the panel reads the REAL license state — GET
 * /license on mount and on window refocus (the /config refresh
 * discipline), collapsed to LOCKED on any failure incl. the free build's
 * 404 (editor/lib/proAnalysis.ts). Unlocked: ALL stored keywords are
 * scored (full engine path — the aggregate keyword checks average across
 * keywords) with a per-keyword breakdown from one engine pass per keyword
 * over the same memoized serialized HTML; the keyword list becomes
 * editable up to the server's stored cap; the full-analysis ProLock
 * disappears. Locked: byte-for-byte the free behavior above — this same
 * bundle ships in the free build (presentation only; the server gates
 * its own routes).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  EmptyState,
  Input,
  RangeTabs,
  Separator,
  Stack,
  Text,
  Textarea,
} from '@instatic/host-ui'
import { useEditorStore, usePluginRoutes } from '@instatic/host-hooks'
import {
  DESCRIPTION_MAX,
  FOCUS_KEYWORD_MAX,
  TITLE_MAX,
  validateSeoMeta,
  type FieldError,
  type SeoMetaPayload,
} from '../server/seoMeta'
import type { SeoConfigData } from '../server/seoConfig'
import {
  DESCRIPTION_RECOMMENDED_MAX,
  TITLE_RECOMMENDED_MAX,
  buildSerpPreview,
  type SerpDevice,
} from '../admin/lib/serp'
import {
  FREE_KEYWORD_LIMIT,
  applyFormToMeta,
  formFromMeta,
  isMetaDirty,
  mergeMetaFormAfterSave,
  planMetaClear,
  planMetaSave,
  type MetaFormState,
  type MetaSavePlan,
} from '../admin/lib/metaForm'
import { mergeSeoMeta, normalizeSiteOrigin } from '../server/metaBlock'
import {
  analyzeContent,
  analyzePreparedContent,
  prepareContent,
  type PreparedContent,
} from '../server/lib/analysis'
import { SocialPreviews } from './SocialPreview'
import { auditImages } from '../server/lib/imageAudit'
import { serializePageContent, type ContentTree } from '../admin/lib/pageContent'
import {
  buildAnalysisView,
  type AnalysisView,
  type ContentSourceKind,
  type GroupView,
  type ScoreTone,
} from '../admin/lib/analysisView'
import { ProLock } from '../admin/ProLock'
import {
  KEYWORD_CAP,
  LICENSE_ROUTE,
  analysisDisplayForTier,
  buildKeywordViews,
  canAddKeyword,
  createLicenseRefetchGate,
  proUnlockedFromResponse,
  scoredKeywordsForTier,
  type KeywordAnalysisView,
  type TierTaggedAnalysis,
} from './lib/proAnalysis'
import {
  AI_STATUS_ROUTE,
  AI_SUGGEST_ROUTE,
  parseAiStatus,
  parseSuggestResult,
  suggestButtonView,
  type AiStatusView,
  type SuggestField,
} from './lib/aiSuggest'
import { SuggestionOption } from './SuggestionOption'

/** Table slug the site editor's entries live in (pages ARE data rows). */
const PAGES_TABLE_SLUG = 'pages'

// ---------------------------------------------------------------------------
// Editor-store slice shapes (structural). The augmented `EditorStore`
// interface only materializes inside the Instatic monorepo, so the panel
// declares the exact slices it reads (uiSlice.activeDocument/activePageId,
// siteSlice.site) and casts the selector state.
// ---------------------------------------------------------------------------

interface StorePageShape {
  id: string
  slug: string
  title: string
  template?: { enabled: true; target?: { kind: string; tableSlugs?: string[] } }
  /**
   * A store page IS a full Page (NodeTree + metadata — vendor/Instatic
   * src/core/page-tree/page.ts:30-53). Declared optional/loose here so a
   * shape drift degrades to the no-content analysis mode instead of a
   * crash; pageContent.ts re-checks structure at runtime.
   */
  nodes?: ContentTree['nodes']
  rootNodeId?: string
}

interface StoreShape {
  activeDocument:
    | { kind: 'page'; pageId: string }
    | { kind: 'visualComponent'; vcId: string }
    | null
  activePageId: string | null
  site: {
    name?: string
    settings?: { metaTitle?: string }
    pages: StorePageShape[]
  } | null
}

// ---------------------------------------------------------------------------
// HTTP helpers over the plugin's scoped routes
// ---------------------------------------------------------------------------

interface RoutesLike {
  fetch: (path: string, init?: RequestInit) => Promise<Response>
}

function metaPath(pageId: string): string {
  return `/meta?table=${PAGES_TABLE_SLUG}&entry=${encodeURIComponent(pageId)}`
}

async function readErrors(res: Response): Promise<FieldError[]> {
  try {
    const body: unknown = await res.json()
    if (
      body !== null &&
      typeof body === 'object' &&
      Array.isArray((body as { errors?: unknown }).errors)
    ) {
      return (body as { errors: FieldError[] }).errors
    }
  } catch {
    // fall through to the generic error
  }
  return [{ field: '', message: `request failed with ${res.status}` }]
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

/**
 * HARD input ceiling, mirroring the server's storable maxima (TITLE_MAX /
 * DESCRIPTION_MAX / FOCUS_KEYWORD_MAX, server/seoMeta.ts). The host-ui
 * `Input`/`Textarea` primitives take no `maxLength` prop (PluginUiInputProps,
 * vendor src/core/plugin-sdk/builders/adminApp.ts:78-105), so the cap is
 * applied on change instead — otherwise a megabyte paste is re-analyzed on
 * every keystroke until Save finally rejects it.
 *
 * Measured in UTF-16 code units, exactly like the server's own
 * `checkBoundedString`, so the cap IS the storable ceiling — but the cut
 * never splits a surrogate pair in half.
 */
function clampInput(value: string, max: number): string {
  if (value.length <= max) return value
  const last = value.charCodeAt(max - 1)
  const splitsPair = max > 0 && last >= 0xd800 && last <= 0xdbff
  return value.slice(0, splitsPair ? max - 1 : max)
}

/**
 * DELETE /meta outcome (`{ deleted, remaining, complete }`, server/index.ts).
 * `complete: false` means duplicate records survived the sweep and the meta
 * is still stored — the panel must not show a clean slate over them.
 *
 * TOLERANT DEFAULT — complete: an absent/unreadable body (a pre-contract
 * server, a truncated response) reads as a clean delete, exactly as the
 * panel behaved before. Only an EXPLICIT `complete: false` triggers the
 * re-read + warning, so the honest path can never fire as a false alarm.
 * `remaining` is null when it is not a usable count.
 */
export function parseDeleteOutcome(body: unknown): { complete: boolean; remaining: number | null } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { complete: true, remaining: null }
  }
  const rec = body as Record<string, unknown>
  if (rec.complete !== false) return { complete: true, remaining: null }
  const remaining =
    typeof rec.remaining === 'number' && Number.isFinite(rec.remaining) && rec.remaining >= 0
      ? Math.floor(rec.remaining)
      : null
  return { complete: false, remaining }
}

/**
 * Published-page image-audit counts (task 2.4) — a READ-ONLY response
 * envelope key on GET /meta, joined server-side from the page's sitemap
 * record (written by publish.after from `auditImages` over the composed
 * publish output). NOT part of the stored meta payload: `splitMetaBody`
 * strips it before anything treats the body as a `SeoMetaPayload`, so
 * refetch-then-graft writes can never round-trip it into a POST.
 */
interface PublishedImageAudit {
  totalImages: number
  findings: number
  lastmod?: string
}

function splitMetaBody(raw: Record<string, unknown>): {
  meta: SeoMetaPayload
  imageAudit: PublishedImageAudit | null
} {
  const { imageAudit, ...meta } = raw
  let parsed: PublishedImageAudit | null = null
  if (imageAudit !== null && typeof imageAudit === 'object' && !Array.isArray(imageAudit)) {
    const a = imageAudit as Record<string, unknown>
    if (typeof a.totalImages === 'number' && typeof a.findings === 'number') {
      parsed = { totalImages: a.totalImages, findings: a.findings }
      if (typeof a.lastmod === 'string' && a.lastmod !== '') parsed.lastmod = a.lastmod
    }
  }
  return { meta: meta as SeoMetaPayload, imageAudit: parsed }
}

async function fetchMetaBody(
  routes: RoutesLike,
  pageId: string,
): Promise<{ meta: SeoMetaPayload; imageAudit: PublishedImageAudit | null }> {
  const res = await routes.fetch(metaPath(pageId))
  if (!res.ok) {
    const errors = await readErrors(res)
    throw new Error(errors[0]?.message ?? 'could not load SEO meta')
  }
  return splitMetaBody(await readJson<Record<string, unknown>>(res))
}

/** Stored meta only — write paths graft onto this (envelope key stripped). */
async function fetchMeta(routes: RoutesLike, pageId: string): Promise<SeoMetaPayload> {
  return (await fetchMetaBody(routes, pageId)).meta
}

type MetaLoad =
  | { kind: 'loading' }
  | {
      kind: 'ready'
      stored: SeoMetaPayload
      config: SeoConfigData
      publishedImageAudit: PublishedImageAudit | null
    }
  | { kind: 'error'; message: string }

async function loadPanelData(routes: RoutesLike, pageId: string): Promise<MetaLoad> {
  try {
    const [body, configRes] = await Promise.all([
      fetchMetaBody(routes, pageId),
      routes.fetch('/config'),
    ])
    // A config failure is non-blocking: the preview just falls back to no
    // templates/defaults instead of blocking the meta editor.
    const config = configRes.ok ? await readJson<SeoConfigData>(configRes) : {}
    return {
      kind: 'ready',
      stored: body.meta,
      config,
      publishedImageAudit: body.imageAudit,
    }
  } catch (err) {
    return {
      kind: 'error',
      message: err instanceof Error && err.message !== '' ? err.message : 'could not load SEO meta',
    }
  }
}

// ---------------------------------------------------------------------------
// SERP preview card
// ---------------------------------------------------------------------------

function SerpPreviewCard({
  meta,
  config,
  slug,
  pageTitle,
  device,
}: {
  meta: SeoMetaPayload
  config: SeoConfigData
  slug: string
  pageTitle: string | undefined
  device: SerpDevice
}) {
  const preview = buildSerpPreview({
    meta,
    config,
    tableSlug: PAGES_TABLE_SLUG,
    slug,
    pageTitle,
    device,
  })
  const sourceLabel =
    preview.titleSource === 'entry'
      ? 'SEO title override'
      : preview.titleSource === 'template'
        ? 'title template'
        : 'page title (no template configured)'

  // The preview renders on a fixed light "results page" surface on purpose —
  // it depicts Google, not the admin theme — so colors are literal here.
  return (
    <Stack gap={6}>
      <div
        style={{
          background: '#ffffff',
          border: '1px solid #dadce0',
          borderRadius: 8,
          padding: '14px 16px',
          maxWidth: device === 'mobile' ? 360 : '100%',
          fontFamily: 'arial, sans-serif',
        }}
      >
        <div style={{ color: '#202124', fontSize: 12, lineHeight: '18px' }}>
          {preview.urlLine}
        </div>
        <div
          style={{
            color: '#1a0dab',
            fontSize: device === 'mobile' ? 16 : 20,
            lineHeight: 1.3,
            marginTop: 4,
          }}
        >
          {preview.title.text}
        </div>
        <div style={{ color: '#4d5156', fontSize: 13, lineHeight: 1.55, marginTop: 4 }}>
          {preview.description.text === '' ? (
            <span style={{ color: '#9aa0a6' }}>
              No meta description — search engines will pick their own snippet.
            </span>
          ) : (
            preview.description.text
          )}
        </div>
      </div>
      <Text variant="muted" size="sm">
        Title from: {sourceLabel}
        {preview.title.truncated ? ' · title truncated in results' : ''}
        {preview.description.truncated ? ' · description truncated' : ''}
      </Text>
    </Stack>
  )
}

// ---------------------------------------------------------------------------
// Content analysis (task 2.5)
// ---------------------------------------------------------------------------

/** Debounce for recomputing the analysis on keystrokes / tree changes. */
const ANALYSIS_DEBOUNCE_MS = 300

interface PanelContentSource {
  /** Serialized page HTML; undefined = no content available (mode c). */
  html: string | undefined
  source: ContentSourceKind
  /** Sections not analyzable from the tree (VC refs / loops / unknown). */
  skippedCount: number
}

interface AnalysisInputs extends PanelContentSource {
  title: string
  metaDescription: string | undefined
  slug: string
  url: string | undefined
  /** Tier-sliced (slot 0 locked / full normalized list unlocked). */
  focusKeywords: string[]
  proUnlocked: boolean
}

/**
 * Serialize the live page tree (content source a). Any structural problem
 * or throw degrades to the no-content mode — never breaks the panel.
 * MEMOIZE per page object identity (see the panel body): serialization
 * must not rerun on every title keystroke.
 */
function buildContentSource(page: StorePageShape): PanelContentSource {
  try {
    if (typeof page.rootNodeId === 'string' && page.nodes !== undefined) {
      const serialized = serializePageContent({ nodes: page.nodes, rootNodeId: page.rootNodeId })
      if (serialized !== null) {
        return { html: serialized.html, source: 'tree', skippedCount: serialized.skippedCount }
      }
    }
  } catch {
    // fall through to the no-content mode
  }
  return { html: undefined, source: 'none', skippedCount: 0 }
}

interface AnalysisOutcome {
  view: AnalysisView | null
  /**
   * Per-keyword breakdown (task 3.4) — non-null only when Pro is unlocked
   * AND ≥2 keywords are scored (with one keyword the aggregate keyword
   * group IS that keyword's itemization, exactly as the free tier shows
   * slot 0 today — a duplicate block would add nothing).
   */
  keywordViews: KeywordAnalysisView[] | null
}

/**
 * Build the per-keyword breakdown for an already-computed content mode.
 * Degrades to null on any engine throw — the aggregate view (already
 * built by then) stays up; per-keyword lines are additive, never blocking.
 */
function computeKeywordViews(
  inputs: AnalysisInputs,
  prepared: PreparedContent | undefined,
  source: ContentSourceKind,
): KeywordAnalysisView[] | null {
  if (!inputs.proUnlocked || inputs.focusKeywords.length < 2) return null
  try {
    return buildKeywordViews({
      title: inputs.title,
      metaDescription: inputs.metaDescription,
      slug: inputs.slug,
      url: inputs.url,
      prepared,
      source,
      keywords: inputs.focusKeywords,
    })
  } catch {
    return null
  }
}

/**
 * Run the engine + image audit over the current inputs. A failure on the
 * serialized HTML retries WITHOUT content (mode c); a failure even then
 * returns a null view and the section renders nothing rather than
 * crashing. Content extraction runs ONCE per call (`prepareContent`); the
 * aggregate pass and every per-keyword pass reuse the SAME prepared
 * extraction — one serialize, one parse, N cheap check passes (the old
 * path reparsed the HTML once per keyword).
 */
function computeAnalysis(inputs: AnalysisInputs): AnalysisOutcome {
  const metaArgs = {
    title: inputs.title,
    metaDescription: inputs.metaDescription,
    slug: inputs.slug,
    url: inputs.url,
    focusKeywords: inputs.focusKeywords,
  }
  try {
    const prepared = inputs.html === undefined ? undefined : prepareContent(inputs.html)
    const result =
      prepared !== undefined ? analyzePreparedContent(prepared, metaArgs) : analyzeContent(metaArgs)
    const imageAudit = inputs.html === undefined ? null : auditImages(inputs.html)
    const source = inputs.html === undefined ? 'none' : inputs.source
    return {
      view: buildAnalysisView({
        result,
        imageAudit,
        source,
        keywordCount: inputs.focusKeywords.length,
        skippedCount: inputs.skippedCount,
      }),
      keywordViews: computeKeywordViews(inputs, prepared, source),
    }
  } catch {
    try {
      const result = analyzeContent(metaArgs)
      return {
        view: buildAnalysisView({
          result,
          imageAudit: null,
          source: 'none',
          keywordCount: inputs.focusKeywords.length,
        }),
        keywordViews: computeKeywordViews(inputs, undefined, 'none'),
      }
    } catch {
      return { view: null, keywordViews: null }
    }
  }
}

/**
 * Score-badge + status-glyph colors, from the host admin theme's state
 * tokens (vendor/Instatic src/styles/globals.css): color as STATE, never
 * decorative. The panel runs unsandboxed in the admin document, so the
 * CSS custom properties resolve normally.
 */
const SCORE_TONE_STYLES: Record<ScoreTone, { background: string; color: string }> = {
  good: { background: 'var(--success-10)', color: 'var(--success-text)' },
  ok: { background: 'var(--warning-10)', color: 'var(--warning-text)' },
  bad: { background: 'var(--danger-10)', color: 'var(--danger-text)' },
}

const STATUS_GLYPH_COLORS: Record<string, string> = {
  good: 'var(--success-text)',
  ok: 'var(--warning-text)',
  bad: 'var(--danger-text)',
}

function ScoreBadge({ score, tone }: { score: number; tone: ScoreTone }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 40,
        height: 40,
        padding: '0 8px',
        borderRadius: 20,
        fontSize: 15,
        fontWeight: 600,
        ...SCORE_TONE_STYLES[tone],
      }}
    >
      {score}
    </span>
  )
}

function CheckGroup({
  group,
  open,
  onToggle,
  imageWarnings,
}: {
  group: GroupView
  open: boolean
  onToggle: () => void
  imageWarnings: AnalysisView['imageWarnings']
}) {
  const scoreLabel = group.max > 0 ? `${group.score}/${group.max}` : 'n/a'
  return (
    <Stack gap={6}>
      <Button variant="ghost" size="sm" onClick={onToggle}>
        {open ? '▾' : '▸'} {group.label} · {scoreLabel}
      </Button>
      {open && (
        <Stack gap={4}>
          {group.rows.map((row) => (
            <Stack key={row.id} gap={6} direction="row" align="center">
              <span
                aria-hidden
                style={{
                  width: 14,
                  flexShrink: 0,
                  textAlign: 'center',
                  color: STATUS_GLYPH_COLORS[row.status] ?? 'inherit',
                }}
              >
                {row.glyph}
              </span>
              <Text variant={row.status === 'na' ? 'muted' : 'default'} size="sm">
                {row.detail}
              </Text>
            </Stack>
          ))}
          {group.id === 'content' && imageWarnings !== null && (
            <ImageWarnings warnings={imageWarnings} />
          )}
        </Stack>
      )}
    </Stack>
  )
}

function ImageWarnings({ warnings }: { warnings: NonNullable<AnalysisView['imageWarnings']> }) {
  if (warnings.totalImages === 0) return null
  return (
    <Stack gap={4}>
      <Text variant="strong" size="sm">
        Image checks ({warnings.totalImages} image{warnings.totalImages === 1 ? '' : 's'})
      </Text>
      {warnings.shown.length === 0 ? (
        <Text variant="muted" size="sm">
          No image issues found.
        </Text>
      ) : (
        warnings.shown.map((line) => (
          <Text key={line} variant="muted" size="sm">
            {line}
          </Text>
        ))
      )}
      {warnings.moreCount > 0 && (
        <Text variant="muted" size="sm">
          …and {warnings.moreCount} more
        </Text>
      )}
      {warnings.note !== undefined && (
        <Text variant="muted" size="sm">
          {warnings.note}
        </Text>
      )}
    </Stack>
  )
}

function AnalysisSection({
  view,
  keywordViews,
  proUnlocked,
  pending,
  openGroups,
  onToggleGroup,
}: {
  view: AnalysisView | null
  /** Per-keyword breakdown (Pro, ≥2 keywords) — null otherwise. */
  keywordViews: KeywordAnalysisView[] | null
  proUnlocked: boolean
  /** A recompute is scheduled/running — the shown view is stale. */
  pending: boolean
  openGroups: Record<string, boolean>
  onToggleGroup: (groupId: string) => void
}) {
  if (view === null) {
    return <Text variant="muted">Analyzing…</Text>
  }
  return (
    // Stale-marker: dim the whole block while a debounced recompute is
    // pending so a half-typed keyword never reads as a settled score.
    <div style={{ opacity: pending ? 0.55 : 1, transition: 'opacity 120ms' }}>
    <Stack gap={12}>
      <Stack gap={12} direction="row" align="center">
        <ScoreBadge score={view.score} tone={view.tone} />
        <Stack gap={2}>
          <Text variant="strong">Content analysis{pending ? ' — updating…' : ''}</Text>
          <Text variant="muted" size="sm">
            {view.statsLine}
          </Text>
        </Stack>
      </Stack>
      {view.notes.map((note) => (
        <Text key={note} variant="muted" size="sm">
          {note}
        </Text>
      ))}
      <Stack gap={8}>
        {view.groups.map((group) => (
          <CheckGroup
            key={group.id}
            group={group}
            open={openGroups[group.id] === true}
            onToggle={() => onToggleGroup(group.id)}
            imageWarnings={view.imageWarnings}
          />
        ))}
      </Stack>
      {keywordViews !== null && keywordViews.length > 0 && (
        // Task 3.4 (Pro): each keyword's own itemization from a dedicated
        // engine pass — the aggregate groups above average across keywords
        // (the engine's full-score path); these lines un-average them.
        // Reuses the collapsible-group UI, keyed off the keyword itself.
        <Stack gap={8}>
          <Text variant="strong" size="sm">
            Per-keyword scores
          </Text>
          {keywordViews.map((kv) => (
            <CheckGroup
              key={`kw:${kv.keyword}`}
              group={{
                id: `kw:${kv.keyword}`,
                label: `“${kv.keyword}”`,
                score: kv.score,
                max: kv.max,
                rows: kv.rows,
              }}
              open={openGroups[`kw:${kv.keyword}`] === true}
              onToggle={() => onToggleGroup(`kw:${kv.keyword}`)}
              imageWarnings={null}
            />
          ))}
        </Stack>
      )}
      {/* §3.4 score ceiling: the locked full-analysis section names what
          Pro would additionally check on THIS entry. Unlocked = the full
          analysis IS the section above — the lock disappears in place. */}
      {!proUnlocked && (
        <ProLock
          action="Full analysis"
          benefit="all readability checks, unlimited keywords, and the full 100-point score."
        />
      )}
    </Stack>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AI suggestions (task 3.8) — Pro affordance under the title/description
// inputs. Rendered ONLY when proUnlocked (the free build's /license 404
// reads as locked, so this never mounts there); the /ai routes stay
// server-gated regardless. A picked suggestion goes through the SAME
// setForm path as typing — normal dirty flow, explicit Save required,
// never an auto-save.
// ---------------------------------------------------------------------------

type SuggestState =
  | { field: SuggestField; kind: 'busy' }
  | { field: SuggestField; kind: 'ready'; suggestions: string[] }
  | { field: SuggestField; kind: 'error'; message: string }

function SuggestControl({
  field,
  aiStatus,
  suggest,
  saving,
  onSuggest,
  onPick,
}: {
  field: SuggestField
  aiStatus: AiStatusView | null
  suggest: SuggestState | null
  saving: boolean
  onSuggest: (field: SuggestField) => void
  onPick: (field: SuggestField, value: string) => void
}) {
  const busy = saving || suggest?.kind === 'busy'
  const view = suggestButtonView(aiStatus, busy)
  const mine = suggest !== null && suggest.field === field ? suggest : null
  return (
    <Stack gap={6}>
      {/* The host-ui Button wrapper forwards no tooltip/title prop, so the
          honest disabled-state tooltip rides a plain wrapper title —
          native browser tooltips fire on wrappers of disabled buttons. */}
      <Stack gap={8} direction="row" align="center">
        <span title={view.tooltip}>
          <Button
            variant="ghost"
            size="sm"
            disabled={view.disabled}
            onClick={() => onSuggest(field)}
          >
            {mine?.kind === 'busy' ? 'Suggesting…' : '✦ Suggest'}
          </Button>
        </span>
        {view.tooltip !== undefined && (
          <Text variant="muted" size="sm">
            {view.tooltip}
          </Text>
        )}
      </Stack>
      {mine?.kind === 'ready' && (
        <Stack gap={4}>
          {mine.suggestions.map((suggestion, index) => (
            <SuggestionOption
              key={`${field}:${index}:${suggestion}`}
              text={suggestion}
              onPick={(value) => onPick(field, value)}
            />
          ))}
          <Text variant="muted" size="sm">
            Click a suggestion to fill the field — then Save to keep it.
          </Text>
        </Stack>
      )}
      {mine?.kind === 'error' && (
        <Text variant="muted" size="sm">
          Suggestion failed: {mine.message}
        </Text>
      )}
    </Stack>
  )
}

// ---------------------------------------------------------------------------
// Panel body
// ---------------------------------------------------------------------------

export function SeoPanel() {
  const routes = usePluginRoutes()
  const activeDocument = useEditorStore((s) => (s as unknown as StoreShape).activeDocument)
  const activePageId = useEditorStore((s) => (s as unknown as StoreShape).activePageId)
  const site = useEditorStore((s) => (s as unknown as StoreShape).site)

  const pageId =
    activeDocument === null
      ? activePageId
      : activeDocument.kind === 'page'
        ? activeDocument.pageId
        : null
  const page = pageId !== null ? (site?.pages.find((p) => p.id === pageId) ?? null) : null

  const [load, setLoad] = useState<MetaLoad & { forPageId?: string }>({ kind: 'loading' })
  const [form, setForm] = useState<MetaFormState>({
    title: '',
    metaDescription: '',
    focusKeywords: [],
  })
  const [device, setDevice] = useState<SerpDevice>('desktop')
  const [saving, setSaving] = useState(false)
  const [saveErrors, setSaveErrors] = useState<FieldError[]>([])
  const [confirmClear, setConfirmClear] = useState(false)
  // Set when DELETE /meta reports `complete: false` — stale records survived
  // the sweep and the panel is showing what is STILL stored, not a clean slate.
  const [clearWarning, setClearWarning] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  // Request-generation counter (staleness fix): bumped whenever the edited
  // page changes or the panel reloads/unmounts. Every async path captures
  // the generation at start and drops its commit on mismatch, so a slow
  // save/clear/load for page A can never strand or corrupt page B's view.
  const generation = useRef(0)

  // In-flight WRITES, keyed by page id (t4-38 reload race). The generation
  // counter alone only guards the UI COMMIT — it does not order a later
  // reload GET behind a still-in-flight POST/DELETE for the same page.
  // Switch away from page A mid-save and back again and the fresh GET can
  // be served BEFORE the write lands, repainting the pre-save value; the
  // panel then holds a stale field that the next save writes back over the
  // committed one. The loader awaits whatever is registered here for the
  // page it is about to read, so a page's GET can never overtake its own
  // write. The promise never rejects (runWrite handles its own failures).
  const pendingWrites = useRef(new Map<string, Promise<void>>())

  // Fresh routes helper per render (the host rebuilds it each mount render);
  // kept in a ref so effects/listeners never capture a stale closure.
  const routesRef = useRef(routes)
  routesRef.current = routes

  // (Re)load stored meta + config whenever the edited page changes.
  useEffect(() => {
    if (pageId === null) return
    const gen = ++generation.current
    setLoad({ kind: 'loading', forPageId: pageId })
    setSaveErrors([])
    setConfirmClear(false)
    setClearWarning(null)
    // Suggestions belong to the page they were generated for (task 3.8) —
    // a page switch clears any open picker/error (in-flight requests are
    // already generation-invalidated).
    setSuggest(null)
    // A write in flight for the PREVIOUS page is generation-invalidated and
    // will never clear its own flag — reset it for the new page here.
    setSaving(false)
    void (async () => {
      // Ordering guard (t4-38): never GET a page's meta while a write for
      // that SAME page is still in flight — the GET could be served first
      // and paint the pre-save value back into the panel.
      const inFlight = pendingWrites.current.get(pageId)
      if (inFlight !== undefined) await inFlight
      const result = await loadPanelData(routesRef.current, pageId)
      if (generation.current !== gen) return
      setLoad({ ...result, forPageId: pageId })
      if (result.kind === 'ready') setForm(formFromMeta(result.stored))
    })()
    return () => {
      generation.current++ // invalidate in-flight completions for this page
    }
  }, [pageId, reloadTick])

  // -------------------------------------------------------------------------
  // License state (task 3.4): GET /license on mount + on window refocus
  // (the /config refresh discipline below). PAGE-INDEPENDENT, so it gets
  // its own generation counter instead of riding the per-page one — a
  // page switch must not invalidate an in-flight license read. Any
  // failure (the free build's 404 included) reads as LOCKED; `proUnlocked`
  // is the single boolean the Pro UI branches on (and the prop the social
  // preview component will consume).
  // -------------------------------------------------------------------------
  const [proUnlocked, setProUnlocked] = useState(false)
  const licenseGeneration = useRef(0)
  // Refetch-storm fix: focus + visibilitychange fire back-to-back (and both
  // register the same pair of callbacks), so the raw fetch goes through a
  // coalescing gate — concurrent callers share the in-flight promise, and a
  // settled fetch is not repeated within the minimum interval. The
  // generation guard on the commit below is unchanged.
  const licenseGate = useRef(createLicenseRefetchGate())
  function refreshLicense(): Promise<void> {
    return licenseGate.current(async () => {
      const gen = ++licenseGeneration.current
      let unlocked = false
      try {
        const res = await routesRef.current.fetch(LICENSE_ROUTE)
        const body: unknown = res.ok ? await res.json().catch(() => null) : null
        unlocked = proUnlockedFromResponse(res.ok, body)
      } catch {
        // network failure = locked (unlocked stays false)
      }
      if (licenseGeneration.current === gen) setProUnlocked(unlocked)
    })
  }
  const refreshLicenseRef = useRef(refreshLicense)
  refreshLicenseRef.current = refreshLicense
  useEffect(() => {
    void refreshLicenseRef.current()
    return () => {
      licenseGeneration.current++ // drop in-flight completions on unmount
    }
  }, [])

  // -------------------------------------------------------------------------
  // AI provider status (task 3.8): GET /ai/status ONCE per unlock — the
  // license fetch pattern (page-independent, own generation counter).
  // Fetched only when proUnlocked (the route is withProGate'd server-side;
  // the free build never unlocks, so it never fires there). null = unknown
  // → the Suggest buttons stay disabled without a tooltip claim.
  // -------------------------------------------------------------------------
  const [aiStatus, setAiStatus] = useState<AiStatusView | null>(null)
  const aiStatusGeneration = useRef(0)
  useEffect(() => {
    const gen = ++aiStatusGeneration.current
    if (!proUnlocked) {
      setAiStatus(null)
      return
    }
    void (async () => {
      let status: AiStatusView | null = null
      try {
        const res = await routesRef.current.fetch(AI_STATUS_ROUTE)
        if (res.ok) status = parseAiStatus(await res.json().catch(() => null))
      } catch {
        // network failure = unknown (status stays null, button disabled)
      }
      if (aiStatusGeneration.current === gen) setAiStatus(status)
    })()
    return () => {
      aiStatusGeneration.current++ // drop in-flight completions
    }
  }, [proUnlocked])

  // Suggestion request state — PER PAGE (reset on page switch below) and
  // request-generation guarded: a slow response for page A can never paint
  // a picker over page B.
  const [suggest, setSuggest] = useState<SuggestState | null>(null)

  function requestSuggestions(field: SuggestField): void {
    const targetPageId = pageIdRef.current
    if (targetPageId === null || suggest?.kind === 'busy') return
    const gen = generation.current
    setSuggest({ field, kind: 'busy' })
    void (async () => {
      let next: SuggestState
      try {
        const res = await routesRef.current.fetch(AI_SUGGEST_ROUTE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table: PAGES_TABLE_SLUG, entry: targetPageId, field }),
        })
        const result = parseSuggestResult(await res.json().catch(() => null), res.status)
        next = result.ok
          ? { field, kind: 'ready', suggestions: result.suggestions }
          : { field, kind: 'error', message: result.message }
      } catch (err) {
        next = {
          field,
          kind: 'error',
          message: err instanceof Error && err.message !== '' ? err.message : 'request error',
        }
      }
      if (generation.current === gen) setSuggest(next)
    })()
  }

  /** Fill the form field through the SAME state path as typing — normal
   * dirty flow, explicit Save still required. */
  function pickSuggestion(field: SuggestField, value: string): void {
    setForm((f) => (field === 'title' ? { ...f, title: value } : { ...f, metaDescription: value }))
    setSuggest(null)
  }

  // Refetch /config (preview inputs only — never the form) when the window
  // regains focus/visibility, so settings saved in another tab show up.
  const pageIdRef = useRef(pageId)
  pageIdRef.current = pageId
  async function refreshConfig(): Promise<void> {
    const targetPageId = pageIdRef.current
    if (targetPageId === null) return
    const gen = generation.current
    try {
      const res = await routesRef.current.fetch('/config')
      if (!res.ok) return // non-blocking — keep the last known config
      const config = await readJson<SeoConfigData>(res)
      if (generation.current !== gen) return
      setLoad((prev) =>
        prev.kind === 'ready' && prev.forPageId === targetPageId ? { ...prev, config } : prev,
      )
    } catch {
      // non-blocking
    }
  }
  const refreshConfigRef = useRef(refreshConfig)
  refreshConfigRef.current = refreshConfig
  useEffect(() => {
    const onFocus = () => {
      void refreshConfigRef.current()
      void refreshLicenseRef.current()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refreshConfigRef.current()
        void refreshLicenseRef.current()
      }
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // -------------------------------------------------------------------------
  // Content analysis: serialization is memoized per page-object identity
  // (a title keystroke must NOT re-serialize the tree — only a store
  // mutation produces a fresh page object), and the full inputs snapshot
  // is built INSIDE the debounced callback from the latest render's
  // values. The page tree arrives through the same store subscription that
  // renders the panel, so draft edits change the `content` identity and
  // re-arm the debounce — no separate refetch loop (content source a).
  // -------------------------------------------------------------------------
  // Tier-tagged (license-downgrade fix): the state carries the tier it was
  // COMPUTED under; rendering resolves it against the CURRENT tier via
  // analysisDisplayForTier, so a license flip suppresses Pro presentation
  // instantly instead of waiting out the debounce.
  const [analysisState, setAnalysisState] = useState<TierTaggedAnalysis | null>(null)
  const [analysisPending, setAnalysisPending] = useState(false)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  const content = useMemo(
    () => (page === null ? null : buildContentSource(page)),
    [page],
  )

  // Tier gate (task 3.4): locked = the free slot-0 slice (only the PRIMARY
  // slot's keyword is scored; an empty primary scores nothing even when
  // Pro extras are stored); unlocked = the full normalized list.
  const scoredKeywords = scoredKeywordsForTier(form.focusKeywords, proUnlocked)

  const analysisReady =
    pageId !== null &&
    page !== null &&
    load.kind === 'ready' &&
    load.forPageId === pageId &&
    content !== null

  // Latest-render snapshot builder — read inside the debounced timeout so
  // the computation always sees current values without re-arming on every
  // object-identity change.
  const buildSnapshotRef = useRef<() => AnalysisInputs | null>(() => null)
  buildSnapshotRef.current = () => {
    if (
      pageId === null ||
      page === null ||
      load.kind !== 'ready' ||
      load.forPageId !== pageId ||
      content === null
    ) {
      return null
    }
    const metaNow = applyFormToMeta(load.stored, form)
    const analysisPageTitle = site?.settings?.metaTitle ?? page.title
    // Title/description resolve exactly like publish (and the SERP preview):
    // entry override → templates → the host's own <title> → slug.
    const merged = mergeSeoMeta(metaNow, load.config, {
      tableSlug: PAGES_TABLE_SLUG,
      slug: page.slug,
      pageTitle: analysisPageTitle,
    })
    const origin = normalizeSiteOrigin(load.config.site?.siteUrl)
    return {
      ...content,
      title: merged.title ?? (analysisPageTitle !== '' ? analysisPageTitle : page.slug),
      metaDescription: merged.metaDescription,
      slug: page.slug,
      url:
        origin === undefined ? undefined : page.slug === '' ? origin : `${origin}/${page.slug}`,
      focusKeywords: scoredKeywords,
      proUnlocked,
    }
  }

  // Debounce triggers: the cheap text inputs (value key) + the memoized
  // content identity + the load object (fresh stored/config after a save
  // or config refresh).
  const analysisKey = analysisReady
    ? JSON.stringify([pageId, form.title, form.metaDescription, scoredKeywords, proUnlocked])
    : null
  useEffect(() => {
    if (analysisKey === null) {
      setAnalysisState(null)
      setAnalysisPending(false)
      return
    }
    setAnalysisPending(true)
    const handle = setTimeout(() => {
      const inputs = buildSnapshotRef.current()
      if (inputs !== null) {
        const outcome = computeAnalysis(inputs)
        // Tag with the tier the SNAPSHOT was computed under (not the render's
        // current value) — the tag must describe the computation itself.
        setAnalysisState({
          proUnlocked: inputs.proUnlocked,
          view: outcome.view,
          keywordViews: outcome.keywordViews,
        })
      }
      setAnalysisPending(false)
    }, ANALYSIS_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [analysisKey, content, load])

  if (pageId === null || page === null) {
    return (
      <EmptyState
        title="No page selected"
        body="Open a page in the canvas to edit its SEO title and description."
      />
    )
  }

  if (load.kind === 'loading' || load.forPageId !== pageId) {
    return <Text variant="muted">Loading SEO meta…</Text>
  }

  if (load.kind === 'error') {
    return (
      <Stack gap={12}>
        <Alert tone="danger" title="Could not load SEO meta">
          {load.message}
        </Alert>
        <Button variant="secondary" onClick={() => setReloadTick((t) => t + 1)}>
          Retry
        </Button>
      </Stack>
    )
  }

  const { stored, config, publishedImageAudit } = load
  // License-downgrade fix: resolve the tier-tagged analysis state against
  // the CURRENT tier — on any mismatch the aggregate falls back to the
  // locked presentation (ProLock shown) and the per-keyword views hide,
  // instantly, without waiting for the debounced recompute.
  const analysisDisplay = analysisDisplayForTier(analysisState, proUnlocked)
  const dirty = isMetaDirty(stored, form)
  const hasStoredOverrides = Object.keys(stored).length > 0
  const isTemplatePage = page.template?.enabled === true
  // %title% source parity with the publisher's <title> bake:
  // settings.metaTitle ?? page.title ?? site.name (render.ts:326). Both `??`
  // fallbacks skip only null/undefined, so an EMPTY page title passes
  // through VERBATIM here — the shared mergeSeoMeta then applies the same
  // slug fallback the server does (metaBlock.ts: nonEmpty(pageTitle) ?? slug).
  const pageTitle = site?.settings?.metaTitle ?? page.title

  const fieldError = (field: string): string | undefined =>
    saveErrors.find((e) => e.field === field)?.message
  // Keyword errors are `focusKeywords` (list-level) or `focusKeywords.N`
  // (per-item) — exact server field naming, never a loose prefix (a future
  // `focusKeywordsExtra` field must not be swallowed here).
  const isKeywordField = (field: string): boolean =>
    field === 'focusKeywords' || /^focusKeywords\.\d+$/.test(field)
  const keywordError = saveErrors.find((e) => isKeywordField(e.field))?.message
  const genericErrors = saveErrors.filter(
    (e) => e.field !== 'title' && e.field !== 'metaDescription' && !isKeywordField(e.field),
  )

  /**
   * Shared write path for Save and Clear: refetch the entry's meta, plan
   * against the FRESH payload, POST/DELETE, commit (generation-guarded).
   *
   * The write REGISTERS itself in `pendingWrites` for the duration so a
   * later reload of the same page (page-switch-and-back) is sequenced
   * behind it — see the ref's comment. Registration wraps the whole call
   * because `performWrite` never rejects.
   */
  async function runWrite(
    buildPlan: (fresh: SeoMetaPayload) => MetaSavePlan,
    failureLabel: string,
  ): Promise<void> {
    const targetPageId = pageId as string
    const inFlight = performWrite(targetPageId, buildPlan, failureLabel)
    pendingWrites.current.set(targetPageId, inFlight)
    try {
      await inFlight
    } finally {
      // Only clear OUR entry — a newer write for the same page owns the slot.
      if (pendingWrites.current.get(targetPageId) === inFlight) {
        pendingWrites.current.delete(targetPageId)
      }
    }
  }

  async function performWrite(
    targetPageId: string,
    buildPlan: (fresh: SeoMetaPayload) => MetaSavePlan,
    failureLabel: string,
  ): Promise<void> {
    const gen = generation.current
    const savedForm = form
    setSaving(true)
    setSaveErrors([])
    setClearWarning(null)
    try {
      // Refetch-before-write: graft onto the CURRENT server payload, not
      // the possibly-stale one the panel loaded earlier.
      const fresh = await fetchMeta(routesRef.current, targetPageId)
      const plan = buildPlan(fresh)
      if (plan.kind === 'post') {
        // Client-side mirror of the server's validation — same module.
        const validated = validateSeoMeta(plan.payload)
        if (!validated.ok) {
          if (generation.current === gen) setSaveErrors(validated.errors)
          return
        }
      }
      let nextStored: SeoMetaPayload
      if (plan.kind === 'noop') {
        nextStored = fresh
      } else {
        const path = metaPath(targetPageId)
        const res =
          plan.kind === 'delete'
            ? await routesRef.current.fetch(path, { method: 'DELETE' })
            : await routesRef.current.fetch(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(plan.payload),
              })
        if (!res.ok) {
          const errors = await readErrors(res)
          if (generation.current === gen) setSaveErrors(errors)
          return
        }
        if (plan.kind === 'delete') {
          // DELETE /meta answers { deleted, remaining, complete } and sets
          // `complete: false` when duplicate records survived the sweep
          // (server/index.ts — G10 has no unique key, so nothing bounds
          // duplicates). Installing `{}` on an INCOMPLETE delete paints a
          // clean slate over meta that is still stored and still publishes
          // after a reload. Re-read instead, and say so.
          const outcome = parseDeleteOutcome(await res.json().catch(() => null))
          if (outcome.complete) {
            nextStored = {}
          } else {
            nextStored = await fetchMeta(routesRef.current, targetPageId)
            if (generation.current === gen) {
              setClearWarning(
                `${outcome.remaining === null ? 'Some' : String(outcome.remaining)} stored record${outcome.remaining === 1 ? '' : 's'} survived the delete — the panel is showing what is still stored. Clear again to remove the rest.`,
              )
            }
          }
        } else {
          nextStored = await readJson<SeoMetaPayload>(res)
        }
      }
      if (generation.current !== gen) return // page switched mid-write — drop
      setLoad((prev) =>
        prev.kind === 'ready' && prev.forPageId === targetPageId
          ? { ...prev, stored: nextStored }
          : prev,
      )
      setForm((currentForm) => mergeMetaFormAfterSave(nextStored, savedForm, currentForm))
      void refreshConfigRef.current() // pick up settings changed meanwhile
    } catch (err) {
      if (generation.current === gen) {
        setSaveErrors([
          {
            field: '',
            message: err instanceof Error && err.message !== '' ? err.message : failureLabel,
          },
        ])
      }
    } finally {
      if (generation.current === gen) setSaving(false)
    }
  }

  async function save() {
    // Baseline = the form as loaded; narrows the graft to fields this
    // operator actually edited (see applyFormToMeta) so a save cannot
    // revert another admin's concurrent panel edits.
    const baseline = load.kind === 'ready' ? formFromMeta(load.stored) : undefined
    await runWrite((fresh) => planMetaSave(fresh, form, baseline), 'save failed')
  }

  async function clearOverrides() {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    setConfirmClear(false)
    // Clears ONLY the panel-owned fields (title/description); other stored
    // fields survive — DELETE fires only when nothing else is stored.
    await runWrite((fresh) => planMetaClear(fresh), 'clear failed')
  }

  return (
    <Stack gap={16}>
      {isTemplatePage && (
        <Alert tone="warning" title="Template page">
          This page is a template — it renders every matching row, and publish skips
          per-entry SEO overrides for it (a stored canonical would stamp every row).
          Configure a table title template in SEO Settings instead.
        </Alert>
      )}

      <Input
        label="SEO title"
        value={form.title}
        placeholder={pageTitle !== '' ? pageTitle : page.slug}
        invalid={fieldError('title') !== undefined}
        description={
          fieldError('title') ??
          `${form.title.length}/${TITLE_RECOMMENDED_MAX} characters — longer titles truncate in results`
        }
        onChange={(value) => setForm((f) => ({ ...f, title: clampInput(value, TITLE_MAX) }))}
      />
      {/* Task 3.8 (Pro): AI title suggestions — rendered only when Pro is
          unlocked; disabled with an honest tooltip until /ai/status says a
          provider is configured. */}
      {proUnlocked && (
        <SuggestControl
          field="title"
          aiStatus={aiStatus}
          suggest={suggest}
          saving={saving}
          onSuggest={requestSuggestions}
          onPick={pickSuggestion}
        />
      )}

      <Textarea
        label="Meta description"
        value={form.metaDescription}
        rows={4}
        invalid={fieldError('metaDescription') !== undefined}
        description={
          fieldError('metaDescription') ??
          `${form.metaDescription.length}/${DESCRIPTION_RECOMMENDED_MAX} characters — ~160 shown on desktop, ~120 on mobile`
        }
        onChange={(value) =>
          setForm((f) => ({ ...f, metaDescription: clampInput(value, DESCRIPTION_MAX) }))
        }
      />
      {/* Task 3.8 (Pro): AI meta-description suggestions (same affordance). */}
      {proUnlocked && (
        <SuggestControl
          field="metaDescription"
          aiStatus={aiStatus}
          suggest={suggest}
          saving={saving}
          onSuggest={requestSuggestions}
          onPick={pickSuggestion}
        />
      )}

      {proUnlocked ? (
        // Task 3.4 (Pro): every stored keyword is editable and scored, up
        // to the server's stored cap. An empty slot simply normalizes away
        // on save (metaForm.normalizeKeywords) — no destructive trimming
        // while typing.
        <Stack gap={6}>
          {(form.focusKeywords.length === 0 ? [''] : form.focusKeywords).map(
            (keyword, index) => {
              const slotError = fieldError(`focusKeywords.${index}`)
              return (
                <Stack key={index} gap={8} direction="row" align="center">
                  <Input
                    label={index === 0 ? 'Focus keyword' : `Keyword ${index + 1}`}
                    value={keyword}
                    placeholder={
                      index === 0 ? 'Phrase this page should rank for' : 'Another phrase to score'
                    }
                    invalid={slotError !== undefined}
                    description={
                      slotError ??
                      (index === 0
                        ? 'Scored live in the content analysis below.'
                        : 'Also scored in the analysis below.')
                    }
                    onChange={(value) =>
                      setForm((f) => {
                        const next = f.focusKeywords.length === 0 ? [''] : [...f.focusKeywords]
                        next[index] = clampInput(value, FOCUS_KEYWORD_MAX)
                        return { ...f, focusKeywords: next }
                      })
                    }
                  />
                  {index > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      ariaLabel={`Remove keyword ${index + 1}`}
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          focusKeywords: f.focusKeywords.filter((_, i) => i !== index),
                        }))
                      }
                    >
                      Remove
                    </Button>
                  )}
                </Stack>
              )
            },
          )}
          {fieldError('focusKeywords') !== undefined && (
            <Text variant="muted" size="sm">
              {fieldError('focusKeywords')}
            </Text>
          )}
          {canAddKeyword(Math.max(form.focusKeywords.length, 1), proUnlocked) ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setForm((f) => ({
                  ...f,
                  focusKeywords: [...(f.focusKeywords.length === 0 ? [''] : f.focusKeywords), ''],
                }))
              }
            >
              + Add another keyword
            </Button>
          ) : (
            <Text variant="muted" size="sm">
              Up to {KEYWORD_CAP} keywords per page.
            </Text>
          )}
        </Stack>
      ) : (
        <Stack gap={6}>
          <Input
            label="Focus keyword"
            value={form.focusKeywords[0] ?? ''}
            placeholder="Phrase this page should rank for"
            invalid={keywordError !== undefined}
            description={keywordError ?? 'Scored live in the content analysis below.'}
            onChange={(value) =>
              setForm((f) => ({
                ...f,
                focusKeywords: [clampInput(value, FOCUS_KEYWORD_MAX), ...f.focusKeywords.slice(1)],
              }))
            }
          />
          {/* §3.4 second-keyword trigger — shared locked-in-place affordance. */}
          <ProLock action="+ Add another keyword" benefit="up to 10 scored focus keywords per page." />
          {form.focusKeywords.length > FREE_KEYWORD_LIMIT && (
            <Text variant="muted" size="sm">
              Also stored: {form.focusKeywords.slice(FREE_KEYWORD_LIMIT).join(', ')} — kept on
              save; editing them needs Pro.
            </Text>
          )}
        </Stack>
      )}

      {genericErrors.length > 0 && (
        <Alert tone="danger" title="Save failed">
          {genericErrors.map((e) => (e.field !== '' ? `${e.field}: ${e.message}` : e.message)).join('; ')}
        </Alert>
      )}

      {/* DELETE reported survivors — an honest partial beats a silent one. */}
      {clearWarning !== null && (
        <Alert tone="warning" title="Clear was incomplete">
          {clearWarning}
        </Alert>
      )}

      <Stack gap={8} direction="row" align="center">
        <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {hasStoredOverrides && (
          <Button
            variant={confirmClear ? 'destructive' : 'ghost'}
            size="sm"
            disabled={saving}
            onClick={() => void clearOverrides()}
          >
            {confirmClear ? 'Confirm clear' : 'Clear SEO fields'}
          </Button>
        )}
        {confirmClear && (
          <Text variant="muted" size="sm">
            Removes the stored SEO title, description and focus keywords for this
            page. Other stored SEO fields (canonical, robots, OG) are kept.
          </Text>
        )}
      </Stack>

      <Separator />

      <Stack gap={8}>
        <Stack gap={8} direction="row" align="center" justify="between">
          <Text variant="strong">Search preview</Text>
          <RangeTabs
            value={device}
            ariaLabel="Preview device"
            options={[
              { value: 'desktop', label: 'Desktop' },
              { value: 'mobile', label: 'Mobile' },
            ]}
            onChange={setDevice}
          />
        </Stack>
        <SerpPreviewCard
          meta={applyFormToMeta(stored, form)}
          config={config}
          slug={page.slug}
          pageTitle={pageTitle}
          device={device}
        />
        {(() => {
          // Task 3.4: social preview cards share the SERP preview's exact
          // resolution chain (mergeSeoMeta parity) but pass UNtruncated
          // values — SocialPreviews applies the platforms' own limits.
          const metaNow = applyFormToMeta(stored, form)
          const merged = mergeSeoMeta(metaNow, config, {
            tableSlug: PAGES_TABLE_SLUG,
            slug: page.slug,
            pageTitle,
          })
          return (
            <SocialPreviews
              proUnlocked={proUnlocked}
              title={merged.title ?? (pageTitle !== undefined && pageTitle !== '' ? pageTitle : page.slug)}
              description={merged.metaDescription ?? ''}
              ogTitle={metaNow.ogTitle}
              ogDescription={metaNow.ogDescription}
              ogImage={metaNow.ogImage}
              twitterCard={metaNow.twitterCard}
              siteUrl={normalizeSiteOrigin(config.site?.siteUrl) ?? ''}
              slug={page.slug}
              siteName={config.site?.siteName ?? ''}
            />
          )
        })()}
      </Stack>

      <Separator />

      <AnalysisSection
        view={analysisDisplay.view}
        keywordViews={analysisDisplay.keywordViews}
        proUnlocked={analysisDisplay.proUnlocked}
        pending={analysisPending}
        openGroups={openGroups}
        onToggleGroup={(groupId) =>
          setOpenGroups((prev) => ({ ...prev, [groupId]: prev[groupId] !== true }))
        }
      />

      {publishedImageAudit !== null && (
        // Task 2.4 — PUBLISHED-page image audit (tree-source honesty: the
        // analysis above runs over the live DRAFT tree; this line reports
        // what the last publish actually baked, joined from the sitemap
        // record via GET /meta).
        <Text variant="muted" size="sm">
          Published-page image findings: {publishedImageAudit.findings} (
          {publishedImageAudit.totalImages} image
          {publishedImageAudit.totalImages === 1 ? '' : 's'} on the published page
          {publishedImageAudit.lastmod !== undefined
            ? `, as of ${publishedImageAudit.lastmod.slice(0, 10)}`
            : ''}
          )
        </Text>
      )}
    </Stack>
  )
}

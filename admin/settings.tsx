/**
 * SEO Settings admin app (task 1.4) — the `adminPages` kind-'app' entry.
 * Declared in the manifest as `entry: 'admin/settings.js'`; the CLI build
 * bundles this .tsx source to that path (cli/build.ts:322-347) with the
 * host-runtime externals, and the host mounts the default export inside
 * `PluginPageRenderer` with a `PluginContext` provider (admin routes,
 * settings, permissions — PluginPageRenderer.tsx:185-208). Gated by the
 * `editor.code` + `admin.navigation` permissions (manifest.ts:465-491).
 *
 * Two tabs:
 *   General — site defaults (siteName, separator, siteUrl, default meta
 *             description) + the IndexNow toggle (task 2.2, wired through
 *             the same dirty-merge machinery to `indexNow.enabled`).
 *   Titles  — site default title template + per-table template rows, each
 *             with a live SAMPLE preview rendered by the SAME
 *             templateEngine the publish filter uses (sample vars — there
 *             is no real entry on this page, so the output is labeled as
 *             a sample).
 *
 * Save model (lost-update fix): explicit Save; POST /config is a FULL
 * REPLACE, so saving a stale in-memory document would clobber another
 * admin's concurrent edits. The form therefore tracks dirtiness PER SITE
 * FIELD and PER TABLE ROW (rows carry stable ids), and Save (1) refetches
 * the stored document, (2) applies only the dirty entries onto that FRESH
 * document (`mergeDirtyConfig` — last-write-wins on exactly the dirty
 * entries, everything else survives), and (3) POSTs the merge. An empty
 * merged document routes to DELETE (the server 400s empty POSTs). The
 * residual fetch→POST window is accepted at this pin (no server revision
 * mechanism, G10-adjacent).
 *
 * Client-side validation reuses the server's `validateSeoConfig`
 * verbatim, so unknown %vars% and non-bare-origin site URLs are caught
 * before any request; 400 field errors from the server map onto the same
 * fields/rows (row errors keyed by stable row id).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Alert,
  Button,
  Card,
  Heading,
  Input,
  RangeTabs,
  Separator,
  Stack,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textarea,
} from '@instatic/host-ui'
import { usePluginContext, usePluginRoutes } from '@instatic/host-hooks'
import { validateSeoConfig, type SeoConfigData } from '../server/seoConfig'
import { TITLE_TEMPLATE_VARS } from '../server/metaBlock'
import type { FieldError } from '../server/seoMeta'
import {
  emptyConfigForm,
  formFromConfig,
  isConfigFormDirty,
  mergeDirtyConfig,
  nextRowId,
  planConfigSave,
  previewTemplate,
  serverErrorsToForm,
  validateConfigForm,
  type ConfigFormState,
  type RowErrors,
  type SameAsErrors,
} from './lib/configForm'
import {
  CONFIG_EXPORT_FILENAME,
  IMPORT_FILE_TOO_LARGE_MESSAGE,
  buildConfigExport,
  diffConfigImport,
  importFileTooLarge,
  importHasChanges,
  importSaveBody,
  parseConfigImport,
  serializeConfigExport,
  type ModeledSection,
  type SectionChange,
} from './lib/configTransfer'
import { isConfigComplete } from './lib/wizard'
import { SetupWizard } from './SetupWizard'
import { ProLock } from './ProLock'
// Pro-only tab modules. The pro-only strip markers are LINE-BASED: the free
// build's staging step deletes every line between (and including) the
// marker lines, so everything marked here must leave the file valid TS
// when removed — which is why the pro tabs/panels are PUSHED into the
// arrays below inside marked statements rather than written inline in
// JSX (where a `//` marker line cannot exist).

type SettingsTab =
  | 'general'
  | 'titles'
  | 'schema'

/**
 * Wizard auto-show dismissal (task 2.6): remembered per browser so an
 * intentionally-skipped setup doesn't nag on every visit; the "Setup
 * guide" button stays available regardless. localStorage failures
 * (private mode) degrade to session-only dismissal.
 */
const WIZARD_DISMISSED_KEY = 'monkeywebs.seo.wizardDismissed'

/**
 * In-memory fallback (review C#7): when localStorage throws (private
 * mode, storage policy), dismissal still sticks at MODULE level — it
 * survives component remounts within the tab session (the admin app
 * bundle stays loaded), and resets only on a full page load.
 */
let wizardDismissedFallback = false

function wizardDismissed(): boolean {
  try {
    return window.localStorage.getItem(WIZARD_DISMISSED_KEY) === '1'
  } catch {
    return wizardDismissedFallback
  }
}

function rememberWizardDismissed(): void {
  wizardDismissedFallback = true
  try {
    window.localStorage.setItem(WIZARD_DISMISSED_KEY, '1')
  } catch {
    // tab-session-only dismissal via the module flag
  }
}

/** Human line for one import-preview section change. */
const CHANGE_LABELS: Record<SectionChange['kind'], string> = {
  added: 'will be set (currently empty)',
  changed: 'will be replaced',
  cleared: 'will be cleared',
  unchanged: 'unchanged',
  kept: 'not in file — kept as stored',
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface RoutesLike {
  fetch: (path: string, init?: RequestInit) => Promise<Response>
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
    // fall through
  }
  return [{ field: '', message: `request failed with ${res.status}` }]
}

async function fetchConfig(routes: RoutesLike): Promise<SeoConfigData> {
  const res = await routes.fetch('/config')
  if (!res.ok) {
    const errors = await readErrors(res)
    throw new Error(errors[0]?.message ?? 'could not load SEO settings')
  }
  return (await res.json()) as SeoConfigData
}

type ConfigLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; stored: SeoConfigData }
  | { kind: 'error'; message: string }

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function TemplatePreview({ template, form }: { template: string; form: ConfigFormState }) {
  const rendered = previewTemplate(template, form)
  if (rendered === '') return null
  // Rendered from INVENTED sample vars (there is no real entry here) —
  // labeled as a sample so it is not mistaken for server-exact output.
  return (
    <Text variant="muted" size="sm">
      Sample: {rendered}
    </Text>
  )
}

const TEMPLATE_HELP = `Variables: ${TITLE_TEMPLATE_VARS.map((v) => `%${v}%`).join(', ')}`

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function SeoSettingsApp() {
  const routes = usePluginRoutes()
  const { pluginId, pluginVersion } = usePluginContext()
  const [tab, setTab] = useState<SettingsTab>('general')
  const [load, setLoad] = useState<ConfigLoad>({ kind: 'loading' })
  const [form, setForm] = useState<ConfigFormState>(emptyConfigForm())
  // The form state the current edits are measured AGAINST — captured from
  // the stored document at load/save time. Dirty tracking (per field, per
  // row id) compares form vs baseline; see mergeDirtyConfig.
  const [baseline, setBaseline] = useState<ConfigFormState>(emptyConfigForm())
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [rowErrors, setRowErrors] = useState<RowErrors>({})
  const [sameAsErrors, setSameAsErrors] = useState<SameAsErrors>({})
  const [genericError, setGenericError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)

  // Setup wizard (task 2.6): auto-shown ONCE per mount when setup is
  // incomplete (no usable stored siteUrl) and not previously dismissed;
  // always revisitable via the "Setup guide" button.
  const [showWizard, setShowWizard] = useState(false)
  const wizardAutoShown = useRef(false)

  // Settings transfer (task 2.6): import preview + transfer status.
  const [importPreview, setImportPreview] = useState<{
    config: SeoConfigData
    presentSections: readonly ModeledSection[]
    changes: SectionChange[]
  } | null>(null)
  const [transferError, setTransferError] = useState<string | null>(null)
  const [transferBusy, setTransferBusy] = useState(false)
  const [importedFlash, setImportedFlash] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // The host rebuilds the routes helper per render — keep the fresh one in
  // a ref so async work never captures a stale closure.
  const routesRef = useRef(routes)
  routesRef.current = routes

  useEffect(() => {
    let cancelled = false
    setLoad({ kind: 'loading' })
    void fetchConfig(routesRef.current)
      .then((stored) => {
        if (cancelled) return
        setLoad({ kind: 'ready', stored })
        const loadedForm = formFromConfig(stored)
        setForm(loadedForm)
        setBaseline(loadedForm)
        if (!wizardAutoShown.current) {
          wizardAutoShown.current = true
          if (!isConfigComplete(stored) && !wizardDismissed()) setShowWizard(true)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoad({
          kind: 'error',
          message:
            err instanceof Error && err.message !== ''
              ? err.message
              : 'could not load SEO settings',
        })
      })
    return () => {
      cancelled = true
    }
  }, [reloadTick])

  if (load.kind === 'loading') {
    return <Text variant="muted">Loading SEO settings…</Text>
  }

  if (load.kind === 'error') {
    return (
      <Stack gap={12}>
        <Alert tone="danger" title="Could not load SEO settings">
          {load.message}
        </Alert>
        <Button variant="secondary" onClick={() => setReloadTick((t) => t + 1)}>
          Retry
        </Button>
      </Stack>
    )
  }

  const validation = validateConfigForm(form)
  const dirty = isConfigFormDirty(form, baseline)
  const hasShownErrors =
    Object.keys(fieldErrors).length > 0 ||
    Object.keys(rowErrors).length > 0 ||
    Object.keys(sameAsErrors).length > 0 ||
    genericError !== null

  function updateForm(patch: Partial<ConfigFormState>) {
    setSavedFlash(false)
    setForm((f) => ({ ...f, ...patch }))
  }

  function updateRow(rowId: number, patch: Partial<{ tableSlug: string; titleTemplate: string }>) {
    setSavedFlash(false)
    setForm((f) => ({
      ...f,
      tableRows: f.tableRows.map((row) => (row.id === rowId ? { ...row, ...patch } : row)),
    }))
  }

  /** Returns true on a successful save (the wizard advances on it). */
  async function save(): Promise<boolean> {
    // 1. Form-shape validation (rows, charsets, duplicates) + the server's
    //    own document validation on the assembled form.
    const result = validateConfigForm(form)
    setFieldErrors(result.fieldErrors)
    setRowErrors(result.rowErrors)
    setSameAsErrors(result.sameAsErrors)
    setGenericError(null)
    setSavedFlash(false)
    if (!result.ok) return false

    setSaving(true)
    try {
      // 2. Refetch-before-write: merge ONLY this form's dirty entries onto
      //    the CURRENT stored document so concurrent edits survive.
      const fresh = await fetchConfig(routesRef.current)
      const merged = mergeDirtyConfig(fresh, form, baseline)
      // 3. Safety: the merged document must itself validate (e.g. the fresh
      //    document could carry pre-validation legacy data).
      const mergedResult = validateSeoConfig(merged)
      if (!mergedResult.ok) {
        const mapped = serverErrorsToForm(mergedResult.errors, form)
        setFieldErrors(mapped.fieldErrors)
        setRowErrors(mapped.rowErrors)
        setSameAsErrors(mapped.sameAsErrors)
        const unmapped = mergedResult.errors.find((e) => e.field === '')
        if (unmapped) setGenericError(unmapped.message)
        return false
      }

      // POST body: every section this form MODELS is sent EXPLICITLY
      // (present-but-empty `{}` = clear) — see explicitSectionBody for
      // the 2.3 presence-semantics citation. Sending only the non-empty
      // sections would silently resurrect stored sections the user just
      // emptied (e.g. re-enabling IndexNow, clearing the schema tab);
      // sections the form does NOT model are omitted so server
      // carry-forward protects them, and the fresh raw document gates
      // the DELETE path for the same reason (review B2#2).
      const plan = planConfigSave(mergedResult.value, fresh as Record<string, unknown>)
      const res =
        plan.kind === 'delete'
          ? await routesRef.current.fetch('/config', { method: 'DELETE' })
          : await routesRef.current.fetch('/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(plan.body),
            })
      if (!res.ok) {
        const errors = await readErrors(res)
        const mapped = serverErrorsToForm(errors, form)
        setFieldErrors(mapped.fieldErrors)
        setRowErrors(mapped.rowErrors)
        setSameAsErrors(mapped.sameAsErrors)
        const unmapped = errors.find((e) => e.field === '')
        if (unmapped) setGenericError(unmapped.message)
        return false
      }
      const nextStored: SeoConfigData =
        plan.kind === 'delete' ? {} : ((await res.json()) as SeoConfigData)
      setLoad({ kind: 'ready', stored: nextStored })
      const nextForm = formFromConfig(nextStored)
      setForm(nextForm)
      setBaseline(nextForm)
      setSavedFlash(true)
      return true
    } catch (err) {
      setGenericError(
        err instanceof Error && err.message !== '' ? err.message : 'saving settings failed',
      )
      return false
    } finally {
      setSaving(false)
    }
  }

  // -------------------------------------------------------------------------
  // Settings transfer (task 2.6) — export download + validated import
  // -------------------------------------------------------------------------

  /** Export the CURRENT stored document (freshly fetched) as a JSON file. */
  async function exportSettings(): Promise<void> {
    setTransferError(null)
    setImportedFlash(false)
    setTransferBusy(true)
    try {
      const fresh = await fetchConfig(routesRef.current)
      const text = serializeConfigExport(
        buildConfigExport(fresh, pluginVersion, new Date().toISOString()),
      )
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
      try {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = CONFIG_EXPORT_FILENAME
        anchor.click()
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      setTransferError(
        err instanceof Error && err.message !== '' ? err.message : 'export failed',
      )
    } finally {
      setTransferBusy(false)
    }
  }

  /** Parse a picked file and build the per-section change preview. */
  async function previewImport(file: File): Promise<void> {
    setTransferError(null)
    setImportedFlash(false)
    setImportPreview(null)
    // Size gate BEFORE reading the file into memory (review C#5).
    if (importFileTooLarge(file.size)) {
      setTransferError(IMPORT_FILE_TOO_LARGE_MESSAGE)
      return
    }
    setTransferBusy(true)
    try {
      const parsed = parseConfigImport(await file.text())
      if (!parsed.ok) {
        setTransferError(
          parsed.errors
            .map((e) => (e.field !== '' ? `${e.field}: ${e.message}` : e.message))
            .join('; '),
        )
        return
      }
      // Diff against the CURRENT stored document (fresh fetch — the same
      // document the confirm-POST's presence semantics run against).
      const fresh = await fetchConfig(routesRef.current)
      setImportPreview({
        config: parsed.config,
        presentSections: parsed.presentSections,
        changes: diffConfigImport(fresh, parsed.config, parsed.presentSections),
      })
    } catch (err) {
      setTransferError(
        err instanceof Error && err.message !== '' ? err.message : 'could not read the file',
      )
    } finally {
      setTransferBusy(false)
    }
  }

  /**
   * Apply a previewed import: POST exactly the file's present sections
   * (present = authoritative incl. `{}` = clear — the 2.3 presence
   * semantics); sections absent from the file, INCLUDING any the server
   * knows but this client doesn't model, are carried forward untouched.
   */
  async function applyImport(): Promise<void> {
    if (importPreview === null) return
    setTransferError(null)
    setTransferBusy(true)
    try {
      const body = importSaveBody(importPreview.config, importPreview.presentSections)
      const res = await routesRef.current.fetch('/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errors = await readErrors(res)
        setTransferError(
          errors
            .map((e) => (e.field !== '' ? `${e.field}: ${e.message}` : e.message))
            .join('; '),
        )
        return
      }
      const nextStored = (await res.json()) as SeoConfigData
      setLoad({ kind: 'ready', stored: nextStored })
      const nextForm = formFromConfig(nextStored)
      setForm(nextForm)
      setBaseline(nextForm)
      setImportPreview(null)
      setImportedFlash(true)
    } catch (err) {
      setTransferError(
        err instanceof Error && err.message !== '' ? err.message : 'import failed',
      )
    } finally {
      setTransferBusy(false)
    }
  }

  function closeWizard(): void {
    rememberWizardDismissed()
    setShowWizard(false)
  }

  // Pro-only tabs + panels: pushed inside the marked block so the free
  // build (which strips every line between the pro-only strip markers,
  // inclusive) is left with valid empty arrays — see the marker note at
  // the imports. Rendered via {proTabs}/{proPanels} below, which is a
  // no-op when the arrays stay empty.
  const proTabs: ReactNode[] = []
  const proPanels: ReactNode[] = []

  if (showWizard) {
    return (
      <SetupWizard
        pluginId={pluginId}
        form={form}
        fieldErrors={fieldErrors}
        dirty={dirty}
        saving={saving}
        storedConfig={load.stored}
        updateForm={updateForm}
        save={save}
        fetchRoute={(path) => routesRef.current.fetch(path)}
        onClose={closeWizard}
      />
    )
  }

  return (
    <Stack gap={16}>
      <Stack gap={8} direction="row" align="center" justify="between">
        <Text variant="muted" size="sm">
          {/* C#1: "configured" ≠ "serving" — a complete config still needs a
              published site before the sitemap/canonicals go live. */}
          {isConfigComplete(load.stored)
            ? 'Configuration complete — settings reach published pages on the next publish.'
            : 'Configuration incomplete — the guide walks through the essentials.'}
        </Text>
        <Button variant="secondary" size="sm" onClick={() => setShowWizard(true)}>
          Setup guide
        </Button>
      </Stack>

      <Tabs value={tab} onChange={setTab}>
        <TabList ariaLabel="SEO settings sections">
          <Tab value="general">General</Tab>
          <Tab value="titles">Titles</Tab>
          <Tab value="schema">Schema</Tab>
          {proTabs}
        </TabList>

        <TabPanel value="general" keepMounted>
          <Card>
            <Stack gap={16}>
              <Heading level={2}>Site defaults</Heading>
              <Input
                label="Site name"
                value={form.siteName}
                placeholder="Acme Inc."
                invalid={fieldErrors['site.siteName'] !== undefined}
                description={fieldErrors['site.siteName'] ?? 'Feeds %site% in title templates.'}
                onChange={(value) => updateForm({ siteName: value })}
              />
              <Input
                label="Title separator"
                value={form.separator}
                placeholder="-"
                invalid={fieldErrors['site.separator'] !== undefined}
                description={
                  fieldErrors['site.separator'] ?? 'Feeds %sep% in title templates (default: -).'
                }
                onChange={(value) => updateForm({ separator: value })}
              />
              <Input
                label="Site URL"
                type="url"
                value={form.siteUrl}
                placeholder="https://example.com"
                invalid={fieldErrors['site.siteUrl'] !== undefined}
                description={
                  fieldErrors['site.siteUrl'] ??
                  'Bare origin only (no path) — the base for canonical and og:image URLs.'
                }
                onChange={(value) => updateForm({ siteUrl: value })}
              />
              <Textarea
                label="Default meta description"
                value={form.metaDescription}
                rows={3}
                invalid={fieldErrors['site.metaDescription'] !== undefined}
                description={
                  fieldErrors['site.metaDescription'] ??
                  'Used when an entry has no meta description of its own.'
                }
                onChange={(value) => updateForm({ metaDescription: value })}
              />
              <Separator />
              <Heading level={2}>Indexing</Heading>
              <Switch
                label="IndexNow instant indexing"
                checked={form.indexNowEnabled}
                description={
                  fieldErrors['indexNow.enabled'] ??
                  'Notify search engines (Bing, Yandex, …) when published pages change.'
                }
                onChange={(next) => updateForm({ indexNowEnabled: next })}
              />
              {fieldErrors['indexNow.enabled'] !== undefined && (
                <Text variant="muted" size="sm">
                  {fieldErrors['indexNow.enabled']}
                </Text>
              )}
              <Separator />
              <Heading level={2}>Redirects</Heading>
              {/* Vendor-proven (server/redirects/hostMoves.ts header): page
                  slug renames get NO host-served 301 at this pin — never
                  claim enforcement here. */}
              <Text variant="muted" size="sm">
                Renaming a page changes its URL. The host does not redirect the old
                address — it returns 404 unless you cover it with a redirect rule applied
                at your reverse proxy (Pro exports rules for nginx, Caddy, Cloudflare, or
                CSV).
              </Text>
              {/* §3.4 redirect moment: manual redirects are the Pro trigger. */}
              <ProLock
                action="Create redirect"
                benefit="manual 301/302/410 and regex redirects, with CSV import/export."
              />
              <Separator />
              <Heading level={2}>Analytics</Heading>
              <Switch
                label="First-party page-view counts"
                checked={form.analyticsEnabled}
                description={
                  fieldErrors['analytics.enabled'] ??
                  'Counts page views and 404 hits with a small first-party script — no third-party services.'
                }
                onChange={(next) => updateForm({ analyticsEnabled: next })}
              />
              <Text variant="muted" size="sm">
                Privacy: daily per-path counts only — page paths are recorded without query
                strings, with no cookies, no visitor identifiers, and no IP storage; browsers
                with Do&nbsp;Not&nbsp;Track or Global Privacy Control are never counted. Off by
                default; published pages pick the change up on the next publish.
              </Text>
              <Separator />
              <Heading level={2}>Site verification</Heading>
              <Text variant="muted" size="sm">
                Paste the bare token or the full &lt;meta&gt; tag the service shows — it is
                stripped down to the token and baked into every published page.
              </Text>
              <Input
                label="Google Search Console"
                value={form.verificationGoogle}
                placeholder='Token or <meta name="google-site-verification" …>'
                invalid={fieldErrors['verification.google'] !== undefined}
                description={fieldErrors['verification.google']}
                onChange={(value) => updateForm({ verificationGoogle: value })}
              />
              <Input
                label="Bing Webmaster Tools"
                value={form.verificationBing}
                placeholder='Token or <meta name="msvalidate.01" …>'
                invalid={fieldErrors['verification.bing'] !== undefined}
                description={fieldErrors['verification.bing']}
                onChange={(value) => updateForm({ verificationBing: value })}
              />
              <Input
                label="Pinterest"
                value={form.verificationPinterest}
                placeholder='Token or <meta name="p:domain_verify" …>'
                invalid={fieldErrors['verification.pinterest'] !== undefined}
                description={fieldErrors['verification.pinterest']}
                onChange={(value) => updateForm({ verificationPinterest: value })}
              />
            </Stack>
          </Card>
        </TabPanel>

        <TabPanel value="titles" keepMounted>
          <Stack gap={16}>
            <Card>
              <Stack gap={12}>
                <Heading level={2}>Default title template</Heading>
                <Input
                  label="Site title template"
                  value={form.siteTitleTemplate}
                  placeholder="%title% %sep% %site%"
                  invalid={fieldErrors['site.titleTemplate'] !== undefined}
                  description={fieldErrors['site.titleTemplate'] ?? TEMPLATE_HELP}
                  onChange={(value) => updateForm({ siteTitleTemplate: value })}
                />
                <TemplatePreview template={form.siteTitleTemplate} form={form} />
              </Stack>
            </Card>

            <Card>
              <Stack gap={12}>
                <Heading level={2}>Per-table title templates</Heading>
                <Text variant="muted">
                  Override the default template for one table&apos;s entries (e.g.{' '}
                  <code>posts</code>). The per-entry SEO title always wins over any template.
                </Text>
                {form.tableRows.length === 0 && (
                  <Text variant="muted" size="sm">
                    No per-table templates yet.
                  </Text>
                )}
                {form.tableRows.map((row, index) => (
                  <Stack key={row.id} gap={8}>
                    <Stack gap={8} direction="row" align="start">
                      <Input
                        label={index === 0 ? 'Table slug' : undefined}
                        value={row.tableSlug}
                        placeholder="posts"
                        invalid={rowErrors[row.id]?.tableSlug !== undefined}
                        description={rowErrors[row.id]?.tableSlug}
                        onChange={(value) => updateRow(row.id, { tableSlug: value })}
                      />
                      <Input
                        label={index === 0 ? 'Title template' : undefined}
                        value={row.titleTemplate}
                        placeholder="%title% %sep% %site%"
                        invalid={rowErrors[row.id]?.titleTemplate !== undefined}
                        description={rowErrors[row.id]?.titleTemplate}
                        onChange={(value) => updateRow(row.id, { titleTemplate: value })}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        ariaLabel={`Remove template for ${row.tableSlug !== '' ? row.tableSlug : `row ${index + 1}`}`}
                        onClick={() => {
                          setSavedFlash(false)
                          setForm((f) => ({
                            ...f,
                            tableRows: f.tableRows.filter((r) => r.id !== row.id),
                          }))
                          // Drop this row's errors; other rows keep theirs by id.
                          setRowErrors((prev) => {
                            const next = { ...prev }
                            delete next[row.id]
                            return next
                          })
                        }}
                      >
                        Remove
                      </Button>
                    </Stack>
                    <TemplatePreview template={row.titleTemplate} form={form} />
                  </Stack>
                ))}
                <Stack gap={8} direction="row">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setSavedFlash(false)
                      setForm((f) => ({
                        ...f,
                        tableRows: [
                          ...f.tableRows,
                          {
                            // Ids must stay unique against the BASELINE too:
                            // reusing a removed row's id would make the new
                            // row look like an edit of the removed one in
                            // dirty tracking.
                            id: nextRowId([...f.tableRows, ...baseline.tableRows]),
                            tableSlug: '',
                            titleTemplate: '',
                          },
                        ],
                      }))
                    }}
                  >
                    Add table template
                  </Button>
                </Stack>
                <Text variant="muted" size="sm">
                  {TEMPLATE_HELP}
                </Text>
              </Stack>
            </Card>
          </Stack>
        </TabPanel>

        <TabPanel value="schema" keepMounted>
          <Stack gap={16}>
            <Card>
              <Stack gap={16}>
                <Heading level={2}>Structured data</Heading>
                <Switch
                  label="schema.org JSON-LD graph"
                  checked={form.schemaEnabled}
                  description={
                    fieldErrors['schema.enabled'] ??
                    'Bakes a WebSite / WebPage / breadcrumb graph into every published page (on by default).'
                  }
                  onChange={(next) => updateForm({ schemaEnabled: next })}
                />
              </Stack>
            </Card>
            <Card>
              <Stack gap={16}>
                <Heading level={2}>Publisher</Heading>
                <Text variant="muted" size="sm">
                  Shown to search engines as the site&apos;s publisher (Organization or Person
                  node). Leave the name empty to omit the publisher entirely.
                </Text>
                <Stack gap={6}>
                  <Text size="sm">Publisher type</Text>
                  <RangeTabs
                    value={form.publisherKind === '' ? 'organization' : form.publisherKind}
                    ariaLabel="Publisher type"
                    options={[
                      { value: 'organization', label: 'Organization' },
                      { value: 'person', label: 'Person' },
                    ]}
                    onChange={(value) =>
                      updateForm({ publisherKind: value as 'organization' | 'person' })
                    }
                  />
                  {fieldErrors['schema.publisherKind'] !== undefined && (
                    <Text variant="muted" size="sm">
                      {fieldErrors['schema.publisherKind']}
                    </Text>
                  )}
                </Stack>
                <Input
                  label="Publisher name"
                  value={form.publisherName}
                  placeholder="Acme Inc."
                  invalid={fieldErrors['schema.publisherName'] !== undefined}
                  description={fieldErrors['schema.publisherName']}
                  onChange={(value) => updateForm({ publisherName: value })}
                />
                <Input
                  label="Publisher logo URL"
                  value={form.publisherLogoUrl}
                  placeholder="https://example.com/logo.png or /logo.png"
                  invalid={fieldErrors['schema.publisherLogoUrl'] !== undefined}
                  description={
                    fieldErrors['schema.publisherLogoUrl'] ??
                    'Absolute URL, or a site-relative path resolved against the Site URL.'
                  }
                  onChange={(value) => updateForm({ publisherLogoUrl: value })}
                />
              </Stack>
            </Card>
            <Card>
              <Stack gap={12}>
                <Heading level={2}>Publisher profiles (sameAs)</Heading>
                <Text variant="muted">
                  Absolute URLs of the publisher&apos;s official profiles (social accounts,
                  Wikipedia, …) — up to 10.
                </Text>
                {form.sameAsRows.length === 0 && (
                  <Text variant="muted" size="sm">
                    No profile URLs yet.
                  </Text>
                )}
                {form.sameAsRows.map((row, index) => (
                  <Stack key={row.id} gap={8} direction="row" align="start">
                    <Input
                      label={index === 0 ? 'Profile URL' : undefined}
                      value={row.url}
                      placeholder="https://www.linkedin.com/company/acme"
                      invalid={sameAsErrors[row.id] !== undefined}
                      description={sameAsErrors[row.id]}
                      onChange={(value) => {
                        setSavedFlash(false)
                        setForm((f) => ({
                          ...f,
                          sameAsRows: f.sameAsRows.map((r) =>
                            r.id === row.id ? { ...r, url: value } : r,
                          ),
                        }))
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      ariaLabel={`Remove profile URL ${index + 1}`}
                      onClick={() => {
                        setSavedFlash(false)
                        setForm((f) => ({
                          ...f,
                          sameAsRows: f.sameAsRows.filter((r) => r.id !== row.id),
                        }))
                        setSameAsErrors((prev) => {
                          const next = { ...prev }
                          delete next[row.id]
                          return next
                        })
                      }}
                    >
                      Remove
                    </Button>
                  </Stack>
                ))}
                <Stack gap={8} direction="row">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={form.sameAsRows.length >= 10}
                    onClick={() => {
                      setSavedFlash(false)
                      setForm((f) => ({
                        ...f,
                        sameAsRows: [
                          ...f.sameAsRows,
                          // Ids stay unique against the baseline too (same
                          // rule as table rows — see that comment).
                          { id: nextRowId([...f.sameAsRows, ...baseline.sameAsRows]), url: '' },
                        ],
                      }))
                    }}
                  >
                    Add profile URL
                  </Button>
                </Stack>
              </Stack>
            </Card>
          </Stack>
        </TabPanel>

        {proPanels}
      </Tabs>

      <Card>
        <Stack gap={12}>
          <Heading level={2}>Settings transfer</Heading>
          <Text variant="muted" size="sm">
            Export these settings as JSON for reuse on another site; import replaces exactly
            the sections the file contains and keeps everything else as stored.
          </Text>
          <Stack gap={8} direction="row" align="center">
            <Button
              variant="secondary"
              size="sm"
              disabled={transferBusy}
              onClick={() => void exportSettings()}
            >
              Export settings
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={transferBusy}
              onClick={() => fileInputRef.current?.click()}
            >
              Import settings…
            </Button>
            {importedFlash && (
              <Text variant="muted" size="sm">
                Imported.
              </Text>
            )}
          </Stack>
          {/* Hidden picker — resets its value so re-picking the same file re-fires. */}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file !== undefined) void previewImport(file)
            }}
          />
          {transferError !== null && (
            <Alert tone="danger" title="Settings transfer failed">
              {transferError}
            </Alert>
          )}
          {importPreview !== null && (
            <Stack gap={8}>
              <Text variant="strong" size="sm">
                Import preview
              </Text>
              {importPreview.changes.map((change) => (
                <Text key={change.section} variant="muted" size="sm">
                  {change.section}: {CHANGE_LABELS[change.kind]}
                </Text>
              ))}
              {!importHasChanges(importPreview.changes) && (
                <Text variant="muted" size="sm">
                  The file matches the stored settings — applying would change nothing.
                </Text>
              )}
              <Stack gap={8} direction="row" align="center">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={transferBusy || !importHasChanges(importPreview.changes)}
                  onClick={() => void applyImport()}
                >
                  {transferBusy ? 'Importing…' : 'Apply import'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={transferBusy}
                  onClick={() => setImportPreview(null)}
                >
                  Cancel
                </Button>
              </Stack>
            </Stack>
          )}
        </Stack>
      </Card>

      {/* Agent access (MCP) moved into the Connections tab (wave 3.1). */}

      {genericError !== null && (
        <Alert tone="danger" title="Save failed">
          {genericError}
        </Alert>
      )}

      <Separator />

      <Stack gap={8} direction="row" align="center">
        <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
        {hasShownErrors && !validation.ok && (
          <Text variant="muted" size="sm">
            Fix the highlighted fields to save.
          </Text>
        )}
        {savedFlash && (
          <Text variant="muted" size="sm">
            Saved.
          </Text>
        )}
      </Stack>
    </Stack>
  )
}

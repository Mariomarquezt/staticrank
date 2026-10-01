/**
 * Setup-wizard step/completion model (task 2.6) — pure logic for the
 * guided flow inside the SEO Settings admin app. No React, no SDK
 * imports; unit-tests under plain `bun test`.
 *
 * Completion rule: setup counts as COMPLETE exactly when the stored
 * config carries a usable site URL (`site.siteUrl` normalizes to a bare
 * origin — the same `normalizeSiteOrigin` the server gates every
 * absolute-URL feature on: canonicals, sitemap, IndexNow). The wizard
 * auto-shows while setup is incomplete, is dismissible, and stays
 * revisitable via the "Setup guide" button.
 *
 * The finish step's mini-audit (`buildSetupAudit`) is PURE CLIENT LOGIC
 * over the stored config document — no new server surface. Each item may
 * carry a one-line Pro teaser per DESIGN §3.4 ("Included in Pro — <one
 * concrete benefit>", locked-in-place, zero ads).
 */

import { indexNowEnabled, schemaEnabled, type SeoConfigData } from '../../server/seoConfig'
import { normalizeSiteOrigin } from '../../server/metaBlock'
import { runtimeBasePath } from './identity'

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const WIZARD_STEP_IDS = [
  'basics',
  'titles',
  'indexing',
  'verification',
  'analytics',
  'finish',
] as const

export type WizardStepId = (typeof WIZARD_STEP_IDS)[number]

export interface WizardStepInfo {
  id: WizardStepId
  title: string
}

export const WIZARD_STEPS: readonly WizardStepInfo[] = [
  { id: 'basics', title: 'Site basics' },
  { id: 'titles', title: 'Titles' },
  { id: 'indexing', title: 'Indexing' },
  { id: 'verification', title: 'Search engines' },
  { id: 'analytics', title: 'Analytics' },
  { id: 'finish', title: 'Finish' },
]

export function stepIndex(id: WizardStepId): number {
  return WIZARD_STEP_IDS.indexOf(id)
}

export function nextStep(id: WizardStepId): WizardStepId | null {
  const index = stepIndex(id)
  return index >= 0 && index < WIZARD_STEP_IDS.length - 1 ? WIZARD_STEP_IDS[index + 1]! : null
}

export function prevStep(id: WizardStepId): WizardStepId | null {
  const index = stepIndex(id)
  return index > 0 ? WIZARD_STEP_IDS[index - 1]! : null
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * True when the stored config carries a usable site URL. Judged through
 * the SAME normalization the server applies (a stored-but-unusable URL
 * must not read as "set up").
 *
 * DELIBERATELY NAMED "config" complete, not "setup" complete (review C#1):
 * a complete CONFIG does not mean the runtime documents are SERVING — the
 * public sitemap/llms.txt routes additionally 404 until the site has
 * published pages (server/index.ts hasPublishedPages gate), and publish
 * state is not cheaply observable client-side. UI copy built on this
 * predicate must say "configured", never "live"/"serving".
 */
export function isConfigComplete(config: SeoConfigData): boolean {
  return normalizeSiteOrigin(config.site?.siteUrl) !== undefined
}

// ---------------------------------------------------------------------------
// Runtime document URLs (Indexing step — shown for copy)
// ---------------------------------------------------------------------------

export interface RuntimeDocUrls {
  sitemap: string
  llmsTxt: string
  /** True when the URLs are absolute (siteUrl configured). */
  absolute: boolean
}

/**
 * The public runtime URLs the plugin serves sitemap.xml / llms.txt from
 * (DESIGN §5.5 — no root-level file emission at this pin, G2). Absolute
 * against the configured site origin; root-relative until one is set.
 */
export function runtimeDocUrls(pluginId: string, config: SeoConfigData): RuntimeDocUrls {
  const origin = normalizeSiteOrigin(config.site?.siteUrl)
  const base = `${origin ?? ''}${runtimeBasePath(pluginId)}`
  return {
    sitemap: `${base}/sitemap.xml`,
    llmsTxt: `${base}/llms.txt`,
    absolute: origin !== undefined,
  }
}

// ---------------------------------------------------------------------------
// Finish-step mini-audit (pure config inspection)
// ---------------------------------------------------------------------------

export interface SetupAuditItem {
  id: string
  label: string
  ok: boolean
  detail: string
  /** One-line Pro teaser (§3.4) — "Included in Pro — <concrete benefit>". */
  pro?: string
}

/** §3.4 copy discipline: every teaser names ONE concrete benefit. */
export const PRO_TEASERS = {
  analytics:
    'Included in Pro — the per-path view log and the 404 list with one-click redirects.',
  audit: 'Included in Pro — this one-time check becomes a scheduled site audit with alerts.',
} as const

/**
 * The finish step's "what's configured vs not" summary, computed from the
 * STORED config document only. Ordered to mirror the wizard steps.
 *
 * HONESTY DISCIPLINE (review C#2): every line states what is CONFIGURED,
 * never what is currently OPERATING — the config document cannot see
 * publish state, and settings only reach published pages on the next
 * publish. IndexNow's ok-mark requires BOTH the toggle AND a usable site
 * URL (submission is impossible without the origin — server/index.ts
 * flushIndexNow bails on a missing siteUrl).
 */
export function buildSetupAudit(config: SeoConfigData): SetupAuditItem[] {
  const site = config.site ?? {}
  const siteUrlOk = normalizeSiteOrigin(site.siteUrl) !== undefined
  const siteNameOk = (site.siteName ?? '').trim() !== ''
  const descriptionOk = (site.metaDescription ?? '').trim() !== ''
  const templateOk =
    (site.titleTemplate ?? '').trim() !== '' ||
    Object.keys(config.tables ?? {}).length > 0
  const indexNowToggleOn = indexNowEnabled(config)
  const indexNowOk = indexNowToggleOn && siteUrlOk
  const schemaOn = schemaEnabled(config)
  const publisherOk = schemaOn && (config.schema?.publisherName ?? '').trim() !== ''
  const verification = config.verification ?? {}
  const verificationOk =
    (verification.google ?? '') !== '' ||
    (verification.bing ?? '') !== '' ||
    (verification.pinterest ?? '') !== ''
  const analyticsOk = config.analytics?.enabled === true

  return [
    {
      id: 'site-url',
      label: 'Site URL',
      ok: siteUrlOk,
      detail: siteUrlOk
        ? 'Configured — every page gets a self-referencing canonical; the sitemap and IndexNow use this origin too.'
        : 'Not set — canonicals, the sitemap, and IndexNow stay disabled without it.',
    },
    {
      id: 'site-name',
      label: 'Site name',
      ok: siteNameOk,
      detail: siteNameOk
        ? 'Configured — feeds %site% in title templates and og:site_name.'
        : 'Not set — %site% renders empty in title templates.',
    },
    {
      id: 'meta-description',
      label: 'Default meta description',
      ok: descriptionOk,
      detail: descriptionOk
        ? 'Configured — used when an entry has no description of its own.'
        : 'Not set — entries without their own description bake none.',
    },
    {
      id: 'title-template',
      label: 'Title template',
      ok: templateOk,
      detail: templateOk
        ? 'Configured — applied to page titles on the next publish.'
        : 'Not set — pages keep their bare titles.',
    },
    {
      id: 'indexnow',
      label: 'IndexNow instant indexing',
      ok: indexNowOk,
      detail: indexNowOk
        ? 'Enabled — pings go out after the next publish of a changed page.'
        : indexNowToggleOn
          ? 'Enabled, but needs the Site URL before any ping can be submitted.'
          : 'Disabled — search engines discover changes on their own schedule.',
    },
    {
      id: 'schema',
      label: 'Structured data (schema.org)',
      ok: publisherOk,
      detail: publisherOk
        ? 'Configured — the JSON-LD graph with your publisher bakes on the next publish.'
        : schemaOn
          ? 'Graph is on, but no publisher is named (Schema tab).'
          : 'Disabled — no JSON-LD graph is baked.',
    },
    {
      id: 'verification',
      label: 'Search engine verification',
      ok: verificationOk,
      detail: verificationOk
        ? 'Configured — tokens bake into every page on the next publish.'
        : 'No tokens set — optional, needed only to claim the site in the consoles.',
    },
    {
      id: 'analytics',
      label: 'First-party analytics',
      ok: analyticsOk,
      detail: analyticsOk
        ? 'Enabled — counting takes effect on the next publish (privacy-preserving daily counts).'
        : 'Off (opt-in) — no view or 404 counts are collected.',
      pro: PRO_TEASERS.analytics,
    },
  ]
}

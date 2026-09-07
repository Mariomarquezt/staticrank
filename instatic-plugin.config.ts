// SDK import: the scaffold template writes `from '@core/plugin-sdk'`, which
// only resolves for plugin trees living INSIDE the Instatic monorepo (host
// tsconfig path alias; see src/__tests__/plugin-sdk/lintCli.test.ts:26-31 in
// the pinned checkout). This repo lives outside the monorepo, so we import
// the same SDK entry by absolute file path instead — same code, same exports.
// The `@instatic/plugin-sdk` alias named in docs/features/plugin-system.md
// has no published package at this pin, so a direct path import is the only
// working resolution for an external plugin repo.
import { definePlugin, permissions } from './vendor-sdk'

export default definePlugin({
  id: 'monkeywebs.seo',
  name: 'Seo',
  version: '0.1.0',
  description: 'A Seo content-editor plugin (reads + writes CMS entries).',

  // Least-privilege: exactly what the server entrypoint uses today.
  //   - cms.content.read + a contentAccess allowlist return in task 1.4
  //     (cell-fallback meta generation). Re-adding any cms.content.*
  //     permission re-arms the conditional contentAccess re-injection in
  //     scripts/build.ts (upstream gap G8b).
  permissions: [
    // Task 1.2: per-entry seo_meta records via api.cms.storage.
    permissions.cmsStorage,
    // Task 1.2/1.3: authenticated GET/POST/DELETE /meta + /config routes.
    permissions.cmsRoutes,
    // Task 1.3: publish.html filter (api.cms.hooks.filter — every
    // cms.hooks.* dispatch target requires this permission, vendor
    // server/plugins/protocol/targets.ts:48-50).
    permissions.cmsHooks,
    // Task 1.3 blocker fix: the filter reads the `pages` row for the
    // context pageId to detect template pages (templateEnabled cell) so
    // per-entry meta never leaks onto data-row renders. Requires the
    // contentAccess allowlist, re-injected by scripts/build.ts (G8b).
    permissions.cmsContentRead,
    // Task 1.4: the SEO Settings admin page mounts in the CMS sidebar —
    // `adminPages` requires this (vendor manifest.ts:465-471).
    permissions.adminNavigation,
    // Tasks 1.4 + 1.5: unsandboxed admin-window JavaScript. REQUIRED for
    // `entrypoints.editor` (manifest.ts:429-434, auto-added by the CLI
    // build when editor/index.tsx exists) AND for the kind-'app' admin
    // page (manifest.ts:483-491).
    permissions.editorCode,
    // Task 1.5: `api.editor.panels.register` (runtime.ts:478-482).
    permissions.editorPanels,
    // Task 1.5: the panel reads the active page (activeDocument /
    // activePageId / site.pages) via `useEditorStore`, which asserts
    // `editor.store.read` per call (plugin-host-hooks/index.ts:69-77).
    permissions.editorStoreRead,
    // Round-5 t1-00: the ⌘K "SEO: open panel" command OPENS this plugin's
    // rail panel, which is a write to editor state — the same two writes
    // the host's own PanelRail performs (PanelRail.tsx:140-143). The host
    // offers no read-safe way to reveal a panel, so the write goes through
    // `api.editor.store.transaction` (runtime.ts:495-504) and the grant is
    // declared HONESTLY here: install consent used to say "inspect editor
    // state" while the command mutated it. Nothing else in this plugin
    // writes editor state.
    permissions.editorStoreWrite,
    // Task 2.2: anonymous-callable runtime routes for sitemap.xml,
    // llms.txt, and the IndexNow key file (`api.cms.routes.public.*`
    // dispatches with user: null — vendor server/plugins/runtime.ts:
    // 209-256; registration additionally asserts this permission,
    // targets.ts:44-46 comment).
    permissions.cmsRoutesPublic,
    // Task 2.2: IndexNow submissions via the sandbox's gated fetch()
    // (`network.fetch` target requires this — targets.ts:59). Host-side
    // allowlist below (`networkAllowedHosts`) is the second, fail-closed
    // gate (host/network.ts:140-143).
    permissions.networkOutbound,
    // Task 2.2: 15-minute maintenance tick (IndexNow tail flush + stale
    // sitemap-record pruning) — `cms.schedule.register` target
    // (targets.ts:61-62).
    permissions.cmsSchedule,
    // Task 2.4: the declarative `frontend.assets[]` tracker script below —
    // the single permission gating every frontend tag a plugin can inject
    // (vendor manifest.ts:524-535; injection frontendInjections.ts:130).
    permissions.frontendAssets,
    // Task 2.6: dashboard widget (`api.dashboard.widgets.register` asserts
    // this at registration — vendor src/core/plugins/runtime.ts:534-541).
    permissions.dashboardWidgetsRegister,
    // Task 2.6: ⌘K Command Spotlight commands
    // (`api.editor.commands.register` asserts this — runtime.ts:468-471).
    permissions.editorCommands,
  ],

  // Task 2.4 — first-party analytics tracker (spike G6: assets are
  // manifest-STATIC and unconditional; third-party script URLs are
  // impossible — src is always prefixed with this plugin's own
  // assetBasePath, frontendInjections.ts:273-277). The tracker therefore
  // ships IN THE ZIP (assets/tracker.js — built by the Codex worktree
  // worker; scripts/build.ts stages the assets/ dir into dist + zip) and
  // is injected on every published page at body-end. It NO-OPS unless the
  // publish.html filter baked a `window.__mwSeoAnalytics` config tag into
  // the head (analytics enabled in seo-config), and respects DNT/GPC.
  // Beacons POST same-origin (connect-src 'self') — no networkAllowedHosts
  // entry needed.
  frontend: {
    assets: [
      {
        kind: 'script',
        src: 'assets/tracker.js',
        placement: 'body-end',
        strategy: 'defer',
      },
    ],
  },

  // Hostname allowlist for the sandbox fetch (dual gate with
  // `network.outbound` — vendor src/core/plugin-sdk/types/manifest.ts:
  // 81-88; forwarded by definePlugin, builders/definePlugin.ts:178-179).
  // Exactly the IndexNow API endpoint; sitemap "submission" IS the
  // IndexNow POST (the deprecated sitemap-ping endpoints are gone).
  // Task 3.2: the license host is PRO-ONLY — the free build strips every
  // entry except api.indexnow.org (scripts/build.ts --tier free). Pro-only
  // hosts stay private to this manifest; the free build strips them.
  // Task 3.7: GSC hosts are PRO-only (free strips to api.indexnow.org).
  networkAllowedHosts: [
    // The free build makes exactly one outbound call: IndexNow
    // ping-on-publish. Every other host this plugin has ever
    // needed belongs to a Pro feature.
    'api.indexnow.org',
  ],

  // Task 3.7 — GSC credentials (PRO; the free build strips the whole
  // settings array). Host-encrypted secrets; server-only reads via
  // api.cms.settings.get; browsers always see '***'. Ids locked to
  // GSC_SETTING_IDS in server/gsc/types.ts.

  // The free build declares NO manifest settings: every setting this
  // plugin has ever needed (Search Console credentials, AI provider key)
  // belongs to Pro.

  // Plugin-storage collections (api.cms.storage). DESIGN §5.1 names this
  // collection `seo_meta`, but manifest resource ids must match
  // /^[a-z][a-z0-9-]*$/ (src/core/plugins/manifest.ts:31,121), so it is
  // kebab-cased. Records hold one entry's meta, keyed by the `key` field
  // (`${tableSlug}:${entryId}`). The host validates record data against
  // this field list and DROPS undeclared fields (resourceRecords.ts:31-62),
  // so it must stay in sync with SEO_META_FIELD_IDS in server/seoMeta.ts —
  // the nested `robots` object is flattened to two booleans because
  // resource fields are flat scalars only.
  resources: [
    {
      id: 'seo-meta',
      title: 'SEO Meta',
      singularLabel: 'SEO meta entry',
      pluralLabel: 'SEO meta entries',
      fields: [
        { id: 'key', label: 'Key (tableSlug:entryId)', type: 'text', required: true },
        { id: 'title', label: 'Title', type: 'text' },
        { id: 'metaDescription', label: 'Meta description', type: 'longtext' },
        { id: 'canonical', label: 'Canonical URL', type: 'text' },
        { id: 'robotsNoindex', label: 'Robots noindex', type: 'boolean' },
        { id: 'robotsNofollow', label: 'Robots nofollow', type: 'boolean' },
        { id: 'ogTitle', label: 'OG title', type: 'text' },
        { id: 'ogDescription', label: 'OG description', type: 'longtext' },
        { id: 'ogImage', label: 'OG image URL', type: 'text' },
        { id: 'twitterCard', label: 'Twitter card', type: 'text' },
        // Task 2.3 — arrays are not flat scalars, so focusKeywords rides
        // as ONE JSON string (validated/parsed in server/seoMeta.ts).
        { id: 'focusKeywords', label: 'Focus keywords (JSON array)', type: 'longtext' },
        { id: 'schemaType', label: 'schema.org page type', type: 'text' },
        // Task 3.5 — per-entry custom JSON-LD (field is FREE-declared so
        // free⇄pro reinstalls never drop stored data; only Pro EMITS it).
        // Validated in server/seoMeta.ts (parse + @type + 20k cap).
        { id: 'customSchemaJson', label: 'Custom JSON-LD (Pro emits)', type: 'longtext' },
      ],
    },
    // Site defaults + per-table title templates (task 1.3). One record per
    // key: `site` holds the site defaults; `table:<tableSlug>` holds that
    // table's title template. Flat scalars only (host constraint); field
    // list must stay in sync with SEO_CONFIG_FIELD_IDS in server/seoConfig.ts.
    {
      id: 'seo-config',
      title: 'SEO Config',
      singularLabel: 'SEO config record',
      pluralLabel: 'SEO config records',
      fields: [
        { id: 'key', label: 'Key (site | table:<tableSlug>)', type: 'text', required: true },
        { id: 'version', label: 'Config shape version', type: 'number' },
        { id: 'siteName', label: 'Site name (%site%)', type: 'text' },
        { id: 'separator', label: 'Title separator (%sep%)', type: 'text' },
        { id: 'siteUrl', label: 'Site URL (canonical base)', type: 'text' },
        { id: 'titleTemplate', label: 'Title template', type: 'text' },
        { id: 'metaDescription', label: 'Default meta description', type: 'longtext' },
        // Task 2.2 — `indexnow` record: the admin toggle ONLY. Server-owned
        // IndexNow state (key, submission status) lives in the separate
        // `seo-state` resource so POST/DELETE /config full replaces can
        // never destroy it. Legacy pre-review records embedded those
        // fields here; server/seoState.ts lifts them out on first read
        // (reads return stored data regardless of declaration — the host
        // validates fields at WRITE time only, resourceRecords.ts).
        { id: 'indexNowEnabled', label: 'IndexNow enabled', type: 'boolean' },
        // Task 2.3 — `schema` record (key `schema`): schema.org graph
        // config. `schemaEnabled` stores only `false` (absent = enabled);
        // sameAs is an array → ONE JSON string (parsed defensively in
        // server/seoConfig.ts). POST /config keeps this record when the
        // request body omits the `schema` section (pre-2.3 settings form).
        { id: 'schemaEnabled', label: 'Schema graph enabled', type: 'boolean' },
        { id: 'publisherKind', label: 'Publisher kind (organization | person)', type: 'text' },
        { id: 'publisherName', label: 'Publisher name', type: 'text' },
        { id: 'publisherLogoUrl', label: 'Publisher logo URL', type: 'text' },
        { id: 'sameAsJson', label: 'Publisher sameAs URLs (JSON array)', type: 'longtext' },
        // Task 2.4 — `analytics` record (key `analytics`): opt-in toggle,
        // only `true` stored (absent = DISABLED — data collection is
        // opt-in, opposite polarity of the indexNow/schema toggles).
        { id: 'analyticsEnabled', label: 'Analytics enabled', type: 'boolean' },
        // Task 2.4 — `verification` record (key `verification`): bare
        // site-verification tokens (pasted meta tags are stripped to
        // their content value at validation).
        { id: 'verificationGoogle', label: 'Google verification token', type: 'text' },
        { id: 'verificationBing', label: 'Bing verification token', type: 'text' },
        { id: 'verificationPinterest', label: 'Pinterest verification token', type: 'text' },
      ],
    },
    // SERVER-OWNED runtime state (task 2.2 review fix #9) — deliberately
    // its own collection, OUTSIDE the /config replace/delete scope:
    //   key `indexnow`  — IndexNow submission key + last-submission outcome
    //   key `reconcile` — maintenance-tick cursor over seo-sitemap records
    // Field list stays in sync with SEO_STATE_FIELD_IDS in server/seoState.ts.
    {
      id: 'seo-state',
      title: 'SEO Server State',
      singularLabel: 'SEO state record',
      pluralLabel: 'SEO state records',
      fields: [
        { id: 'key', label: 'Key (indexnow | reconcile | ai | ai-bulk-scan)', type: 'text', required: true },
        { id: 'indexNowKey', label: 'IndexNow key', type: 'text' },
        { id: 'lastSubmittedAt', label: 'Last IndexNow submission', type: 'text' },
        { id: 'lastStatus', label: 'Last IndexNow status', type: 'text' },
        { id: 'cursor', label: 'Reconcile cursor', type: 'number' },
        // Task 3.9 — `ai` record (key `ai`): the operator's chosen model
        // id, picked in the plugin's own AI tab (the host settings form
        // cannot render a searchable 400-entry list). Overrides the host
        // `aiModel` setting. NOT a secret — a model id, never a key.
        { id: 'aiModel', label: 'AI model id (chosen in the SEO AI tab)', type: 'text' },
        // Review 2026-08-15 — `decoration` record: a publish whose SEO
        // decoration threw ships the page WITHOUT meta/JSON-LD/analytics.
        // The filter is read-only, so publish.after persists the tally
        // here and the admin can stop guessing why tags vanished.
        { id: 'lastFailureAt', label: 'Last publish that shipped without SEO tags', type: 'text' },
        { id: 'failureCount', label: 'Publishes that shipped without SEO tags', type: 'number' },
        { id: 'failurePages', label: 'Recent failed page ids (JSON array)', type: 'longtext' },
      ],
    },
    // Published-page index (task 2.2): one record per published page,
    // keyed `page:<pageId>`, maintained by the publish.after hook (see
    // server/sitemap.ts header). Feeds /sitemap.xml + /llms.txt and the
    // IndexNow pending queue (`pending`). Flat scalars only; field list
    // must stay in sync with SEO_SITEMAP_FIELD_IDS in server/sitemap.ts.
    {
      id: 'seo-sitemap',
      title: 'Sitemap Pages',
      singularLabel: 'Sitemap page',
      pluralLabel: 'Sitemap pages',
      fields: [
        { id: 'key', label: 'Key (page:<pageId>)', type: 'text', required: true },
        { id: 'pageId', label: 'Page id', type: 'text', required: true },
        { id: 'slug', label: 'Slug', type: 'text', required: true },
        { id: 'title', label: 'Title', type: 'text' },
        { id: 'lastmod', label: 'Last observed change (ISO)', type: 'text' },
        { id: 'fp', label: 'Content fingerprint', type: 'text' },
        { id: 'pending', label: 'Pending IndexNow submission', type: 'boolean' },
        // Task 2.4 — image-SEO audit counts of the last composed render
        // (auditImages over the publish.html output; joined into GET
        // /meta for the editor panel).
        { id: 'imgTotal', label: 'Images on page', type: 'number' },
        { id: 'imgFindings', label: 'Image-SEO findings', type: 'number' },
      ],
    },
      // Task 2.4 — beacon day counts. ONE record per UTC day (key
    // `day:<YYYY-MM-DD>`), the per-path map riding as a single JSON string
    // (`countsJson` — flat scalars only, and per-path records would blow
    // the host's 1000-record list cap within weeks). Written ONLY by the
    // seo-maintenance tick (public beacon routes aggregate in memory);
    // 30-day retention pruned by the same tick. Field lists must stay in
    // sync with DAY_COUNT_FIELD_IDS in server/analytics.ts.
    {
      id: 'seo-analytics',
      title: 'Analytics Day Counts',
      singularLabel: 'analytics day record',
      pluralLabel: 'analytics day records',
      fields: [
        { id: 'key', label: 'Key (day:<YYYY-MM-DD>)', type: 'text', required: true },
        { id: 'day', label: 'UTC day', type: 'text', required: true },
        { id: 'total', label: 'Total page views', type: 'number' },
        { id: 'countsJson', label: 'Per-path counts (JSON map)', type: 'longtext' },
      ],
    },
    // Task 2.4 — 404-hit day counts; same shape and discipline, separate
    // collection (cap 200 distinct paths/day vs 500).
    {
      id: 'seo-notfound',
      title: '404 Day Counts',
      singularLabel: '404 day record',
      pluralLabel: '404 day records',
      fields: [
        { id: 'key', label: 'Key (day:<YYYY-MM-DD>)', type: 'text', required: true },
        { id: 'day', label: 'UTC day', type: 'text', required: true },
        { id: 'total', label: 'Total 404 hits', type: 'number' },
        { id: 'countsJson', label: 'Per-path counts (JSON map)', type: 'longtext' },
      ],
    },
    // Task 3.3 — observed host slug-change 301s (FREE resource: DESIGN
    // §4.1 "visibility, not management"). Written from publish.after when
    // the stored seo-sitemap slug differs from the fresh one. Field list
    // locked to SLUGMOVE_FIELD_IDS in server/redirects/types.ts.
    {
      id: 'seo-slugmoves',
      title: 'Host Slug Moves',
      singularLabel: 'Slug move',
      pluralLabel: 'Slug moves',
      fields: [
        { id: 'key', label: 'Key (move:<pageId>:<ts>)', type: 'text', required: true },
        { id: 'pageId', label: 'Page id', type: 'text', required: true },
        { id: 'fromSlug', label: 'From slug', type: 'text', required: true },
        { id: 'toSlug', label: 'To slug', type: 'text', required: true },
        { id: 'at', label: 'Observed (ISO)', type: 'text', required: true },
      ],
    },
  ],

  // SEO Settings page (task 1.4) — kind 'app': a real React form bundled
  // from admin/settings.tsx to admin/settings.js (the CLI resolves the
  // .js entry back to the .tsx source, cli/build.ts:322-347). assetPath
  // is omitted: it defaults to this plugin's own assetBasePath.
  adminPages: [
    {
      id: 'settings',
      title: 'SEO Settings',
      navLabel: 'SEO',
      content: {
        kind: 'app',
        heading: 'SEO Settings',
        entry: 'admin/settings.js',
      },
    },
  ],

  // contentAccess (pages, read-only) is required by the manifest schema
  // whenever a cms.content.* permission is granted, but the pinned
  // definePlugin silently drops the key (upstream gap G8b) — so it lives
  // in scripts/build.ts, which re-injects it into the staged build copy.

  // NOTE: `entrypoints` is not a DefinePluginConfig field — the CLI build
  // derives the final manifest entrypoints from which sources exist
  // (cli/build.ts:381-401): server/index.ts → entrypoints.server,
  // editor/index.tsx → entrypoints.editor.
})

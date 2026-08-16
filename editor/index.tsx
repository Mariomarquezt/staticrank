/**
 * Editor entrypoint (task 1.5, extended by 2.6). Bundled by
 * `instatic-plugin build` to `dist/editor/index.js` with `react` /
 * `@instatic/host-ui` / `@instatic/host-hooks` as externals
 * (cli/build.ts:73-81,438), loaded by the host's editorPluginLoader
 * (which unwraps the default export and calls `activate(api)` —
 * src/core/plugins/editorPluginLoader.ts:66-76), and gated by the
 * `editor.code` permission (manifest.ts:429-434).
 *
 * Task 2.6 additions:
 *   - Dashboard widget (`api.dashboard.widgets.register`, permission
 *     `dashboard.widgets.register` asserted at registration —
 *     runtime.ts:534-541): 7-day views + 404 counts from GET /stats.
 *   - ⌘K Command Spotlight commands (`api.editor.commands.register`,
 *     permission `editor.commands` — runtime.ts:468-471):
 *       "Open SEO settings" — SPA-navigates to this plugin's admin page
 *       (/admin/plugins/:pluginId/:pageId route, vendor router.tsx:67-68)
 *       exactly the way the host router's own navigate() does: pushState
 *       + the 'instatic:locationchange' event the <Router> subscribes to
 *       (Router.tsx:96-120, routerHooks.ts:59). No hard reload.
 *       "SEO: open panel" — site workspace only (workspaces gate): flips
 *       the rail to this plugin's panel via the editor store's own
 *       `setActivePluginPanel` action (uiSlice.ts:480-487), reached
 *       through `api.editor.store.read()` (the zustand state carries the
 *       action functions; `editor.store.read` is already granted for the
 *       panel itself).
 *
 * SDK note: `definePluginPanel` is an identity wrapper with build-time id
 * validation; importing it AT RUNTIME would inline the whole SDK barrel
 * (which only resolves inside the monorepo's tsconfig) into this browser
 * bundle, so the panel object is constructed literally and the SDK is
 * imported types-only.
 */
import { startTransition } from 'react'
import type { EditorPluginApi } from '../vendor-sdk'
import { PANEL_ID, PLUGIN_ID, settingsPagePath } from '../admin/lib/identity'
import { SeoPanel } from './SeoPanel'
import { SEO_STATS_WIDGET_ID, SeoStatsWidget } from './SeoStatsWidget'

/**
 * SPA navigation the host router observes — the exact pushState + custom
 * event pair its own navigate() performs (vendor Router.tsx:96-120;
 * event name from routerHooks.ts:59). A raw location.href assignment
 * would hard-reload the whole admin. The dispatch rides startTransition
 * exactly like the host's navigate() (Router.tsx:116-120) so the route
 * swap is a low-priority Transition — no Suspense-fallback flash while
 * the target page's lazy chunk loads (review C nit).
 */
function navigateAdmin(to: string): void {
  window.history.pushState(null, '', to)
  startTransition(() => {
    window.dispatchEvent(new Event('instatic:locationchange'))
  })
}

const mod = {
  activate(api: EditorPluginApi) {
    // Identity (review C#6): `api.plugin.id` IS available to editor
    // entrypoints (SDK contract types/editorApi.ts:23-33, populated by
    // createEditorPluginApi — vendor src/core/plugins/runtime.ts:452-457).
    // The shared constant in admin/lib/identity.ts exists for surfaces
    // mounted WITHOUT plugin context (the dashboard widget); a drift
    // between the two would silently break the widget's fetch URL, so
    // fail loudly here at activation time.
    if (api.plugin.id !== PLUGIN_ID) {
      throw new Error(
        `plugin id mismatch: manifest "${api.plugin.id}" vs identity module "${PLUGIN_ID}"`,
      )
    }
    // Requires the `editor.panels` permission grant; id must be namespaced
    // under the plugin id (runtime.ts:325-338).
    api.editor.panels.register({
      id: PANEL_ID,
      label: 'SEO',
      // Curated rail icon registry (PanelRail/pluginPanelIcons.ts) —
      // 'text-start-t' reads as "title/text"; unknown names fall back to a box.
      iconName: 'text-start-t',
      component: SeoPanel,
    })

    // Dashboard widget (task 2.6) — id namespace-locked under the plugin
    // id (dashboard registry.ts:139-144); iconName resolves through the
    // curated dashboard lookup ('trending-up' — widgetIcons.ts).
    api.dashboard.widgets.register({
      id: SEO_STATS_WIDGET_ID,
      name: 'SEO traffic',
      description: 'Page views and 404 hits over the last 7 days (first-party analytics).',
      iconName: 'trending-up',
      defaultSize: 4,
      tint: 'sky',
      component: SeoStatsWidget,
    })

    // ⌘K commands (task 2.6) — both need `editor.commands`.
    api.editor.commands.register({
      id: `${api.plugin.id}.open-settings`,
      label: 'Open SEO settings',
      subtitle: 'Site defaults, titles, indexing, analytics',
      keywords: ['seo', 'meta', 'sitemap', 'indexnow', 'analytics'],
      run: () => {
        navigateAdmin(settingsPagePath(api.plugin.id))
      },
    })

    api.editor.commands.register({
      id: `${api.plugin.id}.open-panel`,
      label: 'SEO: open panel',
      subtitle: 'Title, description, search preview, content analysis',
      keywords: ['seo', 'serp', 'keyword', 'analysis'],
      // The panel only exists in the site editor — hide elsewhere.
      workspaces: ['site'],
      run: () => {
        try {
          // The editor store state carries its action functions;
          // setActivePluginPanel is the same action the panel rail invokes,
          // and PanelRail's revealPluginPanel ALSO collapses the properties
          // sidebar first (vendor PanelRail.tsx:145-148) — replicated here
          // when the action is reachable (review C nit). store.read()
          // asserts `editor.store.read`.
          const store = api.editor.store.read() as unknown as {
            setActivePluginPanel?: (panelId: string | null) => void
            setPropertiesPanel?: (patch: { collapsed: boolean }) => void
          }
          if (typeof store.setActivePluginPanel === 'function') {
            if (typeof store.setPropertiesPanel === 'function') {
              store.setPropertiesPanel({ collapsed: true })
            }
            store.setActivePluginPanel(PANEL_ID)
            return
          }
          return { message: 'SEO panel is unavailable in this view.' }
        } catch {
          return { message: 'Open a site in the editor first.' }
        }
      },
    })
  },
}

export default mod

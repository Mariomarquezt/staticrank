/**
 * Plugin identity + runtime-path helpers (review C#6) — the SINGLE source
 * for the plugin id and every URL derived from it, shared by the admin
 * settings app, the editor entrypoint, the dashboard widget, and the
 * wizard's runtime-document display. Pure, React-free, testable.
 *
 * Where a live `api` object is IN SCOPE (the editor `activate(api)` —
 * `api.plugin.id` is provided to editor entrypoints by the SDK contract,
 * vendor src/core/plugin-sdk/types/editorApi.ts:23-33, populated in
 * createEditorPluginApi, src/core/plugins/runtime.ts:452-457), callers
 * pass THAT id into these helpers instead of the constant. The constant
 * exists for the surfaces the host mounts WITHOUT plugin context: the
 * dashboard widget component (DashboardGrid renders `def.render` bare —
 * vendor DashboardGrid.tsx:195,349), where nothing hands us an id.
 * `activate()` asserts the two never drift.
 */

/** Manifest plugin id — must match instatic-plugin.config.ts `id`. */
export const PLUGIN_ID = 'monkeywebs.seo'

/** Editor rail panel id (namespaced under the plugin id). */
export const PANEL_ID = `${PLUGIN_ID}.panel`

/** Dashboard widget id (namespaced under the plugin id). */
export const STATS_WIDGET_ID = `${PLUGIN_ID}.stats`

/**
 * The plugin's runtime URL prefix (vendor server/handlers/cms/plugins/
 * index.ts PLUGIN_RUNTIME_PATTERN — `/admin/api/cms/plugins/:id/runtime`).
 */
export function runtimeBasePath(pluginId: string = PLUGIN_ID): string {
  return `/admin/api/cms/plugins/${pluginId}/runtime`
}

/** Root-relative URL of one runtime route (path must start with '/'). */
export function runtimePath(route: string, pluginId: string = PLUGIN_ID): string {
  return `${runtimeBasePath(pluginId)}${route}`
}

/**
 * The plugin's settings admin page (adminPages entry id 'settings') on
 * the host's `/admin/plugins/:pluginId/:pageId` route (vendor
 * src/admin/router.tsx:67-68).
 */
export function settingsPagePath(pluginId: string = PLUGIN_ID): string {
  return `/admin/plugins/${pluginId}/settings`
}

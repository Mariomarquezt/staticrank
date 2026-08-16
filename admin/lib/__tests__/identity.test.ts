/**
 * Review C#6 — shared identity module: the single source for the plugin
 * id and every URL derived from it.
 */
import { describe, expect, test } from 'bun:test'
import {
  PANEL_ID,
  PLUGIN_ID,
  STATS_WIDGET_ID,
  runtimeBasePath,
  runtimePath,
  settingsPagePath,
} from '../identity'

describe('identity', () => {
  test('ids are namespaced under the plugin id', () => {
    expect(PLUGIN_ID).toBe('monkeywebs.seo')
    expect(PANEL_ID).toBe('monkeywebs.seo.panel')
    expect(STATS_WIDGET_ID).toBe('monkeywebs.seo.stats')
  })

  test('runtime paths follow the host PLUGIN_RUNTIME_PATTERN', () => {
    expect(runtimeBasePath()).toBe('/admin/api/cms/plugins/monkeywebs.seo/runtime')
    expect(runtimePath('/stats')).toBe('/admin/api/cms/plugins/monkeywebs.seo/runtime/stats')
    expect(runtimePath('/sitemap.xml', 'other.id')).toBe(
      '/admin/api/cms/plugins/other.id/runtime/sitemap.xml',
    )
  })

  test('settings page path follows /admin/plugins/:pluginId/:pageId', () => {
    expect(settingsPagePath()).toBe('/admin/plugins/monkeywebs.seo/settings')
    expect(settingsPagePath('other.id')).toBe('/admin/plugins/other.id/settings')
  })
})

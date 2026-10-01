/**
 * SEO traffic dashboard widget (task 2.6) — registered from the editor
 * entrypoint via `api.dashboard.widgets.register` (SDK editorApi.ts:96-106,
 * `dashboard.widgets.register` permission asserted at registration,
 * vendor src/core/plugins/runtime.ts:534-541). Shows the last 7 days of
 * first-party page views (sparkline + total) and the 404 hit count from
 * the plugin's own day records, via the authenticated GET /stats route.
 *
 * NO PluginContext here: the dashboard grid mounts plugin widget
 * components directly (`def.render`, vendor DashboardGrid.tsx:195,349)
 * WITHOUT the provider that powers `usePluginRoutes`, so the widget
 * fetches the runtime URL itself with `credentials: 'include'` — exactly
 * what the host's own routes helper does (buildPluginRoutesHelper,
 * vendor src/core/plugins/adminRuntime.ts:59-69).
 *
 * Chrome/charts come from `@instatic/host-ui` (Widget/Sparkline/StatValue
 * are re-exported for exactly this use — plugin-host-ui/index.ts:44-77).
 * Free tier shows TOTALS; the per-path breakdown (top pages, the 404 log)
 * is the §3.4 "404 tease" — locked in place via the shared ProLock.
 */
import { useEffect, useState } from 'react'
import { Sparkline, StatValue, Text, Widget } from '@instatic/host-ui'
import type { PluginDashboardWidgetRendererProps } from '../vendor-sdk'
import { ProLock } from '../admin/ProLock'
import { STATS_WIDGET_ID, runtimePath } from '../admin/lib/identity'
import { LICENSE_ROUTE, proUnlockedFromResponse } from './lib/proAnalysis'

export const SEO_STATS_WIDGET_ID = STATS_WIDGET_ID

/** Shared identity module (review C#6) — no PluginContext on this mount. */
const STATS_URL = runtimePath('/stats')
const LICENSE_URL = runtimePath(LICENSE_ROUTE)

interface StatsDayEntry {
  day: string
  views: number
  notFound: number
}

interface StatsPayload {
  days: StatsDayEntry[]
  totals: { views: number; notFound: number }
  /** Current opt-in state — false = day records are historical (C#3). */
  collecting: boolean
}

/** Defensive boundary parse — a malformed body renders the error state. */
function parseStatsPayload(raw: unknown): StatsPayload | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const body = raw as Record<string, unknown>
  const totals = body.totals
  if (totals === null || typeof totals !== 'object' || Array.isArray(totals)) return null
  const t = totals as Record<string, unknown>
  if (typeof t.views !== 'number' || typeof t.notFound !== 'number') return null
  if (!Array.isArray(body.days)) return null
  const days: StatsDayEntry[] = []
  for (const entry of body.days) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
    const d = entry as Record<string, unknown>
    if (typeof d.day !== 'string' || typeof d.views !== 'number' || typeof d.notFound !== 'number') {
      return null
    }
    days.push({ day: d.day, views: d.views, notFound: d.notFound })
  }
  // `collecting` tolerant default TRUE: a pre-C#3 server response simply
  // never shows the paused label (never a false alarm).
  const collecting = typeof body.collecting === 'boolean' ? body.collecting : true
  return { days, totals: { views: t.views, notFound: t.notFound }, collecting }
}

type StatsState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; stats: StatsPayload; proUnlocked: boolean }

export function SeoStatsWidget({ span, editing }: PluginDashboardWidgetRendererProps) {
  const [state, setState] = useState<StatsState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [statsRes, licenseRes] = await Promise.all([
          fetch(STATS_URL, { credentials: 'include' }),
          fetch(LICENSE_URL, { credentials: 'include' }),
        ])
        if (!statsRes.ok) throw new Error(`stats request failed with ${statsRes.status}`)
        const parsed = parseStatsPayload((await statsRes.json()) as unknown)
        const licenseBody = licenseRes.ok ? await licenseRes.json().catch(() => null) : null
        if (cancelled) return
        setState(
          parsed === null
            ? { kind: 'error' }
            : {
                kind: 'ready',
                stats: parsed,
                proUnlocked: proUnlockedFromResponse(licenseRes.ok, licenseBody),
              },
        )
      } catch {
        if (!cancelled) setState({ kind: 'error' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Widget
      widgetId={SEO_STATS_WIDGET_ID}
      title="SEO traffic"
      tint="sky"
      span={span}
      editing={editing}
      loading={state.kind === 'loading'}
    >
      {state.kind === 'error' && (
        <Text variant="muted" size="sm">
          Could not load traffic counts.
        </Text>
      )}
      {state.kind === 'ready' && (
        <StatsDetails stats={state.stats} proUnlocked={state.proUnlocked} />
      )}
    </Widget>
  )
}

/**
 * The ready-state body. `proUnlocked` is a separate typed prop because it
 * lives on the fetch STATE, not on the stats payload: the widget once read
 * `stats.proUnlocked` (always undefined) and so showed the Pro lock even
 * with Pro active (found 2026-09-30).
 */
export function StatsDetails({
  stats,
  proUnlocked,
}: {
  stats: StatsPayload
  proUnlocked: boolean
}) {
  return (
    <>
      <StatValue value={stats.totals.views} sub="page views · last 7 days" />
      {stats.days.length >= 2 && (
        <Sparkline data={stats.days.map((d) => d.views)} tint="var(--tint)" />
      )}
      <Text variant="muted" size="sm">
        {stats.totals.notFound} not-found hit{stats.totals.notFound === 1 ? '' : 's'} this week
      </Text>
      {!stats.collecting && (stats.totals.views > 0 || stats.totals.notFound > 0) && (
        // C#3: day records outlive a disable (30-day retention) — label
        // them so paused analytics never reads as live traffic.
        <Text variant="muted" size="sm">
          Analytics is paused — showing historical data.
        </Text>
      )}
      {stats.totals.views === 0 && stats.totals.notFound === 0 && (
        <Text variant="muted" size="sm">
          {stats.collecting
            ? 'No counts yet — data appears after the next publish once pages get visits.'
            : 'No counts yet — enable first-party analytics in SEO Settings and republish.'}
        </Text>
      )}
      {/* §3.4 404 tease: the count is free; the per-path log is Pro.
          Unlocked, the promised features DO exist — but in the admin
          app, not in this widget (per-page traffic in Search Console,
          the 404 log + one-click redirect prefill in Redirects). Point
          there rather than letting the affordance simply vanish. */}
      {proUnlocked ? (
        <Text variant="muted" size="sm">
          Top pages and the 404 log are in SEO Settings — Search Console for per-page traffic,
          Redirects for the 404 log and one-click redirects.
        </Text>
      ) : (
        <ProLock
          action="Top pages & 404 log"
          benefit="see which URLs get traffic or 404, with one-click redirects."
        />
      )}
    </>
  )
}

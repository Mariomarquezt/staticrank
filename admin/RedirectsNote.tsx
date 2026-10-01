/**
 * The General tab's redirect moment (§3.4). Locked: the shared ProLock.
 * Unlocked: point to the Redirects tab instead — the General tab once
 * showed "Create redirect (Pro)" even with Pro active, because it never
 * read the license (found 2026-09-30). Same pattern as the dashboard
 * widget: when Pro is on, say where the feature lives.
 */
import { Text } from '@instatic/host-ui'
import { ProLock } from './ProLock'

export function RedirectsNote({ proUnlocked }: { proUnlocked: boolean }) {
  if (proUnlocked) {
    return (
      <Text variant="muted" size="sm">
        Create 301/302/410 and regex redirects in the Redirects tab.
      </Text>
    )
  }
  return (
    <ProLock
      action="Create redirect"
      benefit="manual 301/302/410 and regex redirects, with CSV import/export."
    />
  )
}

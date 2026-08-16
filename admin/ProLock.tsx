/**
 * ProLock (task 2.6) — the ONE shared locked-in-place Pro affordance
 * (DESIGN §3.4 / §3.3 rule 6): a disabled action labeled "(Pro)" plus a
 * single line naming ONE concrete benefit, always phrased
 * "Included in Pro — <benefit>". No banners, no dead-end buttons that
 * pretend to work, no dark patterns — the lock always explains exactly
 * what Pro adds at this trigger point.
 *
 * Used by the settings app, the editor SEO panel, and the dashboard
 * widget (each bundle inlines this tiny component; `@instatic/host-ui`
 * stays external everywhere).
 */
import { Button, Stack, Text } from '@instatic/host-ui'

export function proLockCopy(benefit: string): string {
  return `Included in Pro — ${benefit}`
}

export function ProLock({ action, benefit }: { action: string; benefit: string }) {
  return (
    <Stack gap={8} direction="row" align="center">
      <Button variant="ghost" size="sm" disabled>
        {action} (Pro)
      </Button>
      <Text variant="muted" size="sm">
        {proLockCopy(benefit)}
      </Text>
    </Stack>
  )
}

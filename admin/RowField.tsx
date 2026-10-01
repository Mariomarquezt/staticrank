/**
 * One field slot in a repeatable settings row (table templates, sameAs).
 *
 * The host Input renders a BARE <input width:100%> when it has no label
 * or description, but wraps it in a column <div> when it has one (vendor
 * src/ui/components/FormField/FormField.tsx stacked layout). In a row
 * Stack that wrapper sizes to its content, so the first row — the only
 * one with a label — and any row showing an error rendered narrower than
 * the rest (found 2026-09-30). Every field sits in this flex slot instead,
 * so all rows share one width whatever the host renders inside.
 */
import type { ReactNode } from 'react'

export function RowField({ children }: { children: ReactNode }) {
  return <div style={{ flex: '1 1 0', minWidth: 0 }}>{children}</div>
}

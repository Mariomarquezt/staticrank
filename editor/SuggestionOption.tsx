/**
 * One clickable AI suggestion (task 3.8) in the editor SEO panel.
 *
 * A NATIVE button, not the host-ui Button: the host Button is
 * `white-space: nowrap` with a fixed height (vendor
 * src/ui/components/Button/Button.module.css `.btn` / `.size-sm`) and the
 * plugin wrapper exposes no way to change that. Title suggestions (≤60
 * chars) fit, but a ~155-char meta description ran out of the panel
 * (found 2026-09-30). This keeps the host's secondary-button look through
 * the same design tokens while letting the text wrap to the panel width.
 */
import type { CSSProperties } from 'react'

const OPTION_STYLE: CSSProperties = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  padding: 'var(--space-xs) var(--space-s)',
  border: 0,
  borderRadius: 'var(--input-radius)',
  background: 'var(--overlay-10)',
  color: 'var(--text)',
  fontFamily: 'inherit',
  fontSize: 'var(--text-xs)',
  fontWeight: 500,
  lineHeight: 1.4,
  textAlign: 'left',
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  cursor: 'pointer',
}

export function SuggestionOption({
  text,
  onPick,
}: {
  text: string
  onPick: (value: string) => void
}) {
  return (
    <button type="button" style={OPTION_STYLE} onClick={() => onPick(text)}>
      {text}
    </button>
  )
}

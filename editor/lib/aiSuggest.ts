/**
 * AI suggestion model (wave 3.8, editor slice) — pure, React-free logic
 * behind the SEO panel's "Suggest" buttons: route constants, defensive
 * response parsing (status + suggestions), and the button-state logic.
 * No SDK imports — unit-tests under plain `bun test`
 * (editor/lib/__tests__/aiSuggest.test.ts).
 *
 * BUILD-SPLIT RULE (contract, server/ai/types.ts header): server/ai/**
 * is imported ONLY from server/pro.ts + server/mcp/jobs.ts, and this
 * editor bundle ships in BOTH tiers — so the constants the contract also
 * declares (routes, the 3-suggestion cap) are DUPLICATED here on purpose,
 * exactly like editor/lib/proAnalysis.ts duplicates LICENSE_ROUTE. If
 * names drift at merge, the orchestrator adjusts THESE constants only.
 *
 * FREE-TIER SAFETY: the panel renders the Suggest affordance only when
 * `proUnlocked` is true, and the free build's /license route does not
 * exist (404 → locked), so none of this logic ever runs there. Locked
 * behavior stays byte-for-byte the free behavior — presentation only;
 * the server's withProGate stays authoritative on every /ai route.
 *
 * ROUTE CONTRACT (single place on purpose):
 *   GET  <runtime>/ai/status  → { configured, provider: string|null, model }
 *   POST <runtime>/ai/suggest { table, entry, field } →
 *        { suggestions: string[] } | { ok:false, code?, message } | { errors }
 */

// ---------------------------------------------------------------------------
// Route constants (see header — the orchestrator's single adjustment point)
// ---------------------------------------------------------------------------

export const AI_STATUS_ROUTE = '/ai/status'
export const AI_SUGGEST_ROUTE = '/ai/suggest'

/** Contract cap (server/ai/types.ts AI_SUGGESTIONS_PER_CALL) — duplicated
 * here because this bundle must not import server/ai (build-split rule). */
export const AI_SUGGESTION_CAP = 3

/** Honest tooltip for the disabled Suggest button when no provider is set. */
export const AI_CONFIGURE_TOOLTIP = 'Configure an AI provider in SEO Settings → AI'

/** The two panel fields the Suggest buttons cover (POST /ai/suggest `field`). */
export type SuggestField = 'title' | 'metaDescription'

// ---------------------------------------------------------------------------
// Defensive parsing (drop-don't-crash)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** GET /ai/status view — never carries the key (contract hard rule). */
export interface AiStatusView {
  configured: boolean
  /** Provider id ('anthropic' | 'openai' | 'openrouter') or null when unset. */
  provider: string | null
  /** Effective model id; '' when the server reports none. */
  model: string
}

/**
 * Parse a GET /ai/status body defensively. `configured` must be an
 * explicit boolean or the whole parse fails (null = the panel treats the
 * status as unknown and keeps the button disabled — never a fake
 * "configured"). Provider/model degrade to null/'' individually.
 */
export function parseAiStatus(body: unknown): AiStatusView | null {
  if (!isRecord(body)) return null
  if (typeof body.configured !== 'boolean') return null
  return {
    configured: body.configured,
    provider: typeof body.provider === 'string' && body.provider !== '' ? body.provider : null,
    model: typeof body.model === 'string' ? body.model : '',
  }
}

/**
 * Parse an /ai route error body: `{ message }` is surfaced VERBATIM (the
 * server sanitizes its own messages — contract: never the key, provider
 * bodies truncated); the Pro gate's `{"error":"pro_required"}` gets a
 * human line; `{ errors: [{message}] }` (route-validation shape) uses the
 * first message; anything else degrades to a generic status-code line.
 */
export function parseAiError(body: unknown, httpStatus: number): string {
  if (isRecord(body)) {
    if (typeof body.message === 'string' && body.message !== '') return body.message
    if (body.error === 'pro_required') return 'Pro is required for AI suggestions.'
    if (Array.isArray(body.errors)) {
      const first = body.errors.find(
        (e: unknown): e is { message: string } =>
          isRecord(e) && typeof e.message === 'string' && e.message !== '',
      )
      if (first !== undefined) return first.message
    }
  }
  return `request failed with ${httpStatus}`
}

export type SuggestResult =
  | { ok: true; suggestions: string[] }
  | { ok: false; message: string }

/**
 * Shape a raw suggestions list the way the picker needs it: strings only,
 * trimmed, empties dropped, exact duplicates dropped (first wins), capped
 * at the contract's per-call count. Mirrors the server's own defensive
 * parse so a misbehaving provider can never render junk rows.
 */
export function shapeSuggestions(items: unknown[]): string[] {
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || out.includes(trimmed)) continue
    out.push(trimmed)
    if (out.length >= AI_SUGGESTION_CAP) break
  }
  return out
}

/**
 * Parse a POST /ai/suggest response body. Success requires a 2xx status
 * (review 3.8 #6 — a suggestions-shaped body on a 500/error page must
 * resolve through the error parser, never fill the picker) AND a
 * `suggestions` array that still has at least one usable string after
 * shaping — an empty or unusable list becomes an honest failure line
 * rather than an empty picker.
 */
export function parseSuggestResult(body: unknown, httpStatus: number): SuggestResult {
  if (httpStatus >= 200 && httpStatus < 300 && isRecord(body) && Array.isArray(body.suggestions)) {
    const suggestions = shapeSuggestions(body.suggestions)
    if (suggestions.length > 0) return { ok: true, suggestions }
    return { ok: false, message: 'The provider returned no usable suggestions — try again.' }
  }
  return { ok: false, message: parseAiError(body, httpStatus) }
}

// ---------------------------------------------------------------------------
// Button state
// ---------------------------------------------------------------------------

export interface SuggestButtonView {
  disabled: boolean
  /** Present only when the disable is explainable (provider not set). */
  tooltip: string | undefined
}

/**
 * The Suggest button's state for the CURRENT status + request activity.
 * status null = /ai/status has not resolved (or failed) — disabled with
 * no tooltip (nothing honest to claim yet); configured=false — disabled
 * with the configure tooltip; busy (any in-flight suggest OR the panel's
 * own save) — disabled to keep one request per intent. Visibility itself
 * (proUnlocked) is the caller's branch, exactly like every Pro affordance.
 */
export function suggestButtonView(status: AiStatusView | null, busy: boolean): SuggestButtonView {
  if (status === null) return { disabled: true, tooltip: undefined }
  if (!status.configured) return { disabled: true, tooltip: AI_CONFIGURE_TOOLTIP }
  return { disabled: busy, tooltip: undefined }
}

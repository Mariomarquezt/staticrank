/**
 * Wave 3.8 (editor slice) — pure AI-suggestion logic: defensive status
 * parsing, suggestion shaping (trim/dedupe/cap), suggest-result parsing,
 * error parsing, and the Suggest-button state.
 */
import { describe, expect, test } from 'bun:test'
import {
  AI_CONFIGURE_TOOLTIP,
  AI_STATUS_ROUTE,
  AI_SUGGEST_ROUTE,
  AI_SUGGESTION_CAP,
  parseAiError,
  parseAiStatus,
  parseSuggestResult,
  shapeSuggestions,
  suggestButtonView,
  type AiStatusView,
} from '../aiSuggest'

const CONFIGURED: AiStatusView = {
  configured: true,
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
}

describe('route constants', () => {
  test('match the frozen contract paths', () => {
    expect(AI_STATUS_ROUTE).toBe('/ai/status')
    expect(AI_SUGGEST_ROUTE).toBe('/ai/suggest')
    expect(AI_SUGGESTION_CAP).toBe(3)
  })
})

describe('parseAiStatus', () => {
  test('parses a full contract body', () => {
    expect(
      parseAiStatus({ configured: true, provider: 'openai', model: 'gpt-4o-mini' }),
    ).toEqual({ configured: true, provider: 'openai', model: 'gpt-4o-mini' })
  })

  test('configured must be an explicit boolean', () => {
    expect(parseAiStatus({ configured: 'yes', provider: null, model: '' })).toBeNull()
    expect(parseAiStatus({ provider: 'openai', model: 'x' })).toBeNull()
  })

  test('non-object bodies yield null', () => {
    expect(parseAiStatus(null)).toBeNull()
    expect(parseAiStatus('nope')).toBeNull()
    expect(parseAiStatus([1, 2])).toBeNull()
  })

  test('provider degrades to null, model to empty string', () => {
    expect(parseAiStatus({ configured: false, provider: null, model: 7 })).toEqual({
      configured: false,
      provider: null,
      model: '',
    })
    expect(parseAiStatus({ configured: false, provider: '', model: 'm' })).toEqual({
      configured: false,
      provider: null,
      model: 'm',
    })
  })
})

describe('shapeSuggestions', () => {
  test('trims, drops empties and non-strings, dedupes, caps at the contract count', () => {
    expect(
      shapeSuggestions(['  One  ', '', 'Two', 'One', 42, null, 'Three', 'Four']),
    ).toEqual(['One', 'Two', 'Three'])
  })

  test('empty input yields empty output', () => {
    expect(shapeSuggestions([])).toEqual([])
    expect(shapeSuggestions(['   ', 3])).toEqual([])
  })
})

describe('parseSuggestResult', () => {
  test('a usable suggestions array succeeds shaped', () => {
    expect(parseSuggestResult({ suggestions: [' A ', 'B', 'A', 'C', 'D'] }, 200)).toEqual({
      ok: true,
      suggestions: ['A', 'B', 'C'],
    })
  })

  test('an empty/unusable list is an honest failure, never an empty picker', () => {
    const result = parseSuggestResult({ suggestions: ['', 42] }, 200)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('no usable suggestions')
  })

  test('error bodies surface the sanitized server message verbatim', () => {
    expect(parseSuggestResult({ ok: false, code: 'provider_error', message: 'HTTP 429 from provider' }, 502)).toEqual({
      ok: false,
      message: 'HTTP 429 from provider',
    })
  })

  test('malformed bodies degrade to the status-code line', () => {
    expect(parseSuggestResult(null, 500)).toEqual({ ok: false, message: 'request failed with 500' })
  })

  // Review 3.8 #6 — a suggestions-shaped body on an HTTP error status
  // must never fill the picker; it resolves through the error parser.
  test('suggestions on a non-2xx status are rejected as an error', () => {
    expect(parseSuggestResult({ suggestions: ['A', 'B'] }, 500)).toEqual({
      ok: false,
      message: 'request failed with 500',
    })
    expect(parseSuggestResult({ suggestions: ['A'], message: 'error page' }, 403)).toEqual({
      ok: false,
      message: 'error page',
    })
    // 2xx variants still succeed.
    expect(parseSuggestResult({ suggestions: ['A'] }, 201)).toEqual({ ok: true, suggestions: ['A'] })
  })
})

describe('parseAiError', () => {
  test('message verbatim when present', () => {
    expect(parseAiError({ message: 'not configured' }, 400)).toBe('not configured')
  })

  test('pro gate 403 gets a human line', () => {
    expect(parseAiError({ error: 'pro_required' }, 403)).toBe('Pro is required for AI suggestions.')
  })

  test('route-validation errors array uses the first message', () => {
    expect(parseAiError({ errors: [{ field: 'field', message: 'unknown field' }] }, 400)).toBe(
      'unknown field',
    )
  })

  test('everything else degrades to the status-code line', () => {
    expect(parseAiError(undefined, 502)).toBe('request failed with 502')
    expect(parseAiError({ errors: 'nope' }, 500)).toBe('request failed with 500')
  })
})

describe('suggestButtonView', () => {
  test('unknown status (null) disables with NO tooltip claim', () => {
    expect(suggestButtonView(null, false)).toEqual({ disabled: true, tooltip: undefined })
  })

  test('unconfigured disables with the honest configure tooltip', () => {
    expect(suggestButtonView({ configured: false, provider: null, model: '' }, false)).toEqual({
      disabled: true,
      tooltip: AI_CONFIGURE_TOOLTIP,
    })
  })

  test('configured + idle is enabled', () => {
    expect(suggestButtonView(CONFIGURED, false)).toEqual({ disabled: false, tooltip: undefined })
  })

  test('configured + busy disables without a tooltip', () => {
    expect(suggestButtonView(CONFIGURED, true)).toEqual({ disabled: true, tooltip: undefined })
  })
})

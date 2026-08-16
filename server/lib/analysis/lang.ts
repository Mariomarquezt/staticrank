/**
 * lang — tokenization, phrase matching, sentence splitting and the small
 * English heuristics used by the readability checks.
 *
 * Sandbox rules (QuickJS, ES2020): Unicode property escapes (`\p{L}`, `\p{N}`)
 * are part of the ES2018+ regex spec and supported by QuickJS's full-unicode
 * build; no Intl, no locale assumptions. `toLowerCase()`/`normalize('NFC')`
 * are ES2015 built-ins.
 *
 * Tokenization: a word is a run of Unicode letters/digits, optionally joined
 * by internal apostrophes ("don't", "l’équipe" tokenizes as "l’équipe"…
 * apostrophe-joined). Keyword matching is case-insensitive on NFC-normalized
 * text, and multi-word keywords match as a CONTIGUOUS word sequence — which
 * makes matching tolerant of flexible whitespace, punctuation between words,
 * and inline tags removed upstream.
 */

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu

/** NFC-normalize + lowercase. */
export function normalizeText(input: string): string {
  return input.normalize('NFC').toLowerCase()
}

/** Normalized word tokens of a text. */
export function tokenizeWords(input: string): string[] {
  const out: string[] = []
  for (const m of normalizeText(input).matchAll(WORD_RE)) out.push(m[0])
  return out
}

export function countWords(input: string): number {
  return tokenizeWords(input).length
}

/**
 * Sentinel token separating text blocks in a block-aware token stream. It is
 * `'\n'`, which the word regex can never produce, so a keyword phrase can
 * never equal or span it.
 */
export const TOKEN_BREAK = '\n'

/**
 * Tokenize while PRESERVING block boundaries: every `\n` in the input (block
 * separators and `<br>` breaks from extraction; line breaks in plain text)
 * becomes a TOKEN_BREAK sentinel in the stream. Phrase matching against this
 * stream cannot cross a boundary — `<p>best</p><p>coffee</p>` does NOT match
 * the keyword "best coffee", while inline-tag joins (no `\n` emitted) still
 * do. Callers needing a pure word count must filter or use tokenizeWords.
 */
export function tokenizeBlocks(text: string): string[] {
  const out: string[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) out.push(TOKEN_BREAK)
    for (const m of normalizeText(lines[i]).matchAll(WORD_RE)) out.push(m[0])
  }
  return out
}

/**
 * Index of the first occurrence of `needle` as a contiguous word run inside
 * `hay`, or -1. Both are token arrays from tokenizeWords.
 */
export function phraseIndexOf(hay: string[], needle: string[], from = 0): number {
  if (needle.length === 0 || needle.length > hay.length) return -1
  const last = hay.length - needle.length
  for (let i = from; i <= last; i += 1) {
    let hit = true
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) {
        hit = false
        break
      }
    }
    if (hit) return i
  }
  return -1
}

/** Non-overlapping occurrence count of the phrase in the token array. */
export function phraseOccurrences(hay: string[], needle: string[]): number {
  if (needle.length === 0) return 0
  let count = 0
  let i = 0
  for (;;) {
    const at = phraseIndexOf(hay, needle, i)
    if (at === -1) break
    count += 1
    i = at + needle.length
  }
  return count
}

/** Convenience: does `text` contain `keyword` as a phrase? */
export function containsPhrase(text: string, keyword: string): boolean {
  return phraseIndexOf(tokenizeWords(text), tokenizeWords(keyword)) !== -1
}

/**
 * Abbreviations whose trailing dot must not end a sentence. English-only and
 * ADDITIVE — extend the list as false splits surface; a missing entry only
 * costs an over-eager split, never a crash. Compared lowercase, dot included.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'e.g.', 'i.e.', 'dr.', 'mr.', 'mrs.', 'ms.', 'prof.', 'u.s.', 'etc.',
  'vs.', 'approx.', 'st.', 'jr.', 'sr.', 'no.', 'fig.', 'vol.', 'inc.',
  'ltd.', 'dept.', 'est.',
])

/** Single-letter initial like "J." — also not a sentence end. */
const INITIAL_RE = /^\p{L}\.$/u

/**
 * Split text into sentences on `.`, `!`, `?`, `…` followed by whitespace or
 * end of text, tolerating closing quotes/brackets after the terminator.
 * Newlines also end a sentence (block boundaries from extraction). A lone
 * `.` directly after a known abbreviation or a single-letter initial is not
 * a boundary (see ABBREVIATIONS — English-only heuristic).
 */
export function splitSentences(text: string): string[] {
  const out: string[] = []
  let start = 0
  let i = 0
  const isTerm = (ch: string): boolean => ch === '.' || ch === '!' || ch === '?' || ch === '…'
  const isCloser = (ch: string): boolean => /["'’”»)\]]/.test(ch)
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\n') {
      const s = text.slice(start, i).trim()
      if (s.length > 0) out.push(s)
      i += 1
      start = i
      continue
    }
    if (isTerm(ch)) {
      let j = i + 1
      while (j < text.length && isTerm(text[j])) j += 1
      const closersStart = j
      while (j < text.length && isCloser(text[j])) j += 1
      if (j >= text.length || /\s/.test(text[j])) {
        // A bare '.' (single terminator, no closers) after an abbreviation
        // or initial does not end the sentence.
        if (ch === '.' && j === i + 1 && closersStart === j) {
          let back = i
          while (back > start && !/\s/.test(text[back - 1])) back -= 1
          const token = text.slice(back, i + 1).toLowerCase()
          if (ABBREVIATIONS.has(token) || INITIAL_RE.test(token)) {
            i = j
            continue
          }
        }
        const s = text.slice(start, j).trim()
        if (s.length > 0) out.push(s)
        i = j
        start = j
        continue
      }
      // e.g. "3.14" or "example.com" — not a boundary.
      i = j
      continue
    }
    i += 1
  }
  const rest = text.slice(start).trim()
  if (rest.length > 0) out.push(rest)
  return out
}

/**
 * Small English stopword set for the language heuristic (and only for that —
 * scoring never removes stopwords). ~130 of the highest-frequency English
 * function words.
 */
export const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'at',
  'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down',
  'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'once',
  'here', 'there', 'all', 'any', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'can', 'cannot', 'will', 'just', 'should', 'now',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she',
  'her', 'it', 'its', 'they', 'them', 'their', 'what', 'which', 'who',
  'whom', 'this', 'that', 'these', 'those', 'am', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do',
  'does', 'did', 'doing', 'would', 'could', 'ought', 'of', 'as', 'until',
  'while', 'because', 'why', 'how', 'where', 'also', 'one', 'get', 'like',
  'make', 'see', 'use', 'way', 'many', 'new', 'first', 'well', 'even',
  'back', 'good', 'much', 'go', 'know', 'take', 'may', 'might', 'must',
  "don't", "it's", "that's", "isn't", "won't", "can't", 'us',
])

/**
 * Language heuristic (documented threshold): a text "looks English" when at
 * least 40% of its word tokens are in ENGLISH_STOPWORDS. Texts under 10 words
 * are assumed English (too little signal to declare otherwise).
 */
export function looksEnglish(tokens: string[]): boolean {
  if (tokens.length < 10) return true
  let hits = 0
  for (const t of tokens) {
    if (ENGLISH_STOPWORDS.has(t)) hits += 1
  }
  return hits / tokens.length >= 0.4
}

const PASSIVE_AUXILIARIES: ReadonlySet<string> = new Set([
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'get', 'gets', 'got', 'gotten', 'getting',
])

const IRREGULAR_PARTICIPLES: ReadonlySet<string> = new Set([
  'done', 'made', 'given', 'taken', 'seen', 'known', 'written', 'found',
  'held', 'brought', 'kept', 'left', 'put', 'set', 'shown', 'told',
  'thought', 'built', 'sent', 'spent', 'broken', 'chosen', 'driven',
  'eaten', 'fallen', 'forgotten', 'hidden', 'paid', 'read', 'said', 'sold',
  'spoken', 'stolen', 'understood', 'worn', 'won', 'begun', 'drawn',
  'grown', 'thrown', 'caught', 'taught', 'bought', 'felt', 'heard',
  'meant', 'met', 'lost', 'run', 'become', 'born', 'beaten', 'blown',
  'frozen', 'ridden', 'risen', 'sung', 'swum', 'torn', 'woken',
])

function looksLikeParticiple(word: string): boolean {
  if (IRREGULAR_PARTICIPLES.has(word)) return true
  return word.length > 3 && word.endsWith('ed')
}

/**
 * Passive-voice heuristic: a form of "to be"/"to get" followed within the
 * next three words by a probable past participle ("-ed" or a common
 * irregular). English-only; callers gate on looksEnglish.
 */
export function isPassiveSentence(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    if (!PASSIVE_AUXILIARIES.has(tokens[i])) continue
    const limit = Math.min(tokens.length, i + 4)
    for (let j = i + 1; j < limit; j += 1) {
      if (looksLikeParticiple(tokens[j])) return true
    }
  }
  return false
}

const TRANSITION_WORDS: ReadonlySet<string> = new Set([
  'however', 'therefore', 'moreover', 'furthermore', 'consequently',
  'meanwhile', 'nevertheless', 'nonetheless', 'additionally', 'finally',
  'firstly', 'secondly', 'thirdly', 'lastly', 'indeed', 'likewise',
  'similarly', 'instead', 'otherwise', 'thus', 'hence', 'accordingly',
  'besides', 'although', 'though', 'because', 'since', 'while', 'whereas',
  'unless', 'until', 'afterwards', 'earlier', 'later', 'next', 'then',
  'overall', 'importantly', 'specifically', 'notably', 'particularly',
  'certainly', 'clearly', 'obviously', 'ultimately', 'initially',
  'subsequently', 'eventually', 'alternatively', 'first', 'second', 'third',
])

const TRANSITION_PHRASES: readonly string[][] = [
  ['for', 'example'], ['for', 'instance'], ['in', 'addition'],
  ['as', 'a', 'result'], ['in', 'conclusion'], ['on', 'the', 'other', 'hand'],
  ['in', 'fact'], ['of', 'course'], ['as', 'well', 'as'],
  ['in', 'other', 'words'], ['to', 'sum', 'up'], ['in', 'short'],
  ['above', 'all'], ['in', 'contrast'], ['by', 'contrast'], ['due', 'to'],
  ['such', 'as'], ['first', 'of', 'all'], ['most', 'importantly'],
  ['even', 'though'], ['in', 'order', 'to'], ['in', 'particular'],
  ['to', 'begin', 'with'], ['as', 'soon', 'as'], ['as', 'long', 'as'],
]

/** Does the sentence (token array) contain a transition word or phrase? */
export function hasTransition(tokens: string[]): boolean {
  for (const t of tokens) {
    if (TRANSITION_WORDS.has(t)) return true
  }
  for (const phrase of TRANSITION_PHRASES) {
    if (phraseIndexOf(tokens, phrase as string[]) !== -1) return true
  }
  return false
}

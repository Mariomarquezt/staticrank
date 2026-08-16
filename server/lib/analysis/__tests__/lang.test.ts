import { describe, expect, test } from 'bun:test'
import {
  containsPhrase,
  hasTransition,
  isPassiveSentence,
  looksEnglish,
  phraseIndexOf,
  phraseOccurrences,
  splitSentences,
  tokenizeBlocks,
  tokenizeWords,
} from '../lang'

describe('tokenizeWords', () => {
  test('unicode letters/digits, lowercased', () => {
    expect(tokenizeWords('Hello, World! 42 times')).toEqual(['hello', 'world', '42', 'times'])
  })

  test('non-Latin scripts tokenize via \\p{L}', () => {
    expect(tokenizeWords('Żółć über naïve')).toEqual(['żółć', 'über', 'naïve'])
  })

  test('internal apostrophes stay inside the word', () => {
    expect(tokenizeWords("don't stop")).toEqual(["don't", 'stop'])
    expect(tokenizeWords('it’s fine')).toEqual(['it’s', 'fine'])
  })

  test('NFC normalization: composed and decomposed é tokenize identically', () => {
    const composed = 'caf\u00e9'
    const decomposed = 'cafe\u0301'
    expect(tokenizeWords(composed)).toEqual(tokenizeWords(decomposed))
  })
})

describe('phrase matching', () => {
  test('case-insensitive with flexible whitespace', () => {
    expect(containsPhrase('The BEST   Coffee\n beans here', 'best coffee beans')).toBe(true)
  })

  test('punctuation between words does not block a phrase', () => {
    expect(containsPhrase('coffee, beans', 'coffee beans')).toBe(true)
  })

  test('order matters and partial words do not match', () => {
    expect(containsPhrase('beans coffee', 'coffee beans')).toBe(false)
    expect(containsPhrase('coffeepot beans', 'coffee beans')).toBe(false)
  })

  test('occurrences are non-overlapping', () => {
    const hay = tokenizeWords('go go go go')
    expect(phraseOccurrences(hay, tokenizeWords('go go'))).toBe(2)
  })

  test('empty needle never matches', () => {
    expect(phraseOccurrences(tokenizeWords('a b'), [])).toBe(0)
  })

  test('block-aware tokens refuse phrases across newlines (finding 1)', () => {
    const stream = tokenizeBlocks('best\ncoffee')
    expect(phraseIndexOf(stream, tokenizeWords('best coffee'))).toBe(-1)
    // Same words inside one block still match.
    expect(phraseIndexOf(tokenizeBlocks('best coffee'), tokenizeWords('best coffee'))).toBe(0)
  })
})

describe('splitSentences', () => {
  test('splits on . ! ? followed by space or end', () => {
    expect(splitSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?'])
  })

  test('tolerates quotes and brackets after the terminator', () => {
    expect(splitSentences('He said "Stop!" Then he left.')).toEqual(['He said "Stop!"', 'Then he left.'])
    expect(splitSentences('(It works.) Yes.')).toEqual(['(It works.)', 'Yes.'])
  })

  test('decimal points and domains do not split', () => {
    expect(splitSentences('Pi is 3.14 exactly. See example.com now.')).toEqual([
      'Pi is 3.14 exactly.',
      'See example.com now.',
    ])
  })

  test('ellipsis ends a sentence', () => {
    expect(splitSentences('Wait… what? Yes.')).toEqual(['Wait…', 'what?', 'Yes.'])
  })

  test('newlines (block boundaries) end sentences without punctuation', () => {
    expect(splitSentences('A heading\nA sentence here.')).toEqual(['A heading', 'A sentence here.'])
  })

  test('empty and whitespace-only input', () => {
    expect(splitSentences('')).toEqual([])
    expect(splitSentences('  \n ')).toEqual([])
  })

  test('abbreviations do not end sentences (finding 7 — English-only list)', () => {
    expect(splitSentences('Dr. Smith arrived early. He sat down.')).toEqual([
      'Dr. Smith arrived early.',
      'He sat down.',
    ])
    expect(splitSentences('Use apples, oranges, etc. when baking pies.')).toEqual([
      'Use apples, oranges, etc. when baking pies.',
    ])
    expect(splitSentences('This works, e.g. right here. Done.')).toEqual([
      'This works, e.g. right here.',
      'Done.',
    ])
  })

  test('single-letter initials do not end sentences', () => {
    expect(splitSentences('J. R. Smith spoke well. Everyone clapped.')).toEqual([
      'J. R. Smith spoke well.',
      'Everyone clapped.',
    ])
  })
})

describe('looksEnglish (documented: >=40% of tokens in the stopword set; <10 words assumed English)', () => {
  test('ordinary English prose passes', () => {
    expect(
      looksEnglish(tokenizeWords('This is a test of the system and it should be seen as mostly common words here')),
    ).toBe(true)
  })

  test('Polish prose fails', () => {
    expect(
      looksEnglish(
        tokenizeWords('Szybki brązowy lis przeskakuje nad leniwym psem oraz biegnie przez ciemny las każdego wieczoru'),
      ),
    ).toBe(false)
  })

  test('short texts are assumed English', () => {
    expect(looksEnglish(tokenizeWords('krótki tekst bez sygnału'))).toBe(true)
  })
})

describe('passive voice heuristic', () => {
  test('be + -ed participle', () => {
    expect(isPassiveSentence(tokenizeWords('The house was painted last year'))).toBe(true)
  })

  test('be + irregular participle', () => {
    expect(isPassiveSentence(tokenizeWords('The letter was written yesterday'))).toBe(true)
    expect(isPassiveSentence(tokenizeWords('Mistakes were made'))).toBe(true)
  })

  test('aux more than three words from participle is not flagged', () => {
    expect(isPassiveSentence(tokenizeWords('He was very much a friend to painted turtles'))).toBe(false)
  })

  test('active sentences pass', () => {
    expect(isPassiveSentence(tokenizeWords('She writes letters every day'))).toBe(false)
  })
})

describe('transition words', () => {
  test('single transition word', () => {
    expect(hasTransition(tokenizeWords('However, this works well'))).toBe(true)
  })

  test('multi-word transition phrase', () => {
    expect(hasTransition(tokenizeWords('For example, cats purr'))).toBe(true)
    expect(hasTransition(tokenizeWords('On the other hand it rains'))).toBe(true)
  })

  test('no transition', () => {
    expect(hasTransition(tokenizeWords('Cats purr loudly at night'))).toBe(false)
  })
})

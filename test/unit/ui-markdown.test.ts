import { describe, expect, it } from 'vitest'
import { inlineText, isSoundWord, parseInline, parseParagraphs } from '@/lib/client/markdown'
import fixtures from '@/lib/mock/fixture-stories.json'

/**
 * Prose rendering, tested against the real reference prose rather than invented strings - the
 * whole reason the fixtures are built from `storytime-plan/reference-stories/` is so the reader is
 * designed around the markdown the stories actually contain.
 */
describe('isSoundWord', () => {
  it('recognizes the sound words the references use', () => {
    for (const word of ['WHOOOOSH', 'WHOOOOOSH', 'CLICK!', 'HISSSS', 'CLUNK. HISSSS. POP!', 'PLAY WELL!']) {
      expect(isSoundWord(word), word).toBe(true)
    }
  })

  it('does not treat every bold capital as a sound', () => {
    for (const word of ['LEGO', 'LEGOLAND', 'BILLUND, DENMARK.', '1932', 'Ole Kirk Christiansen', 'leg godt']) {
      expect(isSoundWord(word), word).toBe(false)
    }
  })
})

describe('parseInline', () => {
  it('reads bold, italic and both', () => {
    expect(parseInline('a **bold** b')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', text: 'bold', sound: false },
      { kind: 'text', text: ' b' },
    ])
    expect(parseInline('the Danish ***leg godt***')).toEqual([
      { kind: 'text', text: 'the Danish ' },
      { kind: 'strongEm', text: 'leg godt', sound: false },
    ])
    expect(parseInline('Left corner. *Thud.*')).toEqual([
      { kind: 'text', text: 'Left corner. ' },
      { kind: 'em', text: 'Thud.' },
    ])
  })

  it('flags a bold sound word', () => {
    expect(parseInline('and with a great big **WHOOOOSH**, the boys')).toContainEqual({
      kind: 'strong',
      text: 'WHOOOOSH',
      sound: true,
    })
  })

  it('never loses characters', () => {
    const source = 'It said: **BILLUND, DENMARK.** And *then* ***it clicked***. 100% of it.'
    expect(inlineText(parseInline(source))).toBe(source.replace(/\*/g, ''))
  })

  it('leaves a stray asterisk alone rather than eating the rest of the line', () => {
    expect(inlineText(parseInline('2 * 3 = 6'))).toBe('2 * 3 = 6')
  })
})

describe('parseParagraphs', () => {
  it('splits on blank lines and keeps soft wraps as spaces', () => {
    const paragraphs = parseParagraphs('One line\nwrapped.\n\nSecond paragraph.')
    expect(paragraphs).toHaveLength(2)
    expect(inlineText(paragraphs[0] ?? [])).toBe('One line wrapped.')
    expect(inlineText(paragraphs[1] ?? [])).toBe('Second paragraph.')
  })

  it('drops horizontal rules and empty runs', () => {
    expect(parseParagraphs('One.\n\n---\n\n\n\nTwo.')).toHaveLength(2)
  })

  it('parses every chapter of every fixture story without dropping prose', () => {
    for (const story of fixtures.stories) {
      for (const chapter of story.content.chapters) {
        const paragraphs = parseParagraphs(chapter.text)
        expect(paragraphs.length, `${story.title} / ${chapter.heading}`).toBeGreaterThan(0)
        const rendered = paragraphs.map((p) => inlineText(p)).join(' ')
        // Every word of the source survives, minus markdown punctuation and line breaks.
        const sourceWords = chapter.text.replace(/\*/g, '').split(/\s+/).filter(Boolean).length
        const renderedWords = rendered.split(/\s+/).filter(Boolean).length
        expect(renderedWords, `${story.title} / ${chapter.heading}`).toBe(sourceWords)
      }
    }
  })
})

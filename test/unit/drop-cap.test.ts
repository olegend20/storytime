import { describe, expect, it } from 'vitest'
import { canDropCap } from '@/components/reader/Prose'
import { parseParagraphs } from '@/lib/client/markdown'

/** The reader's drop cap (issue #17) is only set where it can sit properly. */
const first = (text: string) => parseParagraphs(text)[0]!

describe('canDropCap', () => {
  const long =
    'The water outside the window was dark and cold, and bits of ice floated near the top, turning slowly in the current while the little submarine hummed.'

  it('a long paragraph that opens with a letter takes one', () => {
    expect(canDropCap(first(long))).toBe(true)
  })

  it('a name with an accented or non-English first letter takes one too', () => {
    expect(canDropCap(first(`Élodie ${long.toLowerCase()}`))).toBe(true)
    expect(canDropCap(first(`Øyvind ${long.toLowerCase()}`))).toBe(true)
    expect(canDropCap(first(`7 o'clock came and ${long.toLowerCase()}`))).toBe(false)
  })

  it('a short opening line does not: the next paragraph would wrap around the initial', () => {
    expect(canDropCap(first('Ready? asked Milo.'))).toBe(false)
  })

  it('an opening quote mark does not: the punctuation would be enlarged with the letter', () => {
    expect(canDropCap(first(`“${long}”`))).toBe(false)
    expect(canDropCap(first(`"${long}"`))).toBe(false)
  })

  it('a sound word or emphasis first does not: it has a typeface of its own', () => {
    expect(canDropCap(first(`**CLICK!** ${long}`))).toBe(false)
    expect(canDropCap(first(`*Slowly* ${long}`))).toBe(false)
  })

  it('an empty paragraph does not', () => {
    expect(canDropCap([])).toBe(false)
  })
})

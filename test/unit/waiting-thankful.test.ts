import { describe, expect, it } from 'vitest'
import waitingJson from '@/config/waiting.json'
import { GROWN_UP_AFTER_MS, GROWN_UP_LINE, thankfulQuestion } from '@/lib/waiting'

/** VT-TH4 (issue #112): the waiting screen's question comes from config/waiting.json. */
describe('the thankful question', () => {
  it('names the children the way the waiting screen does', () => {
    expect(thankfulQuestion(['Sam'])).toBe('Sam, what are you thankful for today?')
    expect(thankfulQuestion(['Milo', 'Juno', 'Theo'])).toBe('Milo, Juno & Theo, what are you thankful for today?')
  })

  it('still reads as a question with no names', () => {
    expect(thankfulQuestion([])).toBe('What are you thankful for today?')
  })

  it('asks the grown-up after 40 seconds, from config', () => {
    expect(GROWN_UP_LINE).toBe(waitingJson.grown_up)
    expect(GROWN_UP_LINE).toBe('And you, grown-up?')
    expect(GROWN_UP_AFTER_MS).toBe(40_000)
  })
})

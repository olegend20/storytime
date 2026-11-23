import { describe, expect, it } from 'vitest'
import { AMAZON, KINDLE_HELP_OFF, KINDLE_HELP_PATH, kindleHelpSteps, kindleHelpTroubles } from '@/lib/kindle/help'
import { KINDLE_SENDS_PER_DAY } from '@/lib/kindle/send'

/**
 * lastten.org/kindle (issue #117): the setup instructions. The page is only useful if it names
 * the address the server really sends from, and the list on Amazon it has to be added to.
 */
describe('Send to Kindle instructions', () => {
  const from = 'kindle@lastten.org'
  const steps = kindleHelpSteps(from)

  it('has the four steps in the order a parent does them', () => {
    expect(steps.map((s) => s.id)).toEqual(['find-address', 'approve-sender', 'save-address', 'send-book'])
    for (const step of steps) {
      expect(step.title.length).toBeGreaterThan(0)
      expect(step.body.length).toBeGreaterThan(0)
    }
  })

  it("names Amazon's approved-senders list and the address we send from", () => {
    const approve = steps.find((s) => s.id === 'approve-sender')!.body.join(' ')
    expect(approve).toContain('Approved Personal Document E-mail List')
    expect(approve).toContain(from)
    expect(kindleHelpTroubles(from).join(' ')).toContain(from)
  })

  it('uses the address it is given and no other', () => {
    const other = 'books@example.org'
    const text = [...kindleHelpSteps(other).flatMap((s) => [s.title, ...s.body]), ...kindleHelpTroubles(other)].join(' ')
    const addresses = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []
    expect(new Set(addresses)).toEqual(new Set([other]))
    expect(KINDLE_HELP_OFF).not.toMatch(/@/)
  })

  it('says books go one at a time, old ones included, up to the real daily limit', () => {
    const send = steps.find((s) => s.id === 'send-book')!.body.join(' ')
    expect(send).toMatch(/old one from your library/)
    expect(send).toMatch(/one at a time/)
    expect(send).toMatch(/Nothing is sent on its own/)
    expect(send).toContain(`up to ${KINDLE_SENDS_PER_DAY} a day`)
  })

  it('points at Amazon over https and at /kindle here', () => {
    expect(KINDLE_HELP_PATH).toBe('/kindle')
    for (const url of Object.values(AMAZON)) expect(new URL(url).protocol).toBe('https:')
    for (const url of Object.values(AMAZON)) expect(new URL(url).hostname).toBe('www.amazon.com')
  })
})

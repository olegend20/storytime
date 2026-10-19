import { describe, expect, it } from 'vitest'
import { invalidBecause } from '@/lib/quality/review'

/**
 * VT-Q2 (issue #58): a quality review whose JSON fails validation still fails closed, and now
 * says why. Four reviews failed this way in the 32-story eval on #40 with no trace.
 */
const verdicts = {
  age_appropriate: true,
  scary_level: 0,
  kids_are_active_participants: true,
  facts_consistent_with_pack: true,
  tone_matches_request: true,
}

describe('VT-Q2: why a quality review did not validate', () => {
  it('names the field and the rule it broke, not the text', () => {
    const long = 'chapter 4: ' + 'x'.repeat(320)
    const why = invalidBecause(JSON.stringify({ ...verdicts, reasons: ['fine', long] }))
    expect(why).toMatch(/reasons\.1: .*300/)
    expect(why).not.toContain('xxxx')
  })

  it('names a missing or mistyped verdict', () => {
    const { tone_matches_request: _drop, ...rest } = verdicts
    expect(invalidBecause(JSON.stringify({ ...rest, scary_level: 'low', reasons: [] }))).toMatch(
      /scary_level: .*tone_matches_request: /,
    )
  })

  it('says when the answer is not JSON at all, and is empty for a valid review', () => {
    expect(invalidBecause('Here is my review: it is great')).toBe(' (not JSON)')
    expect(invalidBecause(JSON.stringify({ ...verdicts, reasons: [] }))).toBe('')
  })
})

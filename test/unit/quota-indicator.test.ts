import { describe, expect, it } from 'vitest'
import { outOfStories, quotaMessage } from '@/components/newstory/QuotaIndicator'
import { ErrorBody, HTTP_STATUS_FOR_ERROR, QuotaResponse, SseEvent } from '@/lib/schemas/api'
import { parentMessage } from '@/lib/messages'
import { LIMIT_MESSAGES } from '@/lib/limits/messages'
import { storyCreditsEnabled } from '@/lib/limits/credits'
import { needsFreeRetryNote } from '@/lib/client/generate'

/** Issue #128, VT-CR10: what the new-story page says about the stories a family has left. */

const base = { used: 0, limit: 3, resets_at: '2026-11-28T08:00:00.000Z', generation_enabled: true }

describe('VT-CR10: the indicator with a balance of stories', () => {
  it('says how many are left in all', () => {
    expect(quotaMessage({ ...base, credits: { balance: 3 } })).toBe('3 stories left')
    expect(quotaMessage({ ...base, used: 1, credits: { balance: 12 } })).toBe('12 stories left')
    expect(quotaMessage({ ...base, credits: { balance: 1 } })).toBe('1 story left')
  })

  it('says there are none at 0, without "today": no midnight refills it', () => {
    const empty = { ...base, credits: { balance: 0 } }
    expect(quotaMessage(empty)).toBe('No stories left')
    expect(outOfStories(empty)).toBe(true)
    // Even with the daily limit also reached, the empty balance is what matters.
    expect(quotaMessage({ ...empty, used: 3 })).toBe('No stories left')
  })

  it('still names the daily limit when that is what stops tonight', () => {
    const tonight = { ...base, used: 3, credits: { balance: 9 } }
    expect(quotaMessage(tonight)).toBe('No stories left today')
    expect(outOfStories(tonight)).toBe(false)
  })

  it('is unchanged with balances switched off', () => {
    expect(quotaMessage(base)).toBe('3 of 3 stories left today')
    expect(quotaMessage({ ...base, used: 1 })).toBe('2 of 3 stories left today')
    expect(quotaMessage({ ...base, used: 2 })).toBe('1 of 3 stories left today')
    expect(quotaMessage({ ...base, used: 3 })).toBe('No stories left today')
    expect(outOfStories({ ...base, used: 3 })).toBe(false)
  })

  it('the owner stays unlimited whatever the balance says', () => {
    const owner = { ...base, limit: 1_000_000, unlimited: true, credits: { balance: 0 } }
    expect(outOfStories(owner)).toBe(false)
    expect(quotaMessage(owner)).toMatch(/^Unlimited stories/)
  })
})

describe('issue #128: the contract additions', () => {
  it('QuotaResponse takes an optional balance and is unchanged without one', () => {
    expect(QuotaResponse.parse(base)).toEqual(base)
    expect(QuotaResponse.parse({ ...base, credits: { balance: 2 } }).credits).toEqual({ balance: 2 })
    expect(QuotaResponse.safeParse({ ...base, credits: { balance: -1 } }).success).toBe(false)
  })

  it('out_of_stories is an error code with a status, on the stream and before it', () => {
    expect(HTTP_STATUS_FOR_ERROR.out_of_stories).toBe(402)
    const event = SseEvent.parse({
      type: 'error',
      code: 'out_of_stories',
      message: parentMessage('out_of_stories'),
      quota_consumed: false,
    })
    expect(event.type).toBe('error')
    expect(ErrorBody.parse({ code: 'out_of_stories', message: 'x', quota_consumed: false }).resets_at).toBeNull()
  })

  it('the wording is the owner\'s, the same in both places it is kept', () => {
    expect(parentMessage('out_of_stories')).toBe("You've used your free stories. More are coming soon.")
    expect(LIMIT_MESSAGES.out_of_stories).toBe(parentMessage('out_of_stories'))
  })

  it('an empty balance is not answered with "try again"', () => {
    const body = { code: 'out_of_stories', message: parentMessage('out_of_stories'), quota_consumed: false, resets_at: null }
    expect(needsFreeRetryNote(body)).toBe(false)
    // The daily limit and a failure keep the note they had.
    expect(needsFreeRetryNote({ ...body, code: 'generation_failed', message: 'Please try again.' })).toBe(true)
  })

  it('the switch is off unless it says true', () => {
    const saved = process.env.STORY_CREDITS_ENABLED
    try {
      for (const [value, on] of [
        [undefined, false],
        ['', false],
        ['false', false],
        ['0', false],
        ['on', false],
        ['true', true],
        ['TRUE', true],
        ['1', true],
      ] as const) {
        if (value === undefined) delete process.env.STORY_CREDITS_ENABLED
        else process.env.STORY_CREDITS_ENABLED = value
        expect(storyCreditsEnabled(), String(value)).toBe(on)
      }
    } finally {
      if (saved === undefined) delete process.env.STORY_CREDITS_ENABLED
      else process.env.STORY_CREDITS_ENABLED = saved
    }
  })
})

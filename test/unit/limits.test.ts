import { afterEach, describe, expect, it } from 'vitest'
import {
  isValidTimeZone,
  nextLocalMidnight,
  nextResetAtIso,
  safeTimeZone,
  usageDateFor,
  zonedTimeToUtc,
} from '@/lib/limits/timezone'
import { dailyBudgetUsd, generationEnabled } from '@/lib/limits/switches'
import { DAILY_STORY_LIMIT, HTTP_STATUS_FOR_ERROR } from '@/lib/schemas/api'
import { LIMIT_MESSAGES } from '@/lib/limits/messages'

/**
 * F8 unit coverage for the day-boundary maths. The integration test asserts the same thing
 * against real `daily_usage` rows; this file pins the pure functions, including the two
 * cases that are easy to get wrong and impossible to notice in production: DST transitions
 * and a zone whose offset is not a whole hour.
 */

describe('F8 quota day boundary (family timezone)', () => {
  /** The VT, exactly: one UTC instant, two families, two different usage_dates. */
  it('Pacific/Auckland at 23:30 local and America/Los_Angeles get different usage_dates', () => {
    // 23:30 on 2026-03-10 in Auckland (UTC+13, NZDT) is 2026-03-10T10:30:00Z, which is
    // 03:30 on the SAME date in Los Angeles - so that instant alone does not prove
    // anything. An hour later the dates diverge, which is the case that matters:
    // 2026-03-10T11:30:00Z is 00:30 on the 11th in Auckland and 04:30 on the 10th in LA.
    const instant = new Date('2026-03-10T11:30:00Z')
    expect(usageDateFor('Pacific/Auckland', instant)).toBe('2026-03-11')
    expect(usageDateFor('America/Los_Angeles', instant)).toBe('2026-03-10')
    expect(usageDateFor('Pacific/Auckland', instant)).not.toBe(
      usageDateFor('America/Los_Angeles', instant),
    )
  })

  it('at 23:30 Auckland local the two families share a date but not a reset time', () => {
    // 2026-03-10T10:30:00Z = 23:30 on the 10th in Auckland, 03:30 on the 10th in LA.
    const instant = new Date('2026-03-10T10:30:00Z')
    expect(usageDateFor('Pacific/Auckland', instant)).toBe('2026-03-10')
    expect(usageDateFor('America/Los_Angeles', instant)).toBe('2026-03-10')

    // Auckland resets in 30 minutes; LA (already on PDT, UTC-7, since 2026-03-08) has
    // another 20.5 hours of the same local day.
    expect(nextResetAtIso('Pacific/Auckland', instant)).toBe('2026-03-10T11:00:00.000Z')
    expect(nextResetAtIso('America/Los_Angeles', instant)).toBe('2026-03-11T07:00:00.000Z')
  })

  it('uses the UTC date for a UTC family', () => {
    expect(usageDateFor('UTC', new Date('2026-06-01T23:59:59Z'))).toBe('2026-06-01')
    expect(usageDateFor('UTC', new Date('2026-06-02T00:00:00Z'))).toBe('2026-06-02')
  })

  it('handles a half-hour offset zone', () => {
    // Kolkata is UTC+5:30 all year.
    const instant = new Date('2026-06-01T18:45:00Z') // 00:15 on the 2nd in Kolkata
    expect(usageDateFor('Asia/Kolkata', instant)).toBe('2026-06-02')
    expect(nextResetAtIso('Asia/Kolkata', instant)).toBe('2026-06-02T18:30:00.000Z')
  })

  it('handles a 45-minute offset zone', () => {
    // Kathmandu is UTC+5:45.
    expect(usageDateFor('Asia/Kathmandu', new Date('2026-06-01T18:20:00Z'))).toBe('2026-06-02')
    expect(nextResetAtIso('Asia/Kathmandu', new Date('2026-06-01T18:20:00Z'))).toBe(
      '2026-06-02T18:15:00.000Z',
    )
  })

  /** The reset instant must be the local midnight in effect AFTER the clocks change. */
  it('gets the reset right across a spring-forward boundary', () => {
    // US DST begins 2026-03-08. On the evening of the 7th (PST, UTC-8) the next local
    // midnight is 2026-03-08T08:00Z; the clock jump happens later that morning.
    const beforeJump = new Date('2026-03-07T20:00:00Z') // 12:00 on the 7th in LA
    expect(usageDateFor('America/Los_Angeles', beforeJump)).toBe('2026-03-07')
    expect(nextResetAtIso('America/Los_Angeles', beforeJump)).toBe('2026-03-08T08:00:00.000Z')

    // On the 8th itself LA is PDT (UTC-7), so the next midnight is 07:00Z on the 9th.
    const afterJump = new Date('2026-03-08T20:00:00Z')
    expect(usageDateFor('America/Los_Angeles', afterJump)).toBe('2026-03-08')
    expect(nextResetAtIso('America/Los_Angeles', afterJump)).toBe('2026-03-09T07:00:00.000Z')
  })

  it('gets the reset right across a fall-back boundary', () => {
    // US DST ends 2026-11-01. Evening of 2026-10-31 is PDT (UTC-7): next midnight 07:00Z.
    expect(nextResetAtIso('America/Los_Angeles', new Date('2026-10-31T20:00:00Z'))).toBe(
      '2026-11-01T07:00:00.000Z',
    )
    // On 2026-11-01 LA is back to PST (UTC-8): next midnight 08:00Z on the 2nd.
    expect(nextResetAtIso('America/Los_Angeles', new Date('2026-11-01T20:00:00Z'))).toBe(
      '2026-11-02T08:00:00.000Z',
    )
  })

  it('rolls the month and the year over', () => {
    expect(nextResetAtIso('UTC', new Date('2026-01-31T12:00:00Z'))).toBe('2026-02-01T00:00:00.000Z')
    expect(nextResetAtIso('UTC', new Date('2026-12-31T12:00:00Z'))).toBe('2027-01-01T00:00:00.000Z')
    // 2028 is a leap year.
    expect(nextResetAtIso('UTC', new Date('2028-02-28T12:00:00Z'))).toBe('2028-02-29T00:00:00.000Z')
  })

  it('always returns a reset strictly in the future, and at most 24h out', () => {
    for (const tz of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles', 'Asia/Kathmandu', 'Europe/Dublin']) {
      for (const iso of ['2026-03-08T09:30:00Z', '2026-11-01T08:30:00Z', '2026-06-15T00:00:00Z']) {
        const at = new Date(iso)
        const reset = nextLocalMidnight(tz, at)
        expect(reset.getTime(), `${tz} @ ${iso}`).toBeGreaterThan(at.getTime())
        // A DST day can be 23 or 25 hours long, so allow up to 25h + a minute of slack.
        expect(reset.getTime() - at.getTime(), `${tz} @ ${iso}`).toBeLessThanOrEqual(25 * 3_600_000 + 60_000)
      }
    }
  })

  it('round-trips a local wall-clock time back to the same local date', () => {
    const utc = zonedTimeToUtc('Pacific/Auckland', 2026, 3, 11, 0, 0, 0)
    expect(usageDateFor('Pacific/Auckland', utc)).toBe('2026-03-11')
  })

  it('falls back to UTC on an unknown timezone rather than throwing', () => {
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false)
    expect(safeTimeZone('Mars/Olympus_Mons')).toBe('UTC')
    expect(safeTimeZone(null)).toBe('UTC')
    expect(usageDateFor('Mars/Olympus_Mons', new Date('2026-06-01T12:00:00Z'))).toBe('2026-06-01')
  })
})

describe('F8 kill switch and budget cap', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env.GENERATION_ENABLED = saved.GENERATION_ENABLED
    process.env.DAILY_BUDGET_USD = saved.DAILY_BUDGET_USD
    if (saved.GENERATION_ENABLED === undefined) delete process.env.GENERATION_ENABLED
    if (saved.DAILY_BUDGET_USD === undefined) delete process.env.DAILY_BUDGET_USD
  })

  /** "Takes effect without a deploy" means: read from the env on every call, never cached. */
  it('reads GENERATION_ENABLED fresh on every call', () => {
    delete process.env.GENERATION_ENABLED
    expect(generationEnabled()).toBe(true)
    process.env.GENERATION_ENABLED = 'false'
    expect(generationEnabled()).toBe(false)
    process.env.GENERATION_ENABLED = '0'
    expect(generationEnabled()).toBe(false)
    process.env.GENERATION_ENABLED = 'true'
    expect(generationEnabled()).toBe(true)
    process.env.GENERATION_ENABLED = '1'
    expect(generationEnabled()).toBe(true)
  })

  it('fails safe (generation on) on an unparseable GENERATION_ENABLED', () => {
    process.env.GENERATION_ENABLED = 'yes-please'
    expect(generationEnabled()).toBe(true)
  })

  it('reads DAILY_BUDGET_USD fresh on every call', () => {
    delete process.env.DAILY_BUDGET_USD
    expect(dailyBudgetUsd()).toBe(5)
    process.env.DAILY_BUDGET_USD = '0.01'
    expect(dailyBudgetUsd()).toBe(0.01)
    process.env.DAILY_BUDGET_USD = '250'
    expect(dailyBudgetUsd()).toBe(250)
  })

  it('falls back to the default on a nonsense or non-positive budget', () => {
    process.env.DAILY_BUDGET_USD = 'lots'
    expect(dailyBudgetUsd()).toBe(5)
    process.env.DAILY_BUDGET_USD = '-3'
    expect(dailyBudgetUsd()).toBe(5)
    process.env.DAILY_BUDGET_USD = '0'
    expect(dailyBudgetUsd()).toBe(5)
  })
})

describe('F8 refusal contract', () => {
  it('maps each limit code to the status the API contract promises', () => {
    expect(HTTP_STATUS_FOR_ERROR.quota_exceeded).toBe(429)
    expect(HTTP_STATUS_FOR_ERROR.service_paused).toBe(503)
    expect(HTTP_STATUS_FOR_ERROR.budget_exceeded).toBe(503)
  })

  it('has parent-facing copy for every limit code that never names a switch', () => {
    for (const [code, message] of Object.entries(LIMIT_MESSAGES)) {
      expect(message.length, code).toBeGreaterThan(10)
      expect(message, code).not.toMatch(/GENERATION_ENABLED|DAILY_BUDGET|quota|429|503|error/i)
    }
    expect(LIMIT_MESSAGES.budget_exceeded).toMatch(/paused for today/i)
  })

  it('keeps the daily limit at the documented 3', () => {
    // Changing this needs the owner's sign-off (kickoff "stop and ask").
    expect(DAILY_STORY_LIMIT).toBe(3)
  })
})

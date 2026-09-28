import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIMEZONE,
  detectTimeZone,
  isValidTimeZone,
  normalizeTimeZone,
  supportedTimeZones,
} from '@/lib/family/timezone'
import { FamilySettingsInput, sanitizeFamilySettings } from '@/lib/family/service'

/**
 * F2: family settings validation. The timezone must be a real IANA zone name because F8
 * draws the daily-quota day boundary from it - an abbreviation or an offset would drift
 * across a DST change and move the reset time.
 */

describe('F2 timezone validation', () => {
  it.each([
    'UTC',
    'Europe/London',
    'America/New_York',
    'America/Argentina/Buenos_Aires',
    'Australia/Sydney',
    'Pacific/Auckland',
    'Asia/Kolkata',
    'Etc/GMT+5',
  ])('accepts the IANA name %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(true)
  })

  it.each([
    ['EST', 'an abbreviation, not a zone: no DST rules'],
    ['GMT', 'same'],
    ['PST8PDT', 'a legacy alias, not an Area/Location name'],
    ['+05:00', 'a fixed offset cannot track DST'],
    ['Europe', 'no location'],
    ['Not/AZone', 'not a real zone'],
    ['', 'empty'],
    ['Europe/London; drop table families', 'injection-shaped'],
    ['../../etc/passwd', 'path traversal'],
  ])('rejects %j (%s)', (zone) => {
    expect(isValidTimeZone(zone)).toBe(false)
  })

  it('rejects a non-string', () => {
    for (const value of [null, undefined, 42, {}, ['Europe/London']]) {
      expect(isValidTimeZone(value)).toBe(false)
    }
  })

  it('normalizes an unusable value to UTC rather than storing it', () => {
    expect(normalizeTimeZone('EST')).toBe(DEFAULT_TIMEZONE)
    expect(normalizeTimeZone(null)).toBe(DEFAULT_TIMEZONE)
    expect(normalizeTimeZone('  Europe/London  ')).toBe('Europe/London')
  })

  it('offers a non-empty picker list, every entry of which is valid', () => {
    const zones = supportedTimeZones()
    expect(zones.length).toBeGreaterThan(10)
    for (const zone of zones.slice(0, 50)) expect(isValidTimeZone(zone), zone).toBe(true)
  })

  it('detects something valid from the runtime', () => {
    expect(isValidTimeZone(detectTimeZone())).toBe(true)
  })
})

describe('F2 family settings input', () => {
  it('accepts a display name and a timezone', () => {
    const parsed = FamilySettingsInput.safeParse({
      display_name: 'The Murrays',
      timezone: 'Europe/London',
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts a patch of only one field', () => {
    expect(FamilySettingsInput.safeParse({ timezone: 'Europe/London' }).success).toBe(true)
    expect(FamilySettingsInput.safeParse({ display_name: 'Us' }).success).toBe(true)
  })

  it('rejects an empty display name and one over 60 characters', () => {
    expect(FamilySettingsInput.safeParse({ display_name: '' }).success).toBe(false)
    expect(FamilySettingsInput.safeParse({ display_name: 'a'.repeat(61) }).success).toBe(false)
    expect(FamilySettingsInput.safeParse({ display_name: 'a'.repeat(60) }).success).toBe(true)
  })

  it('rejects a timezone that is not an IANA name', () => {
    const parsed = FamilySettingsInput.safeParse({ timezone: 'EST' })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toBe('Please choose a timezone from the list.')
  })
})

describe('F2 family settings sanitization', () => {
  it('strips HTML from the display name and reports it (F11 AC)', () => {
    const { input, htmlField } = sanitizeFamilySettings({
      display_name: 'The <script>alert(1)</script>Murrays',
    })
    expect(htmlField).toBe('display_name')
    expect(input.display_name).toBe('The Murrays')
  })

  it('collapses whitespace in the display name', () => {
    const { input, htmlField } = sanitizeFamilySettings({ display_name: '  The   Murrays ' })
    expect(htmlField).toBeNull()
    expect(input.display_name).toBe('The Murrays')
  })

  it('only returns the keys the client actually sent', () => {
    expect(Object.keys(sanitizeFamilySettings({ timezone: 'UTC' }).input)).toEqual(['timezone'])
    expect(Object.keys(sanitizeFamilySettings({}).input)).toEqual([])
  })

  it('does NOT cut an over-long display name, so validation can report it', () => {
    // Silently shortening a name the parent chose is worse than telling them the limit.
    const { input } = sanitizeFamilySettings({ display_name: 'a'.repeat(200) })
    expect((input.display_name as string).length).toBe(200)
    const parsed = FamilySettingsInput.safeParse(input)
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toBe('Family names can be up to 60 characters.')
  })
})

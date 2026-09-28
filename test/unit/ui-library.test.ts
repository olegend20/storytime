import { describe, expect, it } from 'vitest'
import { friendlyDate, groupBySeries } from '@/lib/client/library'
import { joinNames } from '@/lib/client/reader'
import { EVERGREEN_TOPICS, SUGGESTED_CHIP_COUNT, offsetForDay, suggestedChips } from '@/lib/client/topics'
import { LibraryStory, readMinutes } from '@/lib/client/types'
import fixtures from '@/lib/mock/fixture-stories.json'

const stories = fixtures.stories.map((s) => LibraryStory.parse(s))

describe('fixture integrity', () => {
  it('the committed fixtures parse as LibraryStory, which extends the real StoryRecord', () => {
    expect(stories.length).toBeGreaterThanOrEqual(3)
    for (const story of stories) {
      expect(story.content.chapters.length).toBeGreaterThanOrEqual(6)
      expect(story.content.chapters.length).toBeLessThanOrEqual(10)
      expect(story.content.true_facts.length).toBeGreaterThanOrEqual(8)
      expect(story.content.ending_line.length).toBeGreaterThan(0)
      expect(story.child_names.length).toBeGreaterThan(0)
    }
  })

  it('covers more than one series, so the library grouping is exercised', () => {
    expect(new Set(stories.map((s) => s.series_id)).size).toBeGreaterThan(1)
  })
})

describe('groupBySeries (F9: grouped by series, newest first)', () => {
  it('groups by series and sorts newest first inside each group', () => {
    const groups = groupBySeries(stories)
    expect(groups.length).toBe(new Set(stories.map((s) => s.series_id)).size)
    for (const group of groups) {
      const times = group.stories.map((s) => Date.parse(s.created_at))
      expect([...times].sort((a, b) => b - a)).toEqual(times)
    }
  })

  it('puts the series with the newest story first', () => {
    const groups = groupBySeries(stories)
    const newestOf = (g: (typeof groups)[number]) =>
      Math.max(...g.stories.map((s) => Date.parse(s.created_at)))
    const order = groups.map(newestOf)
    expect([...order].sort((a, b) => b - a)).toEqual(order)
  })

  it('returns nothing for an empty library rather than an empty group', () => {
    expect(groupBySeries([])).toEqual([])
  })

  it('tolerates an unparseable created_at instead of ordering by NaN', () => {
    const broken = [{ ...stories[0]!, created_at: 'not a date' }, stories[1]!]
    expect(groupBySeries(broken)).toHaveLength(2)
  })
})

describe('friendlyDate', () => {
  const now = new Date('2026-09-27T20:00:00Z')
  it('reads the way a tired parent scans', () => {
    expect(friendlyDate('2026-09-27T19:00:00Z', now)).toBe('Tonight')
    expect(friendlyDate('2026-09-26T19:00:00Z', now)).toBe('Yesterday')
    expect(friendlyDate('2026-09-24T19:00:00Z', now)).toBe('3 days ago')
    expect(friendlyDate('2026-08-01T19:00:00Z', now)).toMatch(/Aug/)
  })
  it('returns empty for junk rather than "Invalid Date"', () => {
    expect(friendlyDate('nonsense', now)).toBe('')
  })
})

describe('readMinutes', () => {
  it('estimates read-aloud time from the stored word count', () => {
    expect(readMinutes({ word_count: 1400 })).toBe(10)
    expect(readMinutes({ word_count: 0 })).toBe(1)
  })
})

describe('joinNames', () => {
  it('uses first names only (F11)', () => {
    expect(joinNames(['Cruz'])).toBe('Cruz')
    expect(joinNames(['Cruz', 'Phoenix'])).toBe('Cruz & Phoenix')
    expect(joinNames(['Cruz', 'Phoenix', 'Lennon'])).toBe('Cruz, Phoenix & Lennon')
    expect(joinNames([])).toBe('')
  })
})

describe('suggestedChips (F10: 8 rotating chips)', () => {
  it('always produces 8, even when the server has no fact packs yet', () => {
    expect(suggestedChips({})).toHaveLength(SUGGESTED_CHIP_COUNT)
    expect(suggestedChips({ fromServer: [] })).toHaveLength(SUGGESTED_CHIP_COUNT)
  })

  it('puts the server topics first, because a warm topic starts instantly', () => {
    const chips = suggestedChips({
      fromServer: [{ label: 'Sharks', topic_key: 'sharks', warm: true }],
    })
    expect(chips[0]).toEqual({ label: 'Sharks', topic_key: 'sharks', warm: true })
    expect(chips).toHaveLength(SUGGESTED_CHIP_COUNT)
  })

  it('never repeats a topic, even when the server sends one that is also evergreen', () => {
    const chips = suggestedChips({
      fromServer: [
        { label: 'The history of LEGO', topic_key: 'history-of-lego', warm: true },
        { label: 'Sharks', topic_key: 'sharks', warm: true },
      ],
    })
    expect(new Set(chips.map((c) => c.topic_key)).size).toBe(chips.length)
  })

  it('rotating changes the row', () => {
    const first = suggestedChips({ offset: 0 }).map((c) => c.topic_key)
    const second = suggestedChips({ offset: SUGGESTED_CHIP_COUNT }).map((c) => c.topic_key)
    expect(second).not.toEqual(first)
  })

  it('has enough evergreen ideas for rotation to mean something', () => {
    expect(EVERGREEN_TOPICS.length).toBeGreaterThan(SUGGESTED_CHIP_COUNT)
    expect(new Set(EVERGREEN_TOPICS.map((t) => t.topic_key)).size).toBe(EVERGREEN_TOPICS.length)
  })

  it('the day offset is stable within a day and moves between days', () => {
    expect(offsetForDay(new Date('2026-09-27T19:00:00Z'))).toBe(
      offsetForDay(new Date('2026-09-27T23:00:00Z')),
    )
    expect(offsetForDay(new Date('2026-09-28T19:00:00Z'))).not.toBe(
      offsetForDay(new Date('2026-09-27T19:00:00Z')),
    )
  })

  it('handles a negative offset without going out of bounds', () => {
    expect(suggestedChips({ offset: -3 })).toHaveLength(SUGGESTED_CHIP_COUNT)
  })
})

import type { LibraryStory } from './types'

/**
 * F9: "Library page (grouped by series, newest first)".
 *
 * A series is a group of children, not a topic (§3), so the grouping key is `series_id` and
 * the heading is the children's first names. Groups are ordered by their own newest story, so
 * the series the family used tonight is at the top.
 */
export interface SeriesGroup {
  series_id: string
  series_title: string
  child_names: string[]
  /** Newest first. */
  stories: LibraryStory[]
}

function newest(stories: readonly LibraryStory[]): number {
  return stories.reduce((max, s) => Math.max(max, Date.parse(s.created_at) || 0), 0)
}

export function groupBySeries(stories: readonly LibraryStory[]): SeriesGroup[] {
  const groups = new Map<string, SeriesGroup>()
  for (const story of stories) {
    let group = groups.get(story.series_id)
    if (!group) {
      group = {
        series_id: story.series_id,
        series_title: story.series_title,
        child_names: story.child_names,
        stories: [],
      }
      groups.set(story.series_id, group)
    }
    group.stories.push(story)
  }
  for (const group of groups.values()) {
    group.stories.sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))
  }
  return [...groups.values()].sort((a, b) => newest(b.stories) - newest(a.stories))
}

/** "Tonight" / "Yesterday" / "Sat 20 Sep" - a date a tired parent can scan. */
export function friendlyDate(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ''
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000)
  if (days <= 0) return 'Tonight'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  return then.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

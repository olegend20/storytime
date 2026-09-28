import { NewStoryFlow } from '@/components/newstory/NewStoryFlow'

export const metadata = { title: 'Tonight’s story · StoryTime' }

/**
 * F10's nightly form.
 *
 * NOTE (lane 1 / F2): assumes a logged-in family. The children list comes from
 * `GET /api/children`, which is family-scoped on the server; there is no client-side notion of
 * who the family is, so nothing here needs changing when auth lands.
 */
export default function Page() {
  return <NewStoryFlow />
}

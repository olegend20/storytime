import { NewStoryFlow } from '@/components/newstory/NewStoryFlow'

export const metadata = { title: 'Tonight’s book · StoryTime' }

/**
 * The creator, by its own address. `/` (signed in) and `/dashboard` mount the same flow.
 *
 * The children list comes from `GET /api/children`, which is family-scoped on the server; there
 * is no client-side notion of who the family is.
 */
export default function Page() {
  return <NewStoryFlow />
}

import { StoryPage } from '@/components/StoryPage'

export const metadata = { title: 'Story · StoryTime' }

/**
 * F9 reader. `params` is a promise in Next 16.
 *
 * NOTE (lane 1 / F2): this page assumes a logged-in family. `GET /api/stories/:id` is
 * family-scoped by RLS on the server, so the story a parent cannot see 404s there rather than
 * here. F11's VT "unauthenticated GET of a story URL redirects to login" needs lane 1's
 * middleware; nothing in this component fights it.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <StoryPage id={id} />
}

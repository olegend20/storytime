import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentFamily } from '@/lib/auth/session'
import { listChildren } from '@/lib/children/service'
import ChildrenManager, { type ChildView } from './ChildrenManager'

export const metadata: Metadata = { title: 'Children — StoryTime' }

/** F11 AC: every page that shows child data is behind auth. `middleware.ts` redirects
 * first; this second check means the page is safe even if the matcher ever changes. */
export default async function ChildrenPage() {
  const ctx = await currentFamily()
  if (!ctx) redirect('/login?next=/children')

  const children = await listChildren(ctx.db, ctx.family.id)
  const view: ChildView[] = children.map((c) => ({
    id: c.id,
    first_name: c.first_name,
    age: c.age,
    likes: c.likes ?? [],
    notes: c.notes,
    reading_level: c.reading_level,
  }))

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10">
      <p className="m-0 text-sm">
        <Link href="/dashboard" className="underline underline-offset-2 opacity-70 hover:opacity-100">
          Dashboard
        </Link>
      </p>
      <h1 className="mt-3 mb-1 text-2xl font-semibold tracking-tight">Children</h1>
      <p className="mt-0 mb-7 text-sm leading-relaxed opacity-70">
        First name, age and a few likes are all a story needs. Nothing here is shared with
        anyone.
      </p>
      <ChildrenManager initial={view} />
    </main>
  )
}

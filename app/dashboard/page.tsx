import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { NewStoryFlow } from '@/components/newstory/NewStoryFlow'
import { currentFamily } from '@/lib/auth/session'
import { creatorInitial } from '@/lib/newstory/initial'
import TimezoneSync from './TimezoneSync'

export const metadata: Metadata = { title: 'StoryTime' }

/**
 * F2: where a signed-in parent lands - on the creator itself (issue #17), with the family's
 * own details as a quiet strip underneath: its name, who is in it, and the way to Settings.
 */
export default async function DashboardPage() {
  const ctx = await currentFamily()
  if (!ctx) redirect('/login?next=/dashboard')

  const initial = await creatorInitial(ctx)
  // undefined means the read failed, which is not the same as having no children.
  const children = initial.children

  return (
    <>
      <TimezoneSync current={ctx.family.timezone} />
      <NewStoryFlow
        // Each piece is what its API route returns to this parent; nothing more crosses over.
        initial={initial}
        below={
          <section className="st-family" aria-labelledby="family-name">
            <h2 id="family-name">{ctx.family.display_name}</h2>
            {children ? (
              <p>
                {children.length === 0
                  ? 'No children yet.'
                  : `${children.length} ${children.length === 1 ? 'child' : 'children'} — ` +
                    children.map((child) => `${child.first_name}, ${child.age}`).join(' · ')}
              </p>
            ) : null}
            <span className="st-family-links">
              <Link href="/children" className="st-textlink">
                {children?.length === 0 ? 'Add a child' : 'Manage children'}
              </Link>
              <Link href="/settings" className="st-textlink">
                Settings
              </Link>
              <Link href="/privacy" className="st-textlink">
                What we store about your children
              </Link>
            </span>
          </section>
        }
      />
    </>
  )
}

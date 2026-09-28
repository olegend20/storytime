import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentFamily } from '@/lib/auth/session'
import { listChildren } from '@/lib/children/service'
import TimezoneSync from './TimezoneSync'

export const metadata: Metadata = { title: 'StoryTime' }

/**
 * F2: where a signed-in parent lands. The nightly story form is F10 (lane 4), so this is
 * deliberately a shell with the account plumbing in place and a marked slot for it.
 */
export default async function DashboardPage() {
  const ctx = await currentFamily()
  if (!ctx) redirect('/login?next=/dashboard')

  const children = await listChildren(ctx.db, ctx.family.id)

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10">
      <TimezoneSync current={ctx.family.timezone} />

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="m-0 text-2xl font-semibold tracking-tight">{ctx.family.display_name}</h1>
        <Link
          href="/settings"
          className="text-sm underline underline-offset-2 opacity-70 hover:opacity-100"
        >
          Settings
        </Link>
      </div>

      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="m-0 text-base font-semibold">
            {children.length === 0
              ? 'No children yet'
              : `${children.length} ${children.length === 1 ? 'child' : 'children'}`}
          </h2>
          <Link
            href="/children"
            className="text-sm underline underline-offset-2 opacity-70 hover:opacity-100"
          >
            {children.length === 0 ? 'Add a child' : 'Manage'}
          </Link>
        </div>
        {children.length > 0 ? (
          <ul className="mt-3 mb-0 flex list-none flex-wrap gap-2 p-0">
            {children.map((child) => (
              <li
                key={child.id}
                className="rounded-full border border-black/15 px-3 py-1 text-sm dark:border-white/20"
              >
                {child.first_name} <span className="opacity-60">· {child.age}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 mb-0 text-sm opacity-70">
            Add a child and tonight&apos;s story can be about them.
          </p>
        )}
      </section>

      <section className="mt-10 rounded-xl border border-dashed border-black/15 p-5 dark:border-white/20">
        <h2 className="mt-0 mb-1 text-base font-semibold">Tonight&apos;s story</h2>
        <p className="m-0 text-sm opacity-70">
          The new-story form arrives with F10, and the library with F9.
        </p>
      </section>

      <p className="mt-10 mb-0 text-xs opacity-55">
        <Link href="/privacy" className="underline underline-offset-2">
          What we store about your children
        </Link>
      </p>
    </main>
  )
}

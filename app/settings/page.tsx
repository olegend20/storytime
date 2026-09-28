import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentFamily } from '@/lib/auth/session'
import { supportedTimeZones } from '@/lib/family/timezone'
import FamilySettingsForm from './FamilySettingsForm'
import DeleteAccountForm from './DeleteAccountForm'

export const metadata: Metadata = { title: 'Settings — StoryTime' }

export default async function SettingsPage() {
  const ctx = await currentFamily()
  if (!ctx) redirect('/login?next=/settings')

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10">
      <p className="m-0 text-sm">
        <Link href="/dashboard" className="underline underline-offset-2 opacity-70 hover:opacity-100">
          Dashboard
        </Link>
      </p>
      <h1 className="mt-3 mb-7 text-2xl font-semibold tracking-tight">Settings</h1>

      <section className="mb-10">
        <FamilySettingsForm
          family={{ display_name: ctx.family.display_name, timezone: ctx.family.timezone }}
          timezones={supportedTimeZones()}
        />
      </section>

      <section className="mb-10">
        <h2 className="mb-2 text-base font-semibold">Signed in as</h2>
        <p className="mt-0 mb-3 text-[0.95rem]">{ctx.user.email}</p>
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="rounded-lg border border-black/15 px-4 py-2 text-sm font-medium dark:border-white/20"
          >
            Sign out
          </button>
        </form>
      </section>

      <section className="rounded-xl border border-red-700/25 p-5 dark:border-red-400/25">
        <h2 className="mt-0 mb-3 text-base font-semibold">Delete account</h2>
        <DeleteAccountForm />
      </section>
    </main>
  )
}

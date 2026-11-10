import type { Metadata } from 'next'
import Link from 'next/link'
import { requireOwner } from '@/lib/admin/gate'
import { supabaseService } from '@/lib/supabase/service'
import { listWaitlist } from '@/lib/waitlist/store'
import { waitlistEnabled } from '@/lib/waitlist/mode'
import { smtpInviteSender } from '@/lib/waitlist/invite'
import ApproveButton from './ApproveButton'

/**
 * Issue #92 - the owner's waitlist: who is waiting, and an Approve button for each. Approving
 * lets the address create an account and emails it "your place is ready" when mail is set up.
 * Non-owners get a 404, like /admin (F12).
 */

export const metadata: Metadata = { title: 'Waitlist — StoryTime ops', robots: { index: false, follow: false } }
export const dynamic = 'force-dynamic'
export const revalidate = 0

const when = (iso: string | null): string => (iso ? iso.replace('T', ' ').slice(0, 16) + 'Z' : '—')

function mailReady(): boolean {
  try {
    return smtpInviteSender() !== null
  } catch {
    return false
  }
}

export default async function WaitlistAdminPage() {
  await requireOwner()
  const rows = await listWaitlist(supabaseService())
  const waiting = rows.filter((r) => !r.approved_at)
  const approved = rows.filter((r) => r.approved_at)
  const mail = mailReady()

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Waitlist</h1>
        <Link href="/admin" className="text-xs underline opacity-70">
          ← StoryTime ops
        </Link>
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-black/10 p-3 text-xs dark:border-white/15">
        <span className="opacity-60">Read-only, env-controlled:</span>
        <span className="rounded border border-black/10 px-2 py-0.5 dark:border-white/15">
          WAITLIST_ENABLED = {String(waitlistEnabled())}
        </span>
        <span className="rounded border border-black/10 px-2 py-0.5 dark:border-white/15">
          invite email = {mail ? 'on' : 'off (SMTP or MAIL_FROM_EMAIL unset): tell people yourself'}
        </span>
      </div>

      <section className="mt-8" aria-labelledby="waiting-h">
        <h2 id="waiting-h" className="text-sm font-semibold uppercase tracking-wide opacity-70">
          Waiting ({waiting.length})
        </h2>
        {waiting.length === 0 ? (
          <p className="mt-3 text-sm opacity-60">Nobody is waiting.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide opacity-60">
                  <th className="py-2 pr-4 font-medium">Email</th>
                  <th className="py-2 pr-4 font-medium">Joined</th>
                  <th className="py-2 font-medium">
                    <span className="sr-only-text">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {waiting.map((r) => (
                  <tr key={r.email} className="border-t border-black/10 dark:border-white/15">
                    <td className="py-2 pr-4 break-all">{r.email}</td>
                    <td className="py-2 pr-4 whitespace-nowrap tabular-nums opacity-70">{when(r.created_at)}</td>
                    <td className="py-2 text-right">
                      <ApproveButton email={r.email} label="Approve" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-10" aria-labelledby="approved-h">
        <h2 id="approved-h" className="text-sm font-semibold uppercase tracking-wide opacity-70">
          Approved ({approved.length})
        </h2>
        {approved.length === 0 ? (
          <p className="mt-3 text-sm opacity-60">Nobody approved yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide opacity-60">
                  <th className="py-2 pr-4 font-medium">Email</th>
                  <th className="py-2 pr-4 font-medium">Approved</th>
                  <th className="py-2 font-medium">Invite email</th>
                </tr>
              </thead>
              <tbody>
                {approved.map((r) => (
                  <tr key={r.email} className="border-t border-black/10 dark:border-white/15">
                    <td className="py-2 pr-4 break-all">{r.email}</td>
                    <td className="py-2 pr-4 whitespace-nowrap tabular-nums opacity-70">{when(r.approved_at)}</td>
                    <td className="py-2">
                      {r.invited_at ? (
                        <span className="tabular-nums opacity-70">sent {when(r.invited_at)}</span>
                      ) : (
                        <ApproveButton email={r.email} label="Send invite email" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  )
}

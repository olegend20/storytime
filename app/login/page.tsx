import type { Metadata } from 'next'
import Link from 'next/link'
import LoginForm from './LoginForm'
import { normalizeEmail } from '@/lib/waitlist/email'
import { waitlistEnabled } from '@/lib/waitlist/mode'
import { safeNext } from '@/lib/auth/next'

export const metadata: Metadata = { title: 'Sign in — StoryTime' }

/** The page to return to, or '' for none: lib/auth/next's check, the one the callback uses. */
function nextParam(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw
  return value && safeNext(value) === value ? value : ''
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const rawError = params.error
  const initialError = typeof rawError === 'string' ? rawError : undefined
  const initialEmail = normalizeEmail(params.email) ?? ''
  const waitlist = waitlistEnabled()

  return (
    <main className="mx-auto w-full max-w-sm px-5 py-14">
      <h1 className="m-0 text-[2.1rem] leading-tight font-normal">Sign in to StoryTime</h1>
      <p className="mt-2 mb-7 text-[0.95rem] leading-relaxed text-muted">
        Enter your email and we will send you a link. No password needed.
      </p>
      <LoginForm
        next={nextParam(params.next)}
        initialError={initialError}
        initialEmail={initialEmail}
        waitlist={waitlist}
      />
      {waitlist ? (
        <p className="mt-6 mb-0 text-sm leading-relaxed text-muted">
          New here? We are opening places a few families at a time.{' '}
          <Link href="/#join" className="st-textlink" style={{ minHeight: 0, padding: 0 }}>
            Join the waitlist
          </Link>
          .
        </p>
      ) : null}
    </main>
  )
}

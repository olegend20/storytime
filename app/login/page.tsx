import type { Metadata } from 'next'
import LoginForm from './LoginForm'

export const metadata: Metadata = { title: 'Sign in — StoryTime' }

function safeNext(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value || !value.startsWith('/') || value.startsWith('//')) return ''
  return value
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const rawError = params.error
  const initialError = typeof rawError === 'string' ? rawError : undefined

  return (
    <main className="mx-auto w-full max-w-sm px-5 py-14">
      <h1 className="m-0 text-[2.1rem] leading-tight font-normal">Sign in to StoryTime</h1>
      <p className="mt-2 mb-7 text-[0.95rem] leading-relaxed text-muted">
        Enter your email and we will send you a link. No password needed.
      </p>
      <LoginForm next={safeNext(params.next)} initialError={initialError} />
    </main>
  )
}

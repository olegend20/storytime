import Link from 'next/link'

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const justDeleted = params.deleted === '1'

  return (
    <main className="mx-auto w-full max-w-xl px-5 py-12">
      <h1 className="m-0 mb-3 text-3xl font-semibold leading-tight tracking-tight">StoryTime</h1>
      <p className="m-0 text-[1.05rem] leading-relaxed opacity-85">
        A new bedtime story every night, about anything your kids want to learn — with your kids
        as the heroes, and the true facts at the end.
      </p>

      {justDeleted ? (
        <p
          role="status"
          className="mt-6 mb-0 rounded-xl border border-black/10 bg-black/[0.02] p-4 text-sm dark:border-white/15 dark:bg-white/[0.04]"
        >
          Your account and everything in it has been deleted. Thank you for trying StoryTime.
        </p>
      ) : null}

      <p className="mt-8 mb-0">
        <Link
          href="/login"
          className="inline-block rounded-lg bg-ink px-5 py-2.5 text-base font-medium text-paper dark:bg-paper dark:text-ink"
        >
          Sign in
        </Link>
      </p>

      <p className="mt-10 mb-0 text-sm leading-relaxed opacity-60">
        First names only, no photos, no advertising, and one click to delete everything —{' '}
        <Link href="/privacy" className="underline underline-offset-2">
          how we handle your family&apos;s data
        </Link>
        .
      </p>
    </main>
  )
}

import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Privacy — StoryTime',
  description: 'What StoryTime stores about your children, and how to delete all of it.',
}

/**
 * F11: the privacy page. The claims here are enforced elsewhere and each one is testable:
 *
 *  - "first names only"      -> `children` has no last_name/birthdate column (F11 VT,
 *                              test/int/schema.test.ts) and the field list is closed.
 *  - "behind your account"   -> every page showing child data is behind `proxy.ts`.
 *  - "one click to delete"   -> DELETE /api/account, verified by the F2 deletion VT.
 *  - "no third-party         -> there is no analytics script in `app/layout.tsx`.
 *     analytics"
 *
 * If any of those change, this page is wrong and must change with it.
 */
export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-12">
      <p className="m-0 text-sm">
        <Link href="/" className="underline underline-offset-2 opacity-70 hover:opacity-100">
          StoryTime
        </Link>
      </p>
      <h1 className="mt-3 mb-1 text-3xl font-semibold tracking-tight">Privacy</h1>
      <p className="mt-0 mb-8 text-sm opacity-60">Last updated 27 September 2026</p>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">The short version</h2>
        <ul className="m-0 list-disc space-y-1.5 pl-5 text-[0.95rem] leading-relaxed">
          <li>We store your child&apos;s first name only. Never a surname.</li>
          <li>We never ask for a date of birth, a photo, a school or an address.</li>
          <li>The account is yours, the parent&apos;s. Children do not have logins.</li>
          <li>One click deletes everything, for good, straight away.</li>
          <li>No advertising, no third-party analytics, no data sold or shared.</li>
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">What we store about a child</h2>
        <p className="mt-0 text-[0.95rem] leading-relaxed">
          Exactly five things, and there is no database column for anything else:
        </p>
        <ul className="m-0 list-disc space-y-1.5 pl-5 text-[0.95rem] leading-relaxed">
          <li>
            <strong>First name</strong> — so the story can be about them by name.
          </li>
          <li>
            <strong>Age</strong> — a whole number, to pitch the vocabulary and how much peril
            the story is allowed. Not a birthday.
          </li>
          <li>
            <strong>Up to ten likes</strong> — short tags such as “football”, “dinosaurs”.
          </li>
          <li>
            <strong>An optional note</strong> — up to 300 characters, whatever you think helps.
          </li>
          <li>
            <strong>An optional reading level</strong> — younger, typical or older than their age.
          </li>
        </ul>
        <p className="mb-0 text-[0.95rem] leading-relaxed">
          Please keep the note about the story, not about the child&apos;s life: it is the one
          free-text field, and we would rather it never held anything you would mind us having.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">What we store about you</h2>
        <p className="mt-0 mb-0 text-[0.95rem] leading-relaxed">
          Your email address, so you can sign in — there is no password to lose. A family name
          and a timezone, both of which you choose. And the stories we made for you, with what
          each one cost us to generate.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Who can see it</h2>
        <p className="mt-0 mb-0 text-[0.95rem] leading-relaxed">
          You. Every page and every API route that touches a child&apos;s details requires your
          session, and the database enforces the same rule a second time with row-level
          security, so one family&apos;s rows are not reachable from another family&apos;s
          account even if the application has a bug.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Where the text goes</h2>
        <p className="mt-0 mb-0 text-[0.95rem] leading-relaxed">
          To write a story we send Anthropic&apos;s Claude models the child&apos;s first name,
          age, likes, note and reading level, along with the topic you typed. We do not send your
          email address. We do not use your stories or your children&apos;s details to train any
          model.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Analytics</h2>
        <p className="mt-0 mb-0 text-[0.95rem] leading-relaxed">
          None of the usual kind. No Google Analytics, no advertising pixels, no session
          recording, no third-party script that could follow a child around the web. We count
          page views in aggregate and nothing else.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-semibold">Deleting everything</h2>
        <p className="mt-0 text-[0.95rem] leading-relaxed">
          Settings → <strong>Delete account</strong>. It is immediate and it is a real delete,
          not a flag: your children&apos;s profiles, your series, your story bibles and every
          story go in one transaction, and your sign-in is removed with them. There is no
          restore, so we ask you to type the word first.
        </p>
        <p className="mb-0 text-[0.95rem] leading-relaxed">
          We keep one thing: the accounting rows that record what each generation cost, with the
          family reference stripped to null. They carry no name, no topic and no story text —
          just a model, a token count and a price — and we need them to know what the service
          costs to run.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Children&apos;s privacy</h2>
        <p className="mt-0 mb-0 text-[0.95rem] leading-relaxed">
          StoryTime is for a parent to use with their children. The account belongs to the
          parent, children never sign in themselves, and we do not knowingly collect anything
          from a child directly.
        </p>
      </section>
    </main>
  )
}

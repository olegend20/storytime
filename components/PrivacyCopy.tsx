import Link from 'next/link'

/**
 * F11, the in-app copy: "first names only, no photos, parent-owned account, one-click delete".
 *
 * One module owns these four promises so the in-app note and the privacy page cannot drift apart
 * and end up promising different things. The server side of F11 - the sanitizer, the rate limiter
 * and the privacy page's route - is lane 1's; this is the wording.
 *
 * Each promise is something the code actually enforces, not a reassurance:
 *  - first names only: `ChildInput` in `lib/schemas/child.ts` is a closed five-field shape, and
 *    F11's VT asserts the `children` table has no `last_name` or `birthdate` column.
 *  - no photos: there is no upload anywhere in the product.
 *  - parent-owned: every family-scoped table is behind RLS on the family.
 *  - one-click delete: the delete button on any story, and account deletion in settings.
 */
export const PRIVACY_PROMISES: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'First names only',
    body:
      'We store a first name, an age, a few things they like, and an optional note. There is no ' +
      'field for a surname, a birthday, a school or an address — not hidden, not optional. It ' +
      'does not exist.',
  },
  {
    title: 'No photos, ever',
    body: 'There is nowhere to upload a picture of your child, because we never want one.',
  },
  {
    title: 'The account is yours',
    body:
      'Children have no logins. Only you can see your family’s stories, and nothing is shared ' +
      'with other families or made public.',
  },
  {
    title: 'Delete in one tap',
    body:
      'Any story can be deleted from the story itself. Deleting your account removes your ' +
      'children’s details and every story with it.',
  },
  {
    title: 'No tracking of your children',
    body:
      'No advertising trackers and no third-party analytics that profile children. We count page ' +
      'views and nothing else.',
  },
]

/** The compact version, shown on the nightly form. */
export function PrivacyNote({ className = '' }: { className?: string }) {
  return (
    <aside className={`card p-4 ${className}`} aria-labelledby="privacy-note-heading">
      <h2 id="privacy-note-heading" className="mt-0 mb-2 text-base font-semibold">
        What we store about your children
      </h2>
      <p className="mt-0 mb-2 text-sm" style={{ color: 'var(--fg-muted)' }}>
        First names only — no surnames, no birthdays, no photos. The account is yours, the stories
        are private to your family, and you can delete any story, or everything, in one tap.
      </p>
      <Link href="/privacy" className="text-sm" style={{ color: 'var(--accent)' }}>
        Read the privacy promise
      </Link>
    </aside>
  )
}

/** The full version, for the privacy page. */
export function PrivacyPromises() {
  return (
    <dl className="m-0">
      {PRIVACY_PROMISES.map((promise) => (
        <div key={promise.title} className="card mb-3 p-4">
          <dt className="m-0 text-base font-semibold">{promise.title}</dt>
          <dd className="mt-2 mb-0" style={{ color: 'var(--fg-muted)' }}>
            {promise.body}
          </dd>
        </div>
      ))}
    </dl>
  )
}

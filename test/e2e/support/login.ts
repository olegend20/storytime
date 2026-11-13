import { expect, type Page } from '@playwright/test'

/**
 * F2 e2e support: sign in through the real magic-link flow, reading the email out of the
 * local mailbox that `supabase start` runs.
 *
 * `supabase/config.toml` still calls that service `[inbucket]`, but current Supabase CLI
 * releases serve Mailpit on that port, so the helper probes for the Mailpit API and falls
 * back to the older Inbucket API. Either way no real email is ever sent.
 */

const MAILBOX_URL = process.env.SUPABASE_INBUCKET_URL ?? 'http://127.0.0.1:54324'
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321'

/** True when both the app's Supabase and the local mailbox are answering. */
export async function localAuthStackReachable(): Promise<boolean> {
  for (const url of [`${SUPABASE_URL}/auth/v1/health`, `${MAILBOX_URL}/`]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (!response.ok) return false
    } catch {
      return false
    }
  }
  return true
}

export const SKIP_REASON =
  'Needs the local Supabase auth stack and its mailbox. Run `supabase start`.'

export function uniqueEmail(label: string): string {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `lane1-e2e-${label}-${Date.now()}-${suffix}@storytime.test`
}

interface MailpitMessage {
  ID: string
}

/**
 * Fetch the body of the most recent message sent to `address`, polling until it lands. The
 * text part by default; `part: 'html'` for the designed email (issue #98).
 */
export async function fetchLatestEmailBody(
  address: string,
  timeoutMs = 20_000,
  part: 'text' | 'html' = 'text',
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no message arrived'

  while (Date.now() < deadline) {
    // Mailpit.
    try {
      const search = await fetch(
        `${MAILBOX_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
      )
      if (search.ok) {
        const found = (await search.json()) as { messages?: MailpitMessage[] }
        const id = found.messages?.[0]?.ID
        if (id) {
          const message = await fetch(`${MAILBOX_URL}/api/v1/message/${id}`)
          if (message.ok) {
            const detail = (await message.json()) as { Text?: string; HTML?: string }
            const body = part === 'html' ? detail.HTML : detail.Text || detail.HTML
            if (body) return body
          }
        }
      }
    } catch (cause) {
      lastError = String(cause)
    }

    // Inbucket, for an older CLI.
    try {
      const mailbox = address.split('@')[0]!
      const list = await fetch(`${MAILBOX_URL}/api/v1/mailbox/${encodeURIComponent(mailbox)}`)
      if (list.ok) {
        const messages = (await list.json()) as { id: string }[]
        const id = messages[messages.length - 1]?.id
        if (id) {
          const message = await fetch(
            `${MAILBOX_URL}/api/v1/mailbox/${encodeURIComponent(mailbox)}/${id}`,
          )
          if (message.ok) {
            const detail = (await message.json()) as { body?: { text?: string; html?: string } }
            const body = part === 'html' ? detail.body?.html : detail.body?.text || detail.body?.html
            if (body) return body
          }
        }
      }
    } catch (cause) {
      lastError = String(cause)
    }

    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`No sign-in email for ${address} after ${timeoutMs}ms (${lastError})`)
}

/**
 * The sign-in link in an email. Since issue #101 the template builds it on the site itself:
 * `<site_url>/auth/link?token_hash=...&type=magiclink|signup`, which hands on to Supabase.
 */
export function extractSignInLink(body: string): string {
  const match = body.match(/https?:\/\/[^\s"'<>)]*\/auth\/link\?token_hash=[^\s"'<>)]*/)
  if (!match) throw new Error(`No sign-in link in the email body:\n${body.slice(0, 500)}`)
  return match[0].replace(/&amp;/g, '&')
}

/**
 * The link on the server under test. The template's host is `site_url` - the dev server on
 * :3000 locally, lastten.org in production - while `pnpm test:e2e:real` runs on its own port.
 * Only the origin changes: the path, the token and its type are opened exactly as emailed,
 * and Supabase's redirect hop back to /auth/callback happens for real.
 */
export function onTestServer(link: string, baseURL: string): string {
  const url = new URL(link)
  const base = new URL(baseURL)
  url.protocol = base.protocol
  url.host = base.host
  return url.toString()
}

/**
 * The whole F2 login VT as one helper: request a link, read the mailbox, open it, land on
 * the dashboard.
 */
export async function signInWithMagicLink(
  page: Page,
  email: string,
  options: { approve?: boolean } = {},
): Promise<void> {
  // Issue #92: with the waitlist on, only an approved address can create an account. A test
  // signing in as a new parent is one the owner already let in; pass `approve: false` to
  // test the gate itself.
  if (options.approve !== false) await approveEmail(email)
  await page.goto('/login')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()

  const baseURL = new URL(page.url()).origin
  const link = extractSignInLink(await fetchLatestEmailBody(email))
  await page.goto(onTestServer(link, baseURL))
  await expect(page).toHaveURL(/\/dashboard$/)
}

/**
 * The standard `supabase start` demo service key (published in docs/LANE_BRIEF.md), used
 * only for cleanup and only when the runner's own environment has no real key - Playwright
 * does not load `.env.local`.
 */
const LOCAL_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

function cleanupKey(): string | null {
  const fromEnv = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (fromEnv && !fromEnv.startsWith('ci-') && !fromEnv.startsWith('test-')) return fromEnv
  if (SUPABASE_URL.includes('127.0.0.1') || SUPABASE_URL.includes('localhost')) {
    return LOCAL_SERVICE_KEY
  }
  return null
}

/**
 * Issue #92: put `email` on the waitlist, approved - what the owner does at /admin/waitlist.
 * Harmless with the waitlist off. Throws when it cannot, so a gate test never passes by
 * accident.
 */
export async function approveEmail(email: string): Promise<void> {
  const serviceKey = cleanupKey()
  if (!serviceKey) throw new Error('No service key to approve a test email with')
  const response = await fetch(`${SUPABASE_URL}/rest/v1/waitlist?on_conflict=email`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ email: email.toLowerCase(), approved_at: new Date().toISOString() }),
  })
  if (!response.ok) throw new Error(`approveEmail failed: ${response.status} ${await response.text()}`)
}

/** Remove the user this test created, and with it the family and everything under it. */
export async function deleteTestUser(email: string): Promise<void> {
  const serviceKey = cleanupKey()
  if (!serviceKey) return
  try {
    const list = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`,
      { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } },
    )
    if (!list.ok) return
    const found = (await list.json()) as { users?: { id: string; email: string }[] }
    for (const user of found.users ?? []) {
      if (user.email !== email) continue
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
        method: 'DELETE',
        headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
      })
    }
    await fetch(`${SUPABASE_URL}/rest/v1/waitlist?email=eq.${encodeURIComponent(email.toLowerCase())}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
    })
  } catch {
    /* best effort: a leftover test user is harmless, and never truncate a shared database */
  }
}

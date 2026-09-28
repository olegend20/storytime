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

/** Fetch the body of the most recent message sent to `address`, polling until it lands. */
async function fetchLatestEmailBody(address: string, timeoutMs = 20_000): Promise<string> {
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
            const body = detail.Text || detail.HTML
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
            const body = detail.body?.text || detail.body?.html
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

/** Pull the Supabase verify URL out of the email body. */
export function extractSignInLink(body: string): string {
  const match = body.match(/https?:\/\/[^\s"'<>)]*\/auth\/v1\/verify[^\s"'<>)]*/)
  if (!match) throw new Error(`No verify link in the email body:\n${body.slice(0, 500)}`)
  return match[0].replace(/&amp;/g, '&')
}

/**
 * Where the emailed link should be opened.
 *
 * GoTrue validates `redirect_to` against `site_url` + `additional_redirect_urls` in
 * `supabase/config.toml`, both of which name port 3000 only. On 3000 the link is followed
 * exactly as a parent would follow it, redirect hop included. On any other port GoTrue
 * would silently rewrite the destination back to 3000 - another lane's dev server - so the
 * emailed token is instead handed to our own `/auth/callback?token_hash=...&type=magiclink`,
 * which is the second branch that route already supports (it is what a custom email
 * template produces). That still exercises the real email, the real token verification,
 * the real family creation and the real session cookies; only GoTrue's redirect hop is
 * skipped.
 */
function signInTarget(link: string, baseURL: string): string {
  if (new URL(baseURL).port === '3000') return link
  const verify = new URL(link)
  const token = verify.searchParams.get('token')
  if (!token) throw new Error(`No token in the verify link: ${link}`)
  const callback = new URL('/auth/callback', baseURL)
  callback.searchParams.set('token_hash', token)
  callback.searchParams.set('type', verify.searchParams.get('type') ?? 'magiclink')
  return callback.toString()
}

/**
 * The whole F2 login VT as one helper: request a link, read the mailbox, open it, land on
 * the dashboard.
 */
export async function signInWithMagicLink(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()

  const baseURL = new URL(page.url()).origin
  const link = extractSignInLink(await fetchLatestEmailBody(email))
  await page.goto(signInTarget(link, baseURL))
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
  } catch {
    /* best effort: a leftover test user is harmless, and never truncate a shared database */
  }
}

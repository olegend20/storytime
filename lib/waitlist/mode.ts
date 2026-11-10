import { serverEnv } from '@/lib/env'

/**
 * Is lastten.org in waitlist mode (issue #92)? On unless `WAITLIST_ENABLED` is false.
 *
 * The coming-soon page must render even when the server env is incomplete (it is the one
 * page with nothing to configure - see `canSendToKindle` in app/page.tsx), so a failure to
 * parse the whole env falls back to reading this one variable, and an unreadable value
 * fails closed: still waitlist mode.
 */
export function waitlistEnabled(): boolean {
  try {
    return serverEnv().WAITLIST_ENABLED
  } catch {
    const raw = process.env.WAITLIST_ENABLED?.trim().toLowerCase()
    return !(raw === 'false' || raw === '0')
  }
}

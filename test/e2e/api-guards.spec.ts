import { expect, test } from '@playwright/test'

/**
 * F11 VTs that need a real HTTP server in front of `proxy.ts`:
 *
 *  - e2e: "unauthenticated GET of a story URL -> redirect to login."
 *  - "30 requests/min from one IP -> 429 from the rate limiter." The plan files this one
 *    under `int`, but the limiter runs in the Next proxy (middleware), which Vitest cannot invoke
 *    in process. Asserting it here proves more, not less: a real request, through the real
 *    middleware, on the built app.
 *
 * Both are independent of the database, so they run even without `supabase start`.
 */

/**
 * A bucket of its own for each rate-limit test run. The two Playwright projects (desktop
 * and mobile) run the same spec in parallel against one server, and the limiter is keyed on
 * the client IP, so a shared value would make each project eat the other's allowance.
 */
function freshBucketIp(): string {
  const octet = () => 1 + Math.floor(Math.random() * 254)
  return `10.${octet()}.${octet()}.${octet()}`
}

test.describe('F11 API and page guards', () => {
  test('an unauthenticated GET of a story URL redirects to login', async ({ page }) => {
    // /stories/:id is lane 4's reader (F9). The guard is in `proxy.ts`, so the
    // redirect happens whether or not that page exists yet.
    await page.goto('/stories/11111111-2222-4333-8444-555555555555')
    await expect(page).toHaveURL(
      /\/login\?next=%2Fstories%2F11111111-2222-4333-8444-555555555555|\/login\?next=\/stories\//,
    )
    await expect(page.getByLabel('Email address')).toBeVisible()
  })

  test('an unauthenticated API call is 401 JSON, not a redirect', async ({ request }) => {
    const response = await request.get('/api/children', {
      headers: { 'x-forwarded-for': '198.51.100.20' },
    })
    expect(response.status()).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'unauthorized' })
  })

  test('the 31st request in a minute from one IP gets a 429', async ({ request }) => {
    const headers = { 'x-forwarded-for': freshBucketIp() }

    const statuses: number[] = []
    for (let i = 0; i < 31; i += 1) {
      const response = await request.get('/api/children', { headers })
      statuses.push(response.status())
    }

    // The limit is 30 per rolling minute: the first 30 are served (401, because the caller
    // is not signed in - the point is that the limiter let them through), the 31st is not.
    expect(statuses.slice(0, 30)).not.toContain(429)
    expect(statuses[30]).toBe(429)

    const refused = await request.get('/api/children', { headers })
    expect(refused.status()).toBe(429)
    expect(Number(refused.headers()['retry-after'])).toBeGreaterThan(0)
    const body = (await refused.json()) as { code: string; message: string }
    expect(body.code).toBe('rate_limited')
    expect(body.message).not.toMatch(/30|minute/i)

    // A different IP is unaffected.
    const other = await request.get('/api/children', {
      headers: { 'x-forwarded-for': '198.51.100.77' },
    })
    expect(other.status()).toBe(401)
  })

  test('the rate limiter runs before authentication, so a flood cannot reach the database', async ({
    request,
  }) => {
    const headers = { 'x-forwarded-for': freshBucketIp() }
    for (let i = 0; i < 30; i += 1) await request.get('/api/family', { headers })
    const refused = await request.get('/api/family', { headers })
    expect(refused.status()).toBe(429)
  })
})

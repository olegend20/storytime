import { expect, test } from '@playwright/test'
import { resetMock, startStory } from './helpers'

/**
 * F11 — the UI parts: the privacy copy, and "no third-party analytics that collect children's
 * data".
 *
 * The analytics rule is asserted rather than asserted-about: the test records every request the
 * browser makes and fails on any cross-origin one. A tracker added later - by anyone, in any
 * lane - fails here, which is the only way a promise like this stays true.
 */

test('no page makes a cross-origin request', async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? 'http://127.0.0.1:3000').origin
  const foreign: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (url.startsWith('data:') || url.startsWith('blob:')) return
    if (!url.startsWith(origin)) foreign.push(`${request.method()} ${url}`)
  })

  await page.goto('/')
  await resetMock(page)
  await page.goto('/privacy')
  await page.goto('/library')
  await page.getByRole('link', { name: /read/i }).first().click()
  await expect(page.getByRole('heading', { name: 'True facts from the story' })).toBeVisible()
  await page.goto('/new')
  await expect(page.getByRole('button', { name: 'Cruz 7' })).toBeVisible()
  await startStory(page, 'how bees make honey')
  await expect(page.getByRole('heading', { name: 'Saved to your library' })).toBeVisible({
    timeout: 30_000,
  })

  expect(foreign, `cross-origin requests: ${foreign.join(', ')}`).toEqual([])
})

test('the in-app privacy note states the four promises and links to the full page', async ({
  page,
}) => {
  await page.goto('/new')
  await resetMock(page)
  await page.reload()

  const note = page.getByRole('complementary', { name: /what we store about your children/i })
  await expect(note).toBeVisible()
  const text = (await note.innerText()).toLowerCase()
  expect(text).toContain('first names only')
  expect(text).toContain('no photos')
  expect(text).toContain('one tap')

  await note.getByRole('link', { name: /privacy promise/i }).click()
  await expect(page).toHaveURL(/\/privacy$/)
})

test('the privacy page names what is stored and what does not exist', async ({ page }) => {
  await page.goto('/privacy')
  await expect(page.getByRole('heading', { name: /our privacy promise/i })).toBeVisible()

  for (const promise of [
    'First names only',
    'No photos, ever',
    'The account is yours',
    'Delete in one tap',
    'No tracking of your children',
  ]) {
    await expect(page.getByText(promise, { exact: true })).toBeVisible()
  }

  const body = (await page.locator('main').innerText()).toLowerCase()
  // The closed field list from lib/schemas/child.ts, stated to the parent.
  expect(body).toContain('surname')
  expect(body).toContain('birthday')
  // And the refusal promise a parent most needs to know about.
  expect(body).toContain('does not use one of your three stories')
})

test('a story page shows first names only — never a surname field anywhere', async ({ page }) => {
  await page.goto('/library')
  await resetMock(page)
  await page.reload()
  await page.getByRole('link', { name: /read/i }).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  // There is no input anywhere in the reader, so there is nowhere to add a surname or a photo.
  expect(await page.locator('input[type="file"]').count()).toBe(0)
  expect(await page.locator('input:not([type="checkbox"])').count()).toBe(0)
})

test('the nightly form has no file input, on any page', async ({ page }) => {
  for (const path of ['/', '/new', '/library', '/privacy']) {
    await page.goto(path)
    expect(await page.locator('input[type="file"]').count(), path).toBe(0)
  }
})

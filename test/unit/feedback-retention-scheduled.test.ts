import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Owner decision 2026-11-22 (DECISIONS #225): a tester's name and email are deleted 90 days
 * after they send feedback, and /privacy says so. A purge nothing runs is not a retention
 * policy, so a migration must schedule it, at least daily, and keep the window at 90 days.
 */
const sql = () => {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
}

describe('feedback contact retention', () => {
  it('a migration schedules purge_feedback_contact() at least daily', () => {
    const schedule = sql().match(
      /cron\.schedule\(\s*'[^']+',\s*'([^']+)',\s*\$\$[^$]*purge_feedback_contact\(\)[^$]*\$\$/,
    )
    expect(schedule, 'no cron.schedule(...) calls purge_feedback_contact()').not.toBeNull()
    // Minute and hour fixed, the rest "*": runs every day.
    expect(schedule![1]).toMatch(/^\d+ \d+ \* \* \*$/)
  })

  it('the purge clears name and email after 90 days and nobody outside the server can call it', () => {
    const all = sql()
    expect(all).toMatch(/set name = null, email = null/)
    expect(all).toMatch(/interval '90 days'/)
    expect(all).toMatch(/revoke execute on function public\.purge_feedback_contact\(\) from public, anon, authenticated/)
  })

  it('the privacy page tells testers about the 90 days', () => {
    const page = readFileSync(join(process.cwd(), 'app', 'privacy', 'page.tsx'), 'utf8')
    expect(page).toMatch(/90 days/)
  })
})

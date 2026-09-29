import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * GUARDRAILS.md s1.5: refused raw text is kept for at most 24 hours, and /privacy promises it.
 * `purge_guardrail_raw_text()` existed for a day with nothing calling it, so the promise was
 * false. A function nobody schedules is not a retention policy: some migration must schedule it.
 */
describe('guardrail raw-text retention', () => {
  it('a migration schedules purge_guardrail_raw_text() at least hourly', () => {
    const dir = join(process.cwd(), 'supabase', 'migrations')
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n')
    const schedule = sql.match(
      /cron\.schedule\(\s*'[^']+',\s*'([^']+)',\s*\$\$[^$]*purge_guardrail_raw_text\(\)[^$]*\$\$/,
    )
    expect(schedule, 'no cron.schedule(...) calls purge_guardrail_raw_text()').not.toBeNull()
    // Minute field fixed, hour field "*": runs every hour.
    expect(schedule![1]).toMatch(/^\d+ \* \* \* \*$/)
  })
})

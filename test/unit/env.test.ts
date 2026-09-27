import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/lib/env'

const complete = {
  ANTHROPIC_API_KEY: 'sk-ant-x',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
}

/** F1 VT: env schema rejects each missing required var. */
describe('F1 env validation', () => {
  it('accepts a complete environment', () => {
    expect(parseEnv(complete).success).toBe(true)
  })

  for (const key of [
    'ANTHROPIC_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ] as const) {
    it(`rejects a missing ${key}`, () => {
      const { [key]: _omitted, ...rest } = complete
      const result = parseEnv(rest)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes(key))).toBe(true)
      }
    })
  }

  it('defaults the kill switch on and the budget cap to a finite number', () => {
    const parsed = parseEnv(complete)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.GENERATION_ENABLED).toBe(true)
      expect(parsed.data.DAILY_BUDGET_USD).toBeGreaterThan(0)
    }
  })

  it('reads GENERATION_ENABLED=false as a real boolean false', () => {
    const parsed = parseEnv({ ...complete, GENERATION_ENABLED: 'false' })
    expect(parsed.success && parsed.data.GENERATION_ENABLED).toBe(false)
  })

  it('rejects a non-URL SUPABASE_URL', () => {
    expect(parseEnv({ ...complete, SUPABASE_URL: 'not-a-url' }).success).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/lib/env'

const complete = {
  ANTHROPIC_API_KEY: 'sk-ant-x',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: 'header.payload.signature',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abc123',
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

  it.each([
    ['SUPABASE_ANON_KEY', 'local-anon-key'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'local-service-role-key'],
  ] as const)('rejects a placeholder %s (%s) that Supabase cannot use', (key, value) => {
    const result = parseEnv({ ...complete, [key]: value })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/supabase status/)
  })

  it.each(['a.b.c', 'sb_publishable_x', 'test-anon-key', 'ci-anon'])('accepts anon key %s', (value) => {
    expect(parseEnv({ ...complete, SUPABASE_ANON_KEY: value }).success).toBe(true)
  })

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

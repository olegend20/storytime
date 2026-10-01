import { describe, expect, it } from 'vitest'
import { smtpPooling } from '@/lib/kindle/send'

/** Send to Kindle on serverless (issue #11 follow-up): no connection pool where instances freeze. */
describe('smtpPooling', () => {
  it('pools on a long-running server', () => {
    expect(smtpPooling({})).toBe(true)
  })
  it.each([{ VERCEL: '1' }, { AWS_LAMBDA_FUNCTION_NAME: 'storytime' }])('does not pool on serverless %o', (env) => {
    expect(smtpPooling(env)).toBe(false)
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Things the first production deployment (issue #18) depended on, pinned so they cannot
 * quietly regress: a build with no git directory, and a streaming route that is allowed to
 * run long enough to write a story.
 */
describe('deployment configuration', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }

  it('the prepare script survives an install with no git directory (a Vercel build)', () => {
    // It only points git at the repo's hooks; where there is no repo it must not fail the install.
    expect(pkg.scripts.prepare).toContain('core.hooksPath .githooks')
    expect(pkg.scripts.prepare).toMatch(/\|\| true$/)
  })

  it('the generation route may run for the full five minutes a story can take', () => {
    const route = readFileSync('app/api/stories/generate/route.ts', 'utf8')
    expect(route).toMatch(/export const maxDuration = 300\b/)
  })

  it('no secret is exposed to the browser by name', () => {
    const env = readFileSync('.env.example', 'utf8')
    const exposed = [...env.matchAll(/^(NEXT_PUBLIC_[A-Z_]+)=/gm)].map((m) => m[1])
    for (const name of exposed) expect(name).not.toMatch(/SERVICE_ROLE|SECRET|ANTHROPIC|SMTP_PASS/)
  })
})

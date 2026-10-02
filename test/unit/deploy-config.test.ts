import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Things the first production deployment (issue #18) depended on, pinned so they cannot
 * quietly regress: a build with no git directory, and a streaming route that is allowed to
 * run long enough to write a story.
 */
function sourceFiles(paths: string[]): string[] {
  return paths.flatMap((path) => {
    if (!statSync(path).isDirectory()) return [path]
    return readdirSync(path).flatMap((name) => {
      const child = join(path, name)
      return statSync(child).isDirectory() ? sourceFiles([child]) : /\.(tsx?|mjs)$/.test(name) ? [child] : []
    })
  })
}

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

  it('no secret is exposed to the browser: every NEXT_PUBLIC_ name the code reads is a public one', () => {
    // NEXT_PUBLIC_ variables are inlined into the browser bundle. This reads the names the
    // code actually uses (and .env.example), not a list someone has to remember to update.
    const names = new Set<string>()
    for (const file of sourceFiles(['app', 'components', 'lib', 'proxy.ts', 'next.config.ts', '.env.example'])) {
      for (const match of readFileSync(file, 'utf8').matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) names.add(match[0])
    }
    expect([...names].sort()).toEqual([
      'NEXT_PUBLIC_API_MOCK',
      'NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'NEXT_PUBLIC_SUPABASE_URL',
    ])
    for (const name of names) expect(name).not.toMatch(/SERVICE_ROLE|SECRET|ANTHROPIC|SMTP|PASS/)
  })

  it('only main deploys: a pull request never gets a preview that would need production keys', () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { git: { deploymentEnabled: Record<string, boolean> } }
    const rules = vercel.git.deploymentEnabled
    expect(rules.main).toBe(true)
    // Vercel deploys a branch if any matching rule is true: every other rule must be false.
    expect(Object.entries(rules).filter(([branch, on]) => on && branch !== 'main')).toEqual([])
    // '*' does not cross a slash in minimatch, and our branches are feat/…, fix/…: '**' covers them.
    expect(rules['*']).toBe(false)
    expect(rules['**']).toBe(false)
  })
})

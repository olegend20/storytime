import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Next.js loads `instrumentation.ts` in a separate module graph from the route handlers.
 * The cost and guardrail sinks were module variables, so the boot hook installed Supabase
 * into ITS copy and every route kept writing to memory: the running app recorded no spend,
 * the daily budget cap never tripped, and no refusal was audited - while every test, which
 * installs and calls in one graph, stayed green.
 *
 * This loads each module twice (vi.resetModules gives a fresh copy) and requires the second
 * copy to see what the first one installed.
 */
afterEach(() => {
  vi.resetModules()
})

describe('boot-installed sinks are visible to every module copy', () => {
  it('the cost-log sink', async () => {
    const boot = await import('@/lib/ai/callModel')
    const marker = { write: async () => {} }
    boot.setDefaultLogSink(marker)

    vi.resetModules()
    const route = await import('@/lib/ai/callModel')
    expect(route).not.toBe(boot)
    expect(route.getDefaultLogSink()).toBe(marker)
  })

  it('the guardrail-event sink', async () => {
    const boot = await import('@/lib/guardrails/events')
    const seen: unknown[] = []
    boot.setGuardrailSink({ write: async (e) => void seen.push(e) })

    vi.resetModules()
    const route = await import('@/lib/guardrails/events')
    expect(route).not.toBe(boot)
    await route.logGuardrailEvent({ layer: 'L1', category: 'other', text: 'x' })
    expect(seen).toHaveLength(1)
  })
})

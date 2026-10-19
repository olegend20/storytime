import { describe, expect, it } from 'vitest'
import { loadMendBench, scoreMendBench } from '@/lib/eval/mend-bench'

/**
 * Issue #66: the mend bench as a regression floor. Every hard violation the safety review and
 * the scanner raised in the captured eval runs of 2026-10-13..17. Before #66 the ladder
 * placed 46 of 52 and a cut completed 32 of 39 stories; both of the 2026-10-17 eval's
 * discards were among the misses. The floor is what #66 reached - raise it, never lower it.
 */
describe('mend bench (issue #66)', () => {
  const result = scoreMendBench(loadMendBench())

  it('places every hard violation, and a cut would clear every story', () => {
    expect(result.cases).toBe(39)
    expect(result.unlocated).toEqual([])
    expect(result.located).toBe(result.violations)
    expect(result.cutComplete).toBe(result.cases)
    expect(result.scannerCleared).toBe(result.scannerCases)
  })

  it('cuts no more of the book than it did when the floor was set', () => {
    expect(result.charsCut).toBeLessThanOrEqual(6605)
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { OutputSafetyReview, QualityReview } from '@/lib/schemas'
import { goodFactPack, goodStory, request } from '../helpers/story'

/**
 * DECISIONS #201: the quality reviewer thinks (~10 s a review, p95 ~30 s on the review bench),
 * and the gate can run three times inside AFTER_WRITE_MS. Its two reviews are independent, so
 * they run together: the gate takes as long as the slower one, not the sum.
 */

const order: string[] = []
let releaseQuality: () => void = () => {}

vi.mock('@/lib/quality/review', async () => {
  const actual = await vi.importActual<typeof import('@/lib/quality/review')>('@/lib/quality/review')
  return {
    ...actual,
    reviewStoryQuality: async (): Promise<QualityReview> => {
      order.push('quality:start')
      await new Promise<void>((resolve) => {
        releaseQuality = resolve
      })
      order.push('quality:end')
      return { age_appropriate: true, scary_level: 0, kids_are_active_participants: true, facts_consistent_with_pack: true, tone_matches_request: true, reasons: [] }
    },
  }
})

const { runQualityGate } = await import('@/lib/quality/gate')

describe('#201: the gate runs the quality and safety reviews together', () => {
  it('starts the safety review before the quality review has answered, and uses both verdicts', async () => {
    const outcome = runQualityGate({
      story: goodStory(),
      request: request(),
      factPack: goodFactPack(),
      attempt: 1,
      safetyReviewer: {
        review: async (): Promise<OutputSafetyReview> => {
          order.push('safety:start')
          // The quality review is still waiting: release it only now.
          releaseQuality()
          return { safe: false, violations: [{ rule: 10, quote: 'patted the shark', severity: 'hard' }], scary_level: 0, positive_portrayal: true, ending_safe: true } as OutputSafetyReview
        },
      },
    })
    const result = await outcome
    expect(order).toEqual(['quality:start', 'safety:start', 'quality:end'])
    expect(result.result.review?.age_appropriate).toBe(true)
    expect(result.result.hard_violations.map((v) => v.rule)).toEqual([10])
  })
})

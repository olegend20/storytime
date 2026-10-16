import { afterEach, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bandRule,
  renderBandRubric,
  renderSuspenseScale,
  sentenceLengthFailure,
  sentenceStats,
  splitSentences,
} from '@/lib/bands'
import { loadPrompt, resetPromptCache } from '@/lib/prompts'
import { OUTPUT_REVIEW_PROMPT, promptSection } from '@/lib/guardrails/prompts'
import { MAX_SCARY_LEVEL, type AgeBand, type StoryOutput } from '@/lib/schemas'
import { loadReferenceCases } from '@/lib/eval/references'

/**
 * One rubric, three readers.
 *
 * The owner's first stories were each rewritten, and the rewrites failed too, because the
 * writer, the quality reviewer and the safety reviewer each had their own band rules and
 * the gate's code had a fourth. These tests fail the moment that can happen again.
 */

const firstRealStory = JSON.parse(
  readFileSync(join(process.cwd(), 'test/fixtures/stories/first-real-story-volcanoes.json'), 'utf8'),
) as StoryOutput
const prose = (s: { chapters: { text: string }[] }) => s.chapters.map((c) => c.text).join('\n\n')

afterEach(() => {
  delete process.env.PROMPT_PIN_MASTER
  resetPromptCache()
})

describe('the writer and both reviewers are given the same rubric', () => {
  const rubric = renderBandRubric()
  const scale = renderSuspenseScale()

  it('the writer has it, word for word', () => {
    expect(loadPrompt('master').body).toContain(rubric)
  })

  it('the quality reviewer has it, word for word', () => {
    expect(loadPrompt('quality-review').body).toContain(rubric)
  })

  it('the safety reviewer has the same suspense scale', () => {
    expect(rubric).toContain(scale)
    expect(promptSection(OUTPUT_REVIEW_PROMPT, 'System prompt')).toContain(scale)
  })

  it('states the limits the code enforces, not a copy of them', () => {
    for (const band of ['A', 'B', 'C', 'D'] as AgeBand[]) {
      expect(scale).toContain(`${band}: ${MAX_SCARY_LEVEL[band]}`)
    }
  })

  it('no prompt on disk carries a stale band limit or an unresolved placeholder', () => {
    const dir = join(process.cwd(), 'prompts')
    const ids = new Set(readdirSync(dir).map((f) => f.replace(/\.v\d+\.md$/, '')))
    for (const id of ids) {
      if (id.startsWith('guardrail.')) continue // loaded by lib/guardrails/prompts.ts, below
      const body = loadPrompt(id).body
      expect(body, id).not.toMatch(/\{\{[a-z_]+\}\}/)
      expect(body, id).not.toMatch(/A:\s*0\b/)
    }
    const safety = promptSection(OUTPUT_REVIEW_PROMPT, 'System prompt')
    expect(safety).not.toMatch(/\{\{[a-z_]+\}\}/)
    expect(safety).not.toMatch(/A:\s*0\b/)
  })
})

describe('the rubric covers what the first stories were failed for', () => {
  const master = () => loadPrompt('master').body
  const reviewer = () => loadPrompt('quality-review').body

  it('tells the writer the sentence numbers and that code measures them', () => {
    expect(master()).toMatch(/Average 7–8 words/)
    expect(master()).toMatch(/measured by code/)
  })

  it('tells the reviewer not to judge what code measured', () => {
    expect(reviewer()).toMatch(/Do \*\*not\*\* set it `false`[\s\S]*sentence length or story length/)
  })

  it('gives both the mixed-age rule, so a big-kid hook is not marked down', () => {
    expect(master()).toMatch(/Mixed ages/)
    expect(reviewer()).toMatch(/never a fault/)
    expect(reviewer()).toMatch(/an older child's hook/)
  })

  it('tells the writer the field limits the schema enforces', () => {
    for (const limit of ['`shout_line` 80', '`rule` 240', '`ending_summary` 400']) {
      expect(master()).toContain(limit)
    }
  })

  it('ends the writer prompt with a check against the gate', () => {
    expect(master()).toMatch(/## 10\. Before you answer/)
  })
})

describe('sentence length is measured, and calibrated on the reference stories', () => {
  it('splits dialogue, sound words and ellipses the way a reader would', () => {
    expect(
      splitSentences('"No way," whispered Milo. **WHOOOSH!** Then... nothing. "Is it real?" he said.'),
    ).toEqual(['"No way," whispered Milo.', 'WHOOOSH!', 'Then...', 'nothing.', '"Is it real?"', 'he said.'])
  })

  it('every reference story is inside its band with room to spare', () => {
    const cases = loadReferenceCases()
    expect(cases.length).toBe(4)
    for (const c of cases) {
      const band = c.entry.request.age_band
      const stats = sentenceStats(prose(c.story), band)
      expect(sentenceLengthFailure(stats, band), c.entry.file).toBeNull()
      expect(stats.meanWords, c.entry.file).toBeLessThan(bandRule(band).sentences.limit_mean_words * 0.85)
    }
  })

  it('the first real story is not: one sentence in ten runs over 20 words', () => {
    const stats = sentenceStats(prose(firstRealStory), 'A')
    expect(stats.longShare).toBeGreaterThan(0.1)
    expect(sentenceLengthFailure(stats, 'A')).toMatch(/10% of sentences over 20 words \(limit 8%\)/)
  })
})

describe('PROMPT_PIN_<ID> pins an older prompt version', () => {
  it('loads v1 when pinned, the newest otherwise', () => {
    expect(loadPrompt('master').version).toBe(5)
    process.env.PROMPT_PIN_MASTER = '1'
    expect(loadPrompt('master').version).toBe(1)
  })

  it('refuses a version that is not on disk', () => {
    process.env.PROMPT_PIN_MASTER = '9'
    expect(() => loadPrompt('master')).toThrow(/PROMPT_PIN_MASTER=9/)
  })
})

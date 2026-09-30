import { describe, expect, it } from 'vitest'
import {
  FIELD_MAX_LENGTH as GUARDRAIL_CAPS,
  GUARDED_FIELDS,
  sanitizeText,
} from '@/lib/guardrails/sanitize'
import { FIELD_MAX_LENGTH as REQUEST_CAPS, sanitize } from '@/lib/http/sanitize'

/**
 * Two sanitizers exist on purpose, at different layers (DECISIONS.md #88):
 *   lib/guardrails/sanitize.ts - the guardrail authority. Wired into L1, measured by the
 *     red-team corpus, and it REFUSES on what it had to remove.
 *   lib/http/sanitize.ts - request-layer hygiene for the CRUD endpoints. Has a
 *     `{ cap: false }` mode so the zod schema's own max() fires and the parent gets
 *     "that's a bit long" rather than a silently shortened value.
 *
 * The danger in having two is that they drift, and a field ends up with a different limit
 * depending on which door the text came through. These assertions make that impossible to
 * do quietly.
 */
describe('the two sanitizers agree on the s3.2 field caps', () => {
  it('cover the same fields, allowing for the likes/like key spelling', () => {
    const normalize = (k: string) => (k === 'like' ? 'likes' : k)
    const guardrail = new Set<string>(GUARDED_FIELDS)
    const request = new Set(Object.keys(REQUEST_CAPS).map(normalize))
    expect([...request].sort()).toEqual([...guardrail].sort())
  })

  it('use the same numeric cap for every field', () => {
    for (const [key, cap] of Object.entries(REQUEST_CAPS)) {
      const guardrailKey = (key === 'like' ? 'likes' : key) as (typeof GUARDED_FIELDS)[number]
      expect(GUARDRAIL_CAPS[guardrailKey], key).toBe(cap)
    }
  })

  it('match GUARDRAILS.md s3.2 exactly, so neither file is the only record of a limit', () => {
    expect(GUARDRAIL_CAPS.topic_input).toBe(200)
    expect(GUARDRAIL_CAPS.first_name).toBe(30)
    expect(GUARDRAIL_CAPS.likes).toBe(40)
    expect(GUARDRAIL_CAPS.notes).toBe(300)
    expect(GUARDRAIL_CAPS.title).toBe(60)
    expect(GUARDRAIL_CAPS.display_name).toBe(60)
  })
})

describe('both sanitizers strip the same classes of character', () => {
  const nasties: { label: string; input: string }[] = [
    { label: 'markup', input: 'sharks <script>alert(1)</script>' },
    { label: 'zero-width', input: 'sha\u200Brks' },
    { label: 'bidi override', input: 'sharks\u202E' },
    { label: 'control chars', input: 'sharks\u0007' },
  ]

  for (const { label, input } of nasties) {
    it(`both report removing ${label}`, () => {
      const g = sanitizeText(input, 'topic_input')
      const r = sanitize('topic_input', input)
      const gFlagged = g.removed.html || g.removed.zeroWidth || g.removed.bidi || g.removed.control
      // The two report shapes name things differently: the guardrail layer separates
      // `bidi` from `control`, the request layer folds both into `controlChars`. What must
      // hold is that each layer notices SOMETHING was removed - the flag names are private
      // to each module, the fact of removal is not.
      const rFlagged = r.removed.html || r.removed.zeroWidth || r.removed.controlChars
      expect(gFlagged, `guardrail layer missed ${label}`).toBe(true)
      expect(rFlagged, `request layer missed ${label}`).toBe(true)
    })
  }

  it('neither mangles ordinary text', () => {
    const clean = 'how bees make honey'
    expect(sanitizeText(clean, 'topic_input').text).toBe(clean)
    expect(sanitize('topic_input', clean).value).toBe(clean)
  })

  /**
   * The distinction that justifies two modules: the request layer can decline to truncate,
   * so an over-long value reaches zod and produces a real message. The guardrail layer
   * always caps, and reports `truncated` for L1 to refuse on.
   */
  /**
   * The property that matters is that the character is GONE and the removal is flagged.
   * The two layers categorise it differently - the guardrail layer has a dedicated `bidi`
   * flag, the request layer files it under `zeroWidth` - and that is fine: the flag names
   * are private to each module. Asserting the label instead of the behaviour would make
   * this test break on a harmless rename while missing a real regression.
   */
  it('both strip a bidi override and flag the removal', () => {
    const BIDI = String.fromCharCode(0x202e)
    const input = `sharks${BIDI}`

    const g = sanitizeText(input, 'topic_input')
    expect(g.text).not.toContain(BIDI)
    expect(g.removed.bidi).toBe(true)

    const r = sanitize('topic_input', input)
    expect(r.value).not.toContain(BIDI)
    expect(r.removed.zeroWidth || r.removed.controlChars).toBe(true)
  })

  it('only the request layer can clean without capping', () => {
    const tooLong = 'a'.repeat(250)
    expect(sanitizeText(tooLong, 'topic_input').text).toHaveLength(200)
    expect(sanitizeText(tooLong, 'topic_input').truncated).toBe(true)
    expect(sanitize('topic_input', tooLong, { cap: false }).value).toHaveLength(250)
    expect(sanitize('topic_input', tooLong).value).toHaveLength(200)
  })
})

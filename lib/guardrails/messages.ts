import messagesJson from '@/config/guardrails/messages.json'
import type { GuardrailCategory, InputClassification } from '@/lib/schemas/guardrail'
import { scanInput } from './blocklist'
import { matchInjection, matchPii } from './patterns'
import type { GuardedField } from './sanitize'

/**
 * Parent-facing copy - GUARDRAILS.md s5.
 * "Refusals must be short, kind and non-judgmental, and must not echo the offending text
 *  back... Never tell the parent which layer or which word triggered the refusal."
 */

export interface MessagesConfig {
  refuse: Record<string, string>
  too_mature_for_band: { default: string; with_child: string; fallback_alternative: string }
  profile: Record<string, string>
  input_invalid: Record<string, string>
  output_failure: string
  output_retry: string
}

export const messages = messagesJson as unknown as MessagesConfig

/** The only placeholders any template may contain. Asserted in the unit tests. */
export const ALLOWED_PLACEHOLDERS = ['age', 'child', 'alternative', 'reset_time'] as const
export type Placeholder = (typeof ALLOWED_PLACEHOLDERS)[number]

export function render(template: string, vars: Partial<Record<Placeholder, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = vars[key as Placeholder]
    return value === undefined ? whole : value
  })
}

export interface RefusalMessageInput {
  category: GuardrailCategory
  /** Which field failed. `likes`/`notes` get the "edit the profile" wording (s3.3). */
  field?: GuardedField | null
  /** Internal L1 reason, used only to pick the right invalid-input wording. */
  internalReason?: string | null
  youngestAge?: number
  youngestName?: string | null
  /** A suggested alternative angle, e.g. "how giant ships float". */
  alternative?: string | null
}

/**
 * The template a parent sees. Never includes the input, the term or the layer.
 * L1 and L2 both come through here so there is exactly one place that copy lives.
 */
export function refusalMessage(input: RefusalMessageInput): string {
  const { category, field, internalReason } = input

  if (category === 'too_mature_for_band') {
    const age = input.youngestAge === undefined ? 'younger' : String(input.youngestAge)
    const alternative = input.alternative ?? messages.too_mature_for_band.fallback_alternative
    const template = input.youngestName
      ? messages.too_mature_for_band.with_child
      : messages.too_mature_for_band.default
    return render(template, { age, alternative, child: input.youngestName ?? '' })
  }

  // Structural L1 failures: tell the parent what to change, not what tripped.
  if (internalReason) {
    if (internalReason.startsWith('length:')) return messages.input_invalid.too_long as string
    if (internalReason === 'topic_too_short') return messages.input_invalid.too_short as string
    if (internalReason === 'topic_no_letters' || internalReason.startsWith('empty:')) {
      return messages.input_invalid.empty as string
    }
    if (internalReason.startsWith('name_shape:')) {
      return (messages.profile[field ?? 'first_name'] ??
        messages.profile.first_name) as string
    }
    if (internalReason.startsWith('pii:')) {
      return messages.input_invalid.contains_contact_details as string
    }
    if (
      internalReason === 'markup_stripped' ||
      internalReason === 'zero_width_stripped' ||
      internalReason === 'bidi_stripped' ||
      internalReason === 'control_chars_stripped'
    ) {
      return messages.input_invalid.markup as string
    }
  }

  // s3.3: "Likes and notes are treated as data about the child; if they contain a refuse
  // category, refuse the whole request with a message asking the parent to edit the
  // child's profile."
  if (field === 'likes' || field === 'notes') {
    return messages.profile[field] as string
  }

  return (messages.refuse[category] ?? messages.refuse.default) as string
}

export function outputFailureMessage(): string {
  return messages.output_failure
}

/**
 * The classifier writes its own `parent_message`. It is model output, so it is checked
 * before a parent ever sees it: it must not echo the input, must not leak a blocklisted
 * term, must not carry an injected instruction, and must not reveal the machinery.
 * Anything suspect falls back to the template. s5 is a hard requirement, not a hope.
 */
const LEAK_PATTERNS: RegExp[] = [
  /\b(?:layer|L1|L2|L3|L4|blocklist|block list|classifier|guardrail|flagged|keyword|regex|prompt)\b/i,
  /\b(?:as an ai|language model|system prompt)\b/i,
]

export function isSafeParentMessage(candidate: string | null, rawInput: string): boolean {
  if (!candidate) return false
  const text = candidate.trim()
  if (text === '' || text.length > 400) return false
  for (const re of LEAK_PATTERNS) if (re.test(text)) return false
  if (scanInput(text) !== null) return false
  if (matchInjection(text) !== null) return false
  if (matchPii(text) !== null) return false
  return !echoesInput(text, rawInput)
}

/**
 * "Must not echo the offending text back": any run of 4+ consecutive words from the
 * parent's input appearing in the message counts as an echo. Shorter overlaps are
 * unavoidable in normal English ("a story about").
 */
export function echoesInput(candidate: string, rawInput: string): boolean {
  const norm = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
  const inputWords = norm(rawInput)
  if (inputWords.length < 4) return false
  const haystack = ` ${norm(candidate).join(' ')} `
  for (let i = 0; i + 4 <= inputWords.length; i += 1) {
    const gram = inputWords.slice(i, i + 4).join(' ')
    if (haystack.includes(` ${gram} `)) return true
  }
  return false
}

/**
 * Final parent-facing copy for an L2 decision: the classifier's own message when it is
 * safe and useful, the template otherwise.
 */
export function parentMessageFor(
  classification: InputClassification,
  context: { rawInput: string; youngestAge: number; youngestName?: string | null },
): string {
  const template = refusalMessage({
    category: classification.category,
    youngestAge: context.youngestAge,
    youngestName: context.youngestName ?? null,
    alternative: null,
  })
  if (isSafeParentMessage(classification.parent_message, context.rawInput)) {
    return classification.parent_message as string
  }
  return template
}

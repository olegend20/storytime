/**
 * L1 PII and prompt-injection patterns - GUARDRAILS.md s3.2, bullets 3 and 4.
 *
 * These are the semantic half of L1. `ChildInput`'s zod pattern governs the SHAPE of a
 * name; it deliberately accepts "ignore previous", which is shape-valid and letters-only.
 * Catching that is this file's job (see the boundary note in test/unit/schemas.test.ts).
 */

export interface PatternHit {
  id: string
  match: string
}

interface NamedPattern {
  id: string
  re: RegExp
}

/** Grouped thousands ("1,300,000") and decimals are masked before the phone scan. */
const NUMERIC_QUANTITY = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g

const PII_PATTERNS: NamedPattern[] = [
  { id: 'email', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/ },
  { id: 'card_number', re: /\b(?:\d[ -]?){15}\d\b/ },
  { id: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { id: 'ni_number', re: /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/ },
  { id: 'uk_postcode', re: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/ },
  { id: 'url', re: /\b(?:https?:\/\/|www\.)\S+/i },
  {
    id: 'bare_domain',
    re: /\b[\w-]{2,}\.(?:com|net|org|io|co\.uk|gov|edu|xyz|app|dev|info|biz|me|tv)\b/i,
  },
  {
    id: 'street_address',
    re: /\b\d{1,5}[a-z]?\s+[\p{L}'.-]+(?:\s+[\p{L}'.-]+)?\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|close|court|crescent|terrace|place|boulevard|blvd|way|gardens|grove|walk)\b/iu,
  },
  { id: 'lives_at', re: /\b(?:lives?|live|living|based)\s+at\s+(?:number\s+)?\d/i },
  // Last: the loosest pattern. 9+ digits, or an international / leading-zero trunk form.
  // Years, scores and grouped thousands (masked above) stay clear of it.
  { id: 'phone', re: /(?:\+\d[\d\s().-]{7,}\d)|(?:\b0\d[\d\s().-]{7,}\d)|(?:\b\d(?:[\s().-]?\d){8,}\b)/ },
]

export function matchPii(text: string): PatternHit | null {
  const masked = text.replace(NUMERIC_QUANTITY, (m) => '#'.repeat(m.length))
  for (const { id, re } of PII_PATTERNS) {
    const m = re.exec(masked)
    if (m) return { id, match: m[0] }
  }
  return null
}

/**
 * s3.2: "ignore previous", "system prompt", "you are now", "developer mode", role tags
 * like <system>, [INST], "###", markdown code fences, or more than 3 line breaks in a
 * topic. A parent typing a topic never needs any of these.
 *
 * Deliberately NOT included: bare "pretend to be" / "act as". "pretend to be a dinosaur"
 * is a perfectly good bedtime topic, and refusing it would cost more than it buys. Only
 * the model-directed forms are patterns here.
 */
const INJECTION_PATTERNS: NamedPattern[] = [
  { id: 'ignore_previous', re: /\bignore\s+(?:all\s+|the\s+|any\s+)?(?:previous|prior|above|earlier|preceding|former)\b/i },
  { id: 'ignore_rules', re: /\b(?:ignore|forget|drop|bypass|override|disregard)\s+(?:all\s+|the\s+|your\s+|any\s+|these\s+)?(?:rules?|instructions?|guidelines?|guardrails?|restrictions?|prompt|constraints?|safety|policy|policies|filters?)\b/i },
  { id: 'forget_everything', re: /\bforget\s+(?:everything|all)\b/i },
  { id: 'disregard_above', re: /\bdisregard\s+(?:everything|all|the)\s+(?:above|previous|prior|earlier)\b/i },
  { id: 'system_prompt', re: /\bsystem\s*prompt\b/i },
  { id: 'system_message', re: /\bsystem\s+(?:message|instructions?|role)\b/i },
  // Narrow on purpose: "tell me the rules of cricket" is a fine bedtime topic, so the
  // possessive/system qualifier is required rather than a bare "the".
  { id: 'reveal_prompt', re: /\b(?:reveal|show|print|output|repeat|reproduce|tell\s+me)\s+(?:me\s+)?(?:your|the\s+system|the\s+above|the\s+initial)\s+(?:system\s+)?(?:prompt|instructions?|rules?|guidelines?)\b/i },
  { id: 'you_are_now', re: /\byou\s+are\s+now\b/i },
  { id: 'you_must_now', re: /\b(?:you|the\s+(?:ai|model|assistant|system))\s+(?:must|will|should)\s+now\b/i },
  // "the new rules of football in 1863" is a real topic; an imperative "new rules:" is not.
  { id: 'new_instructions', re: /\bnew\s+(?:instructions?|system\s+prompt)\b|\bnew\s+rules?\s*:/i },
  { id: 'developer_mode', re: /\bdeveloper\s+mode\b/i },
  { id: 'jailbreak', re: /\b(?:jailbreak|jailbroken|do\s+anything\s+now|unfiltered\s+mode|god\s+mode)\b/i },
  { id: 'pretend_ai', re: /\b(?:pretend|act)\s+(?:that\s+)?(?:you(?:'re| are)?|to\s+be)\s+(?:an?\s+)?(?:ai|assistant|language\s+model|llm|developer|admin|dm|system|chatbot|unrestricted|uncensored)\b/i },
  { id: 'no_restrictions', re: /\b(?:without|no|remove)\s+(?:any\s+)?(?:restrictions?|filters?|limits?|censorship|safety\s+(?:rules?|checks?))\b/i },
  { id: 'role_tag', re: /<\/?\s*(?:system|user|assistant|human|instructions?|prompt|child_profile|topic|rules?)\s*>/i },
  { id: 'inst_tag', re: /\[\s*\/?\s*(?:INST|SYS|SYSTEM|INSTRUCTIONS?)\s*\]/i },
  { id: 'special_token', re: /<\|[^|]{0,40}\|>/ },
  { id: 'hash_header', re: /###/ },
  { id: 'code_fence', re: /```|~~~/ },
  { id: 'template_braces', re: /\{\{[^}]{0,60}\}\}/ },
  { id: 'begin_system', re: /\b(?:BEGIN|END)\s+(?:SYSTEM|PROMPT|INSTRUCTIONS?)\b/i },
  { id: 'instead_ignore', re: /\binstead,?\s+(?:ignore|forget|disregard|do\s+not\s+follow)\b/i },
  { id: 'do_not_follow', re: /\bdo\s+not\s+follow\s+(?:the|your|any)\b/i },
  { id: 'stop_being', re: /\bstop\s+being\s+(?:a|an|the)?\s*(?:children|kid|kids|safe|storyteller|assistant)/i },
  { id: 'answer_as', re: /\brespond\s+(?:only\s+)?(?:with|as)\s+(?:raw\s+)?(?:json|the\s+system|base64)\b/i },
  { id: 'prompt_injection_marker', re: /\bprompt\s+injection\b/i },
]

export function matchInjection(text: string): PatternHit | null {
  for (const { id, re } of INJECTION_PATTERNS) {
    const m = re.exec(text)
    if (m) return { id, match: m[0] }
  }
  return null
}

/** Exported for the unit tests, so a pattern can never be silently dropped. */
export const INJECTION_PATTERN_IDS = INJECTION_PATTERNS.map((p) => p.id)
export const PII_PATTERN_IDS = PII_PATTERNS.map((p) => p.id)

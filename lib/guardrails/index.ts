/**
 * F15 guardrails - the implementation of GUARDRAILS.md.
 *
 *   L1  sanitize.ts + blocklist.ts + patterns.ts + l1.ts   (free, deterministic)
 *   L2  classify.ts                                        (Haiku, structured)
 *   L3  prompt.ts                                          (data blocks + rule text)
 *   L4  output.ts + review.ts + gate.ts                    (deterministic then Haiku)
 *
 * input.ts is the entry point a route calls (L1 then L2); gate.ts is the entry point F7
 * calls. messages.ts owns every word a parent reads; events.ts owns the audit trail.
 */
export * from './sanitize'
export * from './blocklist'
export * from './patterns'
export * from './l1'
export * from './classify'
export * from './prompt'
export * from './prompts'
export * from './output'
export * from './review'
export * from './gate'
export * from './messages'
export * from './events'
export * from './input'

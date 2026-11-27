/**
 * Parent-facing copy for the F8 refusals and the empty balance (issue #128). Friendly, never
 * technical, never blaming the parent, and it never says which switch fired beyond what a parent needs to act on.
 *
 * Guardrail refusal copy lives in `config/guardrails/messages.json` (F15, lane 5). These
 * three are not guardrail refusals — they are capacity and cost limits — so they live here.
 * If lane 5's file grows a `service_paused` / `budget_exceeded` / `quota_exceeded` key, that
 * file wins and these become the fallback.
 */
export const LIMIT_MESSAGES = {
  quota_exceeded:
    "That's all three stories for today. New ones unlock at midnight — see you tomorrow night.",
  out_of_stories: "You've used your free stories. More are coming soon.",
  service_paused: 'Story time is paused just now. Please try again a little later.',
  budget_exceeded: 'Story time is paused for today. New stories will be ready tomorrow.',
} as const

export type LimitCode = keyof typeof LIMIT_MESSAGES

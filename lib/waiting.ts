import waitingJson from '@/config/waiting.json'
import { joinNames } from '@/lib/client/reader'

/**
 * The waiting screen's one question (issue #112). The copy is config so it can be reworded
 * without a code change; the children answer out loud, and nothing they say is typed or kept.
 */
const data = waitingJson as {
  thankful_question: string
  thankful_question_no_names: string
  grown_up: string
  grown_up_after_seconds: number
}

export const GROWN_UP_LINE = data.grown_up

/** How long the children have to answer before the grown-up is asked too. */
export const GROWN_UP_AFTER_MS = data.grown_up_after_seconds * 1000

export function thankfulQuestion(names: readonly string[]): string {
  const who = joinNames(names)
  return who ? data.thankful_question.replace('{names}', who) : data.thankful_question_no_names
}

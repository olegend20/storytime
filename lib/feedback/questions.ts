/**
 * The tester feedback form (issue: thank-you and feedback, 2026-11-20). One list of questions,
 * read by the page that shows them (app/feedback) and by the route that checks the answers
 * (lib/feedback/validate.ts), so the two can never disagree about what a valid answer is.
 *
 * Every question is optional; a submission needs at least one answer. Nothing here asks about
 * a child beyond what a parent chooses to write in their own words: no name, age or other
 * field about a child (CLAUDE.md rule 7).
 */

export interface Choice {
  value: string
  label: string
}

export interface ChoiceQuestion {
  kind: 'one' | 'many'
  key: 'enjoyment' | 'stories_read' | 'reading_on' | 'keep_using'
  label: string
  choices: readonly Choice[]
}

export interface TextQuestion {
  kind: 'text'
  key: 'loved' | 'confusing' | 'wish' | 'anything_else'
  label: string
  hint?: string
}

export type Question = ChoiceQuestion | TextQuestion

/** Longest answer to one written question. A long, kind paragraph fits; a pasted book does not. */
export const MAX_TEXT = 2000
/** Longest name. */
export const MAX_NAME = 80

export const QUESTIONS: readonly Question[] = [
  {
    kind: 'one',
    key: 'enjoyment',
    label: 'How has StoryTime gone for your family so far?',
    choices: [
      { value: 'loved', label: 'We love it' },
      { value: 'liked', label: 'We like it' },
      { value: 'mixed', label: 'Mixed so far' },
      { value: 'not_for_us', label: 'Not for us yet' },
    ],
  },
  {
    kind: 'one',
    key: 'stories_read',
    label: 'About how many stories have you read together?',
    choices: [
      { value: 'none', label: 'None yet' },
      { value: 'one', label: 'One' },
      { value: 'few', label: '2 to 5' },
      { value: 'many', label: '6 or more' },
    ],
  },
  {
    kind: 'text',
    key: 'loved',
    label: 'What did your child enjoy most?',
    hint: 'A favourite moment, a fact they repeated, anything at all.',
  },
  {
    kind: 'text',
    key: 'confusing',
    label: 'Was anything confusing, slow or not quite right?',
  },
  {
    kind: 'many',
    key: 'reading_on',
    label: 'How do you read the stories?',
    choices: [
      { value: 'phone', label: 'Phone' },
      { value: 'tablet', label: 'Tablet' },
      { value: 'computer', label: 'Computer' },
      { value: 'ereader', label: 'Kindle or other e-reader' },
      { value: 'printed', label: 'Printed out' },
      { value: 'other', label: 'Something else' },
    ],
  },
  {
    kind: 'text',
    key: 'wish',
    label: 'What would make StoryTime easier for your family to use?',
    hint: 'For example reading on an e-reader, bigger text, or any accessibility needs.',
  },
  {
    kind: 'one',
    key: 'keep_using',
    label: 'Would you keep using StoryTime at bedtime?',
    choices: [
      { value: 'most_nights', label: 'Yes, most nights' },
      { value: 'sometimes', label: 'Sometimes' },
      { value: 'probably_not', label: 'Probably not' },
      { value: 'not_sure', label: 'Not sure yet' },
    ],
  },
  {
    kind: 'text',
    key: 'anything_else',
    label: 'Anything else you would like to tell us?',
  },
] as const

/** The page's words around the questions. */
export const FEEDBACK_COPY = {
  eyebrow: 'Tester feedback',
  title: 'Thank you for reading with us',
  lead:
    'Whenever you are ready, tell us how StoryTime has gone. Answer as many or as few questions as you like. Every question is optional.',
  childNote: 'No need to share your child’s name or any other details about them.',
  nameLabel: 'Your name',
  emailLabel: 'Your email, if you would like a reply',
  send: 'Send feedback',
  sending: 'Sending…',
  doneTitle: 'Thank you',
  doneBody: 'Your feedback has reached us. It really does shape what we build next.',
  empty: 'Please answer at least one question before sending.',
  badEmail: 'That email address does not look right. You can also leave it empty.',
  error: 'We could not send that just now. Please try again in a moment.',
} as const

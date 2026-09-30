import { z } from 'zod'
import { ReadingLevel } from './common'

/**
 * Children's data is MINIMAL and the field list is closed.
 * Kickoff rule 7 / F11 AC: first name, age, likes, notes, reading level.
 * Never add birthdate, surname, photo or location. F11 VT asserts the DB has no
 * last_name / birthdate column.
 */

/** GUARDRAILS.md s3.2: letters, spaces, hyphens, apostrophes only (Unicode letters OK). */
export const CHILD_NAME_PATTERN = /^[\p{L}][\p{L}\s'’-]*$/u

export const ChildFirstName = z
  .string()
  .trim()
  .min(1, 'Please enter a first name.')
  .max(30, 'First names can be up to 30 characters.')
  .regex(CHILD_NAME_PATTERN, 'Please use letters only for a first name.')

export const ChildAge = z
  .number()
  .int()
  .min(1, 'Age must be between 1 and 17.')
  .max(17, 'Age must be between 1 and 17.')

export const ChildLike = z.string().trim().min(1).max(40)

export const ChildInput = z.object({
  first_name: ChildFirstName,
  age: ChildAge,
  likes: z.array(ChildLike).max(10, 'Up to 10 likes per child.').default([]),
  notes: z.string().trim().max(300, 'Notes can be up to 300 characters.').nullable().default(null),
  reading_level: ReadingLevel.nullable().default(null),
})
export type ChildInput = z.infer<typeof ChildInput>

export const Child = ChildInput.extend({
  id: z.string().uuid(),
  family_id: z.string().uuid(),
})
export type Child = z.infer<typeof Child>

/** F3: max 8 children per family. */
export const MAX_CHILDREN_PER_FAMILY = 8

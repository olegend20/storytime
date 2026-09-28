import type { z } from 'zod'
import { apiError } from './responses'

/**
 * Turn a zod failure into the one message the parent needs to read, plus the field they
 * should fix. Only the first issue is surfaced: a form that lists six complaints at once
 * reads as a telling-off.
 */
export function zodErrorResponse(error: z.ZodError): Response {
  const issue = error.issues[0]
  const field = issue?.path.length ? issue.path.map(String).join('.') : null
  const message = issue?.message ?? 'Please check the details and try again.'
  return apiError('invalid_request', message, { field })
}

/** The F11 AC rejection: "API rejects payloads with HTML/script content in text fields." */
export function htmlNotAllowedResponse(field: string): Response {
  return apiError(
    'html_not_allowed',
    'Please use plain text — that field cannot contain HTML or code.',
    { field },
  )
}

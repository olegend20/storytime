import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError, apiOk } from '@/lib/http/responses'
import { htmlNotAllowedResponse, zodErrorResponse } from '@/lib/http/validation'
import {
  FamilySettingsInput,
  sanitizeFamilySettings,
  updateFamily,
  type FamilyRow,
} from './service'

/** See the note in `lib/children/handlers.ts` for why the route bodies live here. */

export interface FamilyRequestContext {
  db: SupabaseClient
  family: FamilyRow
}

/** Only the fields a client has any business seeing. */
export function publicFamily(family: FamilyRow) {
  return { id: family.id, display_name: family.display_name, timezone: family.timezone }
}

export function handleGetFamily(ctx: FamilyRequestContext): Response {
  return apiOk({ family: publicFamily(ctx.family) })
}

export async function handleUpdateFamily(
  ctx: FamilyRequestContext,
  body: unknown,
): Promise<Response> {
  if (typeof body !== 'object' || body === null) {
    return apiError('invalid_request', 'We could not read that request.')
  }

  const { input, htmlField } = sanitizeFamilySettings(body)
  if (htmlField) return htmlNotAllowedResponse(htmlField)
  if (Object.keys(input).length === 0) {
    return apiError('invalid_request', 'There is nothing to update.')
  }

  const parsed = FamilySettingsInput.safeParse(input)
  if (!parsed.success) return zodErrorResponse(parsed.error)

  const family = await updateFamily(ctx.db, ctx.family.id, parsed.data)
  return apiOk({ family: publicFamily(family) })
}

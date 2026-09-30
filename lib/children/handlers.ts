import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { ChildInput } from '@/lib/schemas'
import { apiError, apiOk } from '@/lib/http/responses'
import { htmlNotAllowedResponse, zodErrorResponse } from '@/lib/http/validation'
import {
  ChildLimitError,
  ChildPatch,
  createChild,
  deleteChild,
  listChildren,
  sanitizeChildPayload,
  updateChild,
} from './service'

/**
 * The bodies of the /api/children route handlers, with the cookie plumbing lifted out.
 *
 * Route files do auth and then delegate here. An integration test can therefore drive the
 * real endpoint logic - sanitization, validation, the 8-child ceiling, the status codes and
 * the parent-facing copy - against a real database and a real authenticated client,
 * without having to forge `@supabase/ssr` session cookies inside Vitest. The cookie path
 * itself is covered by the Playwright suite.
 */

export interface ChildRequestContext {
  db: SupabaseClient
  familyId: string
}

const Uuid = z.string().uuid()

export async function handleListChildren(ctx: ChildRequestContext): Promise<Response> {
  const children = await listChildren(ctx.db, ctx.familyId)
  return apiOk({ children })
}

export async function handleCreateChild(
  ctx: ChildRequestContext,
  body: unknown,
): Promise<Response> {
  if (typeof body !== 'object' || body === null) {
    return apiError('invalid_request', 'We could not read that request.')
  }

  const { input, htmlField } = sanitizeChildPayload(body)
  if (htmlField) return htmlNotAllowedResponse(htmlField)

  const parsed = ChildInput.safeParse(input)
  if (!parsed.success) return zodErrorResponse(parsed.error)

  try {
    const child = await createChild(ctx.db, ctx.familyId, parsed.data)
    return apiOk({ child }, { status: 201 })
  } catch (cause) {
    if (cause instanceof ChildLimitError) {
      return apiError('child_limit_reached', cause.message, { field: 'children' })
    }
    throw cause
  }
}

export async function handleUpdateChild(
  ctx: ChildRequestContext,
  childId: string,
  body: unknown,
): Promise<Response> {
  if (!Uuid.safeParse(childId).success) {
    return apiError('not_found', 'We could not find that child.')
  }
  if (typeof body !== 'object' || body === null) {
    return apiError('invalid_request', 'We could not read that request.')
  }

  const { input, htmlField } = sanitizeChildPayload(body)
  if (htmlField) return htmlNotAllowedResponse(htmlField)

  const parsed = ChildPatch.safeParse(input)
  if (!parsed.success) return zodErrorResponse(parsed.error)

  const child = await updateChild(ctx.db, ctx.familyId, childId, parsed.data)
  if (!child) return apiError('not_found', 'We could not find that child.')
  return apiOk({ child })
}

export async function handleDeleteChild(
  ctx: ChildRequestContext,
  childId: string,
): Promise<Response> {
  if (!Uuid.safeParse(childId).success) {
    return apiError('not_found', 'We could not find that child.')
  }
  const result = await deleteChild(ctx.db, ctx.familyId, childId)
  if (!result) return apiError('not_found', 'We could not find that child.')
  return apiOk({ deleted: true, affected_series: result.affected_series })
}

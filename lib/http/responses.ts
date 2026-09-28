/**
 * JSON shape for the family-scoped REST endpoints (F2 account + settings, F3 children).
 *
 * `lib/schemas/api.ts` is the lead's contract for the generation stream and deliberately
 * only covers that route. These endpoints borrow its conventions - a stable `code` enum
 * plus parent-safe `message` copy - so a client can handle both with one error renderer.
 * Promote this to `lib/schemas/` if another lane needs it as a contract.
 */

export const API_ERROR_STATUS = {
  invalid_request: 400,
  html_not_allowed: 400,
  child_limit_reached: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  server_error: 500,
} as const

export type ApiErrorCode = keyof typeof API_ERROR_STATUS

export interface ApiErrorBody {
  code: ApiErrorCode
  /** Parent-facing. Never echoes the offending input (GUARDRAILS.md s5). */
  message: string
  /** The field the parent should fix, when there is exactly one. */
  field: string | null
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  options: { field?: string | null; headers?: Record<string, string> } = {},
): Response {
  const body: ApiErrorBody = { code, message, field: options.field ?? null }
  return Response.json(body, {
    status: API_ERROR_STATUS[code],
    headers: { 'cache-control': 'no-store', ...options.headers },
  })
}

export function apiOk<T>(data: T, init: { status?: number } = {}): Response {
  return Response.json(data, {
    status: init.status ?? 200,
    headers: { 'cache-control': 'no-store' },
  })
}

/** A body that is not valid JSON is a client bug, not a parent's mistake. */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

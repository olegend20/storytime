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
  /** Send to Kindle (issue #11): the parent has not saved a Kindle address yet. */
  no_kindle_address: 400,
  /** Send to Kindle is not set up on this server (no SMTP). */
  not_configured: 503,
  /** The email provider refused or timed out. Nothing was changed. */
  delivery_failed: 502,
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

/**
 * A redirect whose `Location` is a RELATIVE path.
 *
 * `NextResponse.redirect()` needs an absolute URL, and the only origin a route handler has
 * to hand is `request.nextUrl.origin` - which resolves to `http://localhost:<port>`
 * whatever host the request actually used. On 127.0.0.1 that sends the browser to a
 * different origin, and therefore a different cookie jar, so a session just written is
 * invisible on the very next request and the parent bounces back to /login. A relative
 * Location is resolved by the browser against the URL it asked for, which is always right.
 *
 * @param path must start with `/` and must not start with `//` (open redirect)
 */
export function redirectTo(path: string, init: { status?: number } = {}): Response {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(`redirectTo: refusing a non-relative destination: ${path}`)
  }
  return new Response(null, {
    status: init.status ?? 307,
    headers: { location: path, 'cache-control': 'no-store' },
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

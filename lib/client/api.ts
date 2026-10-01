import { QuotaResponse, SuggestedTopicsResponse } from '@/lib/schemas'
import { ChildrenResponse, LibraryResponse, StoryResponse } from './types'

/**
 * One place that decides where the UI's requests go.
 *
 * Lane 2 implements `/api/*` (`lib/schemas/api.ts`). Until that lands - and for every e2e
 * run, which must make zero model calls - the same paths are served by lane 4's mock under
 * `/api/mock/*`. `NEXT_PUBLIC_API_MOCK=1` switches the base path; nothing else in the UI
 * knows the difference, and the mock routes 404 unless `UI_MOCK_API=1` is also set on the
 * server.
 */
export const API_MOCK = process.env.NEXT_PUBLIC_API_MOCK === '1'

export function apiBase(): string {
  return API_MOCK ? '/api/mock' : '/api'
}

export function apiUrl(path: string): string {
  return `${apiBase()}${path}`
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(apiUrl(path), {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: signal ?? null,
  })
  if (!res.ok) throw new ApiError(res.status, path)
  return res.json()
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    /** The server's `code` and parent-facing `message`, when the body carried them. */
    readonly code: string | null = null,
    readonly serverMessage: string | null = null,
  ) {
    super(`${path} responded ${status}`)
    this.name = 'ApiError'
  }
}

/** Send to Kindle (issue #11). */
export interface KindleSendResponse {
  sent: { to: string; filename: string; sent_today: number }
}

export async function sendToKindle(id: string): Promise<KindleSendResponse> {
  const path = `/stories/${encodeURIComponent(id)}/kindle`
  const res = await fetch(apiUrl(path), { method: 'POST', headers: { accept: 'application/json' } })
  if (!res.ok) {
    let code: string | null = null
    let message: string | null = null
    try {
      const body = (await res.json()) as { code?: string; message?: string }
      code = body.code ?? null
      message = body.message ?? null
    } catch {
      /* no body */
    }
    throw new ApiError(res.status, path, code, message)
  }
  return (await res.json()) as KindleSendResponse
}

export async function fetchQuota(signal?: AbortSignal): Promise<QuotaResponse> {
  return QuotaResponse.parse(await getJson('/quota', signal))
}

export async function fetchSuggestedTopics(
  signal?: AbortSignal,
): Promise<SuggestedTopicsResponse> {
  return SuggestedTopicsResponse.parse(await getJson('/topics/suggested', signal))
}

export async function fetchChildren(signal?: AbortSignal): Promise<ChildrenResponse> {
  return ChildrenResponse.parse(await getJson('/children', signal))
}

export async function fetchLibrary(signal?: AbortSignal): Promise<LibraryResponse> {
  return LibraryResponse.parse(await getJson('/stories', signal))
}

export async function fetchStory(id: string, signal?: AbortSignal): Promise<StoryResponse> {
  return StoryResponse.parse(await getJson(`/stories/${encodeURIComponent(id)}`, signal))
}

export async function deleteStory(id: string): Promise<void> {
  const path = `/stories/${encodeURIComponent(id)}`
  const res = await fetch(apiUrl(path), { method: 'DELETE' })
  if (!res.ok) throw new ApiError(res.status, path)
}

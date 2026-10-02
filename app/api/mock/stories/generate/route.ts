import { GenerateStoryBody, HTTP_STATUS_FOR_ERROR, bandForAges } from '@/lib/schemas'
import { MOCK_CHILDREN } from '@/lib/mock/children'
import {
  PRE_STREAM_SCENARIOS,
  mockErrorBody,
  scenarioFor,
  type MockScenario,
} from '@/lib/mock/scenarios'
import { json, quotaLimit, resetsAt, streamSourceStory, withSession } from '@/lib/mock/store'
import { generationStream, sseHeaders } from '@/lib/mock/stream'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Mock `POST /api/stories/generate` (the real one is lane 2's).
 *
 * Reproduces both failure shapes from `lib/schemas/api.ts`, because the UI has to handle them
 * differently and both are in F10's AC list:
 *  - BEFORE the stream: a JSON body with a real status (400 / 422 / 429 / 503).
 *  - AFTER the stream opens: an `error` event on a 200.
 */

function delayFor(scenario: MockScenario): number {
  const configured = Number(process.env.UI_MOCK_STREAM_DELAY_MS)
  if (Number.isFinite(configured) && configured >= 0) return configured
  return scenario === 'slow' ? 40 : 6
}

export async function POST(req: Request): Promise<Response> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    raw = null
  }
  const parsed = GenerateStoryBody.safeParse(raw)

  return withSession(req, ({ state }) => {
    if (!parsed.success) {
      return json(mockErrorBody('invalid_request'), {
        status: HTTP_STATUS_FOR_ERROR.invalid_request,
      })
    }
    const body = parsed.data
    const scenario = scenarioFor(body.topic_input)

    const forced = PRE_STREAM_SCENARIOS[scenario]
    if (forced) {
      const resets = forced === 'quota_exceeded' ? resetsAt() : null
      return json(mockErrorBody(forced, resets), { status: HTTP_STATUS_FOR_ERROR[forced] ?? 500 })
    }
    if (!state.generationEnabled) {
      return json(mockErrorBody('service_paused'), {
        status: HTTP_STATUS_FOR_ERROR.service_paused,
      })
    }
    if (state.quotaUsed >= quotaLimit()) {
      return json(mockErrorBody('quota_exceeded', resetsAt()), {
        status: HTTP_STATUS_FOR_ERROR.quota_exceeded,
      })
    }

    // Past this point a writing-model call would have been made, so the counter moves. It is
    // the stand-in for a `generation_logs` row and what F9's "zero model calls" VT reads.
    state.modelCalls += 1

    const source = streamSourceStory(state.generated)
    state.generated += 1

    const ages = MOCK_CHILDREN.filter((c) => body.child_ids.includes(c.id)).map((c) => c.age)
    // §4.5: vocabulary and peril follow the YOUNGEST selected child.
    const band = ages.length > 0 ? bandForAges(ages) : source.age_band
    const names = MOCK_CHILDREN.filter((c) => body.child_ids.includes(c.id)).map(
      (c) => c.first_name,
    )

    const story = {
      ...source,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      topic_input: body.topic_input,
      topic_label: body.topic_input,
      tones: body.tones,
      length_minutes: body.length_minutes,
      age_band: band,
      word_count: source.word_count,
      child_names: names.length > 0 ? names : source.child_names,
      series_title: names.length > 0 ? names.join(' & ') : source.series_title,
      sequence: source.sequence,
      content_notice: scenario === 'borrowed_character' ? ('borrowed_character' as const) : null,
    }
    if (scenario !== 'midstream_failure') {
      state.quotaUsed += 1
      state.stories.set(story.id, story)
    }

    return new Response(
      // `generationEvents` derives `meta.target_words` from the story's band and length, so
      // the progress indicator tracks the request rather than the fixture it replays.
      generationStream(story, {
        scenario,
        delayMs: delayFor(scenario),
        quota: { used: state.quotaUsed, limit: quotaLimit() },
      }),
      { status: 200, headers: sseHeaders() },
    )
  })
}

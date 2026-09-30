import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseService } from '@/lib/supabase/service'
import { getDefaultLogSink, MeteredLogSink } from '@/lib/ai'
import {
  bandForChildren,
  getOrCreateSeries,
  loadBible,
  loadChildProfiles,
  writeBible,
} from '@/lib/bible'
import { findFactPack, getOrBuildFactPack } from '@/lib/topics'
import { targetWords, type GenerationRequest, type QualityResult } from '@/lib/schemas'
import {
  GuardrailsInputGuard,
  GuardrailsSafetyReviewer,
  runGeneration,
  SseChannel,
  UnmeteredQuotaService,
  type PreparedGeneration,
} from '@/lib/generate'
import type { GateSummary } from './caps'
import type { GenerateInput, PipelineStoryResult, StoryPipeline } from './pipeline'

/**
 * F13/F14: the live pipeline behind `pnpm eval` and `pnpm bakeoff` - the function
 * `lib/eval/pipeline.ts` loads. Lane 5 built the harness against this seam and lane 2 never
 * filled it, so both commands failed at the first scenario. It lives here, not in
 * `lib/generate`, because nothing in the request path may import the eval harness
 * (test/unit/judge-not-in-runtime.test.ts).
 *
 * Every story goes through the production `runGeneration`: the streamed write, the parse, the
 * F7 gate with lane 6's L4 review, at most one rewrite, the save, and the background bible
 * update. What differs from a parent's request, and why:
 *
 *   - **A throwaway family per story**, holding the scenario's children and its starting
 *     bible. Samples never see each other's bible updates, and cleanup is one cascade delete.
 *     `generation_logs` keeps its rows (`on delete set null`), so no spend is lost.
 *   - **`prepareGeneration` is not called; `PreparedGeneration` is built here**, as the F6
 *     integration test does. Normalization would re-derive the topic key from free text, and
 *     a different key means a different fact pack: an unplanned ~$1.85 research build, and a
 *     story written from facts the scenario did not pin. The input guard still runs, for its
 *     care notes (the titanic scenario is `allow_with_care`).
 *   - **No quota.** Operator runs have their own budget ceiling (`--budget`) and must not
 *     be blocked by, or count against, a family's daily limit.
 */
export function createEvalPipeline(db: SupabaseClient = supabaseService()): StoryPipeline {
  return {
    kind: 'live',
    describe: 'F6 runGeneration (write, F7 gate + L4 review, rewrite, save, bible update)',
    generate: (input) => generateOne(input, db),
  }
}

async function generateOne(input: GenerateInput, db: SupabaseClient): Promise<PipelineStoryResult> {
  const { scenario } = input
  const sink = new MeteredLogSink(input.sink ?? getDefaultLogSink())
  const family = await createEvalFamily(db, scenario.id)
  const started = Date.now()

  try {
    const childIds = await insertChildren(db, family.familyId, scenario.children)
    const children = await loadChildProfiles(family.familyId, childIds, db)
    const band = bandForChildren(children)
    const series = await getOrCreateSeries(family.familyId, childIds, db)
    let bible = await loadBible(series.id, { db, children, childIds })
    if (scenario.bible) bible = await writeBible(bible, scenario.bible, db)

    const guard = await new GuardrailsInputGuard().check({
      topicInput: scenario.topic_input,
      children,
      youngestAge: Math.min(...children.map((c) => c.age)),
      familyId: family.familyId,
      sink,
    })
    if (guard.decision === 'refuse') {
      throw new Error(
        `eval scenario ${scenario.id} was refused by the input guard (${guard.category}). ` +
          'Every scenario is an allowed topic, so this is a guardrail false positive to investigate.',
      )
    }

    const pack =
      (await findFactPack(scenario.topic_key, db)) ??
      (await getOrBuildFactPack(scenario.topic_key, scenario.topic_input, { db, sink })).record

    const request: GenerationRequest = {
      children: children.map((c) => ({
        name: c.first_name,
        age: c.age,
        likes: c.likes ?? [],
        notes: c.notes ?? null,
      })),
      age_band: band,
      tones: scenario.tones,
      length_minutes: scenario.length_minutes,
      target_words: targetWords({ band, minutes: scenario.length_minutes }),
      topic_label: pack.topic_label,
      topic_key: scenario.topic_key,
      avoid: bible.content.avoid,
      care_notes: guard.decision === 'allow_with_care' ? guard.care_notes : null,
      rewrite_reasons: [],
    }
    const prepared: PreparedGeneration = {
      familyId: family.familyId,
      storyId: randomUUID(),
      seriesId: series.id,
      children,
      band,
      request,
      factPack: pack,
      topicInput: scenario.topic_input,
      topicKey: scenario.topic_key,
      topicLabel: pack.topic_label,
      quota: await new UnmeteredQuotaService().preflight(),
      bibleVersion: bible.version,
    }

    const channel = new SseChannel()
    let firstChapterAt: number | null = null
    const drained = (async () => {
      for await (const event of channel.events()) {
        if (event.type === 'chapter_start' && firstChapterAt === null) firstChapterAt = Date.now()
      }
    })().catch(() => {})

    const result = await runGeneration(prepared, channel, {
      db,
      sink,
      quota: new UnmeteredQuotaService(),
      safetyReviewer: new GuardrailsSafetyReviewer(),
      writingModel: input.writingModel,
    })
    await drained
    // Part of the story's cost (§5: "normalize + write + quality + bible"), and it must finish
    // before the family is deleted underneath it.
    if (result.bibleUpdate) await result.bibleUpdate.catch(() => {})
    const totalMs = Date.now() - started

    if (!result.story) {
      throw new Error(
        `eval scenario ${scenario.id} (${input.writingModel}, sample ${input.sample}) produced no ` +
          `story: status ${result.status}. See the [generate] line above for the cause.`,
      )
    }

    return {
      story: result.story,
      factPack: pack.content,
      gate: gateSummary(result.quality),
      writingModel: input.writingModel,
      costUsd: sink.totalCostUsd,
      latency: {
        toFirstChapterMs: firstChapterAt === null ? null : firstChapterAt - started,
        totalMs,
      },
      attempts: result.writeCalls,
    }
  } finally {
    await deleteEvalFamily(db, family)
  }
}

function gateSummary(quality: QualityResult | null): GateSummary | null {
  if (!quality) return null
  return {
    outcome: quality.outcome,
    hard_violations: quality.hard_violations,
    failures: quality.failures,
    // F13 checks titanic at scary_level <= 1: take the stricter of the two reviewers.
    scary_level: Math.max(quality.review?.scary_level ?? 0, quality.safety?.scary_level ?? 0),
  }
}

interface EvalFamily {
  userId: string
  familyId: string
}

async function createEvalFamily(db: SupabaseClient, scenarioId: string): Promise<EvalFamily> {
  const { data: created, error: userErr } = await db.auth.admin.createUser({
    email: `eval-${randomUUID()}@storytime.test`,
    password: randomUUID(),
    email_confirm: true,
  })
  if (userErr || !created.user) throw new Error(`eval family: createUser failed: ${userErr?.message}`)

  const { data: family, error } = await db
    .from('families')
    .insert({ owner_user_id: created.user.id, display_name: `eval ${scenarioId}`, timezone: 'UTC' })
    .select('id')
    .single()
  if (error || !family) {
    await db.auth.admin.deleteUser(created.user.id)
    throw new Error(`eval family: insert failed: ${error?.message}`)
  }
  return { userId: created.user.id, familyId: family.id as string }
}

async function insertChildren(
  db: SupabaseClient,
  familyId: string,
  children: GenerateInput['scenario']['children'],
): Promise<string[]> {
  const { data, error } = await db
    .from('children')
    .insert(
      children.map((c) => ({
        family_id: familyId,
        first_name: c.name,
        age: c.age,
        likes: c.likes,
        notes: c.notes,
      })),
    )
    .select('id, first_name')
  if (error || !data) throw new Error(`eval family: children insert failed: ${error?.message}`)
  // Scenario order, not insert-return order: the series key and prompt depend on it.
  return children.map((c) => (data.find((r) => r.first_name === c.name)!.id as string))
}

async function deleteEvalFamily(db: SupabaseClient, family: EvalFamily): Promise<void> {
  // Cascades to children, series, bible and stories; generation_logs rows keep their cost.
  const { error } = await db.from('families').delete().eq('id', family.familyId)
  if (error) console.warn(`[eval] could not delete eval family ${family.familyId}: ${error.message}`)
  await db.auth.admin.deleteUser(family.userId).catch(() => {})
}

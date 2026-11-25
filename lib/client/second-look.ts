/**
 * What the reader says above a story that shipped `flagged` (`quality.outcome === 'flagged'`):
 * the gate's last rung cut a sentence, or the rewrite still missed a soft check (F7,
 * GUARDRAILS.md §4.1, DECISIONS #176-#178).
 *
 * A flagged story is a delivered book, so it uses one of the day's stories: `runGeneration()`
 * calls `consumeQuota()` for every saved story, ready or flagged (test/int/pipeline.test.ts,
 * VT-D3 and F7). This copy must not promise otherwise. It used to say "make another — it
 * won't use one of your stories", which the product never kept (test/unit/second-look-copy).
 */
export const SECOND_LOOK_COPY =
  'We had a second look at this one before showing it to you. If anything reads oddly, you can make another one, though it will use one of today’s stories.'

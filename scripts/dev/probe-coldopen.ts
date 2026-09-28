import { loadManifest, loadReferenceStory, asStoryOutput } from '@/lib/reference'
import { StoryOutput, countWords, targetWords, wordCountWithinTolerance } from '@/lib/schemas'
for (const st of loadManifest().stories) {
  const p = loadReferenceStory(st.file)
  const out = asStoryOutput(p)
  const ok = StoryOutput.safeParse(out)
  const target = targetWords({ band: st.request.age_band, minutes: st.request.length_minutes })
  console.log(
    `${st.file.slice(0, 34).padEnd(34)} sub="${(p.subtitle ?? 'NULL').slice(0, 26)}" ` +
      `cold=${String(countWords(p.coldOpen)).padStart(3)}w ch=${String(out.chapters.length).padStart(2)} ` +
      `words=${String(p.narrativeWordCount).padStart(4)}/${target.min}-${target.max}` +
      `${wordCountWithinTolerance(p.narrativeWordCount, target) ? '' : ' OUT!'} ` +
      `${ok.success ? 'VALID' : 'INVALID'}\n    ch1 -> "${(out.chapters[0]?.text ?? '').slice(0, 72).replace(/\n/g, ' ')}..."`,
  )
}

/** Ad-hoc: print the parsed shape of each reference story. `pnpm tsx scripts/dev/probe-references.ts` */
import { loadManifest, loadReferenceStory } from '@/lib/reference'

for (const st of loadManifest().stories) {
  const p = loadReferenceStory(st.file)
  console.log(
    `${st.file.padEnd(40)} band ${st.request.age_band}  sections ${String(p.chapters.length).padStart(2)}` +
      `  facts ${String(p.trueFacts.length).padStart(2)}  words ${String(p.narrativeWordCount).padStart(4)}` +
      `  ${String(p.endingStyle).padEnd(16)} "${p.endingLine}"`,
  )
}

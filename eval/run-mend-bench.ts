/**
 * The mend bench (issue #66): can the delivery ladder place every hard violation the gate
 * raised on real captured stories? Free, no model call.
 *
 *   pnpm mend-bench
 *
 * Prints the rates and every violation it could not place; writes
 * eval/results/mend-bench-<date>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadMendBench, scoreMendBench } from '@/lib/eval/mend-bench'

const result = scoreMendBench(loadMendBench())
const pct = (n: number, d: number) => `${n}/${d} (${d === 0 ? 0 : Math.round((100 * n) / d)}%)`

console.log(`mend bench: ${result.cases} stories, ${result.violations} hard violations`)
console.log(`  violations placed      ${pct(result.located, result.violations)}`)
console.log(`  stories fully placed   ${pct(result.fullyPlaced, result.cases)}`)
console.log(`  cut would complete     ${pct(result.cutComplete, result.cases)}`)
console.log(`  scanner hits cleared   ${pct(result.scannerCleared, result.scannerCases)}`)
console.log(`  characters cut         ${result.charsCut} (${Math.round(result.charsCut / Math.max(1, result.cutComplete))} per completed story)`)
for (const u of result.unlocated) console.log(`  not placed: ${u.id} rule ${u.rule}: ${u.quote.slice(0, 160)}`)

const dir = join(process.cwd(), 'eval', 'results')
mkdirSync(dir, { recursive: true })
const file = join(dir, `mend-bench-${new Date().toISOString().slice(0, 10)}.json`)
writeFileSync(file, JSON.stringify(result, null, 2) + '\n')
console.log(`wrote ${file}`)

/** What a single nightly story costs, per model call, from config/pricing.json. */
import { computeCost, modelForRole, pricing } from '@/lib/ai/pricing'

const helper = modelForRole('helper')
const writer = modelForRole('writer')
const judge = modelForRole('judge_primary')

type Row = { step: string; model: string; cost: number; runtime: boolean }
const rows: Row[] = [
  { step: 'L2 input classifier', model: helper, runtime: true,
    cost: computeCost({ model: helper, input: 900, output: 120 }) },
  { step: 'normalize topic', model: helper, runtime: true,
    cost: computeCost({ model: helper, input: 300, output: 50 }) },
  { step: 'write the story (warm cache)', model: writer, runtime: true,
    cost: computeCost({ model: writer, input: 1347, cacheRead: 4358, output: 5000 }) },
  { step: 'quality gate (F7)', model: helper, runtime: true,
    cost: computeCost({ model: helper, input: 6000, output: 200 }) },
  { step: 'L4 safety review', model: helper, runtime: true,
    cost: computeCost({ model: helper, input: 6000, output: 200 }) },
  { step: 'bible update (background)', model: helper, runtime: true,
    cost: computeCost({ model: helper, input: 7000, output: 600 }) },
  { step: 'JUDGE (eval only - NOT per story)', model: judge, runtime: false,
    cost: computeCost({ model: judge, input: 10000, output: 1500 }) },
]

const w = 34
console.log(`prices from config/pricing.json, updated ${pricing.updated_at}\n`)
console.log('PER STORY, every night:')
let runtime = 0
for (const r of rows.filter((r) => r.runtime)) {
  runtime += r.cost
  console.log(`  $${r.cost.toFixed(5)}  ${r.step.padEnd(w)} ${r.model}`)
}
console.log(`  ${'-'.repeat(58)}`)
console.log(`  $${runtime.toFixed(5)}  ${'TOTAL per story'.padEnd(w)}`)

const judgeRow = rows.find((r) => !r.runtime)!
console.log(`\nNOT in the per-story path:`)
console.log(`  $${judgeRow.cost.toFixed(5)}  ${judgeRow.step.padEnd(w)} ${judgeRow.model}`)
console.log(`\nIf the judge ran on every story it would add ${(judgeRow.cost / runtime * 100).toFixed(0)}% to the cost`)
console.log(`of every bedtime story: $${runtime.toFixed(4)} -> $${(runtime + judgeRow.cost).toFixed(4)}.`)
console.log(`\nAt 3 stories/night for 100 families: $${(runtime * 3 * 100).toFixed(2)}/night as built,`)
console.log(`$${((runtime + judgeRow.cost) * 3 * 100).toFixed(2)}/night if the judge ran per story.`)

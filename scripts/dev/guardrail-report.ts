/**
 * Prints the measured guardrail numbers. Deterministic layers only - no model calls, no
 * cost. Run with `pnpm guardrails:report`.
 */
import {
  loadInputCorpus,
  loadOutputCorpus,
  measureL1,
  measureOutput,
  pct,
} from '../../test/guardrails/measure'

const allow = loadInputCorpus('inputs_allow.json')
const care = loadInputCorpus('inputs_care.json')
const refuse = loadInputCorpus('inputs_refuse.json')
const outputs = loadOutputCorpus()

const allowReport = measureL1(allow)
const careReport = measureL1(care)
const refuseReport = measureL1(refuse)
const outputReport = measureOutput(outputs)

console.log('--- L1 (deterministic input) ---')
console.log(
  `allow set:  ${allow.length} entries, L1 false refusals ${allowReport.falseRefusals.length} (${pct(
    allowReport.falseRefusals.length,
    allow.length,
  )})`,
)
for (const f of allowReport.falseRefusals) {
  console.log(`  FALSE REFUSAL  ${JSON.stringify(f.entry.input)} -> ${f.internalReason}`)
}
console.log(
  `care set:   ${care.length} entries, L1 refusals ${careReport.refused} (should be 0 - these are L2 decisions)`,
)
for (const f of careReport.falseRefusals) {
  console.log(`  L1 REFUSED   ${JSON.stringify(f.entry.input)} -> ${f.internalReason}`)
}
console.log(
  `refuse set: ${refuse.length} entries, L1 caught ${refuseReport.refused} (${pct(
    refuseReport.refused,
    refuse.length,
  )}); of the ${refuseReport.l1Marked} marked layer:L1, caught ${refuseReport.l1MarkedCaught}`,
)
for (const m of refuseReport.l1MarkedMissed) {
  console.log(`  L1-MARKED MISS ${JSON.stringify(m.entry.input)}`)
}
console.log(
  `category agreement on L1 catches: ${pct(
    Math.round(refuseReport.categoryAgreement * 1000),
    1000,
  )}`,
)
for (const m of refuseReport.categoryMismatches) {
  console.log(
    `  CATEGORY  ${JSON.stringify(m.entry.input)} expected ${m.entry.expected_category}, got ${m.category}`,
  )
}

const notCaughtByL1 = refuse.filter((e) => e.layer !== 'L1')
console.log(
  `\nentries left to L2 by design: ${notCaughtByL1.length} (${pct(notCaughtByL1.length, refuse.length)} of the refuse set)`,
)

console.log('\n--- L4 deterministic (output) ---')
console.log(
  `breaching excerpts: ${outputReport.breaching}, caught with the right rule ${outputReport.breachingCaught} (${pct(
    outputReport.breachingCaught,
    outputReport.breaching,
  )})`,
)
for (const m of outputReport.missed) {
  console.log(`  MISS rule ${m.entry.expected_rule}: ${m.entry.excerpt.slice(0, 90)}`)
}
console.log(
  `clean excerpts: ${outputReport.clean}, false positives ${outputReport.cleanFalsePositives.length}`,
)
for (const f of outputReport.cleanFalsePositives) {
  console.log(`  FALSE POSITIVE rules ${f.hardRules.join(',')}: ${f.entry.excerpt.slice(0, 90)}`)
}
console.log(`breaching excerpts that also fired another rule: ${outputReport.overFiring.length}`)
for (const o of outputReport.overFiring) {
  console.log(
    `  EXTRA rule(s) ${o.extraRules.join(',')} on a rule-${o.entry.expected_rule} excerpt: ${o.entry.excerpt.slice(0, 70)}`,
  )
}
console.log('per rule:')
for (const rule of Object.keys(outputReport.perRule).map(Number).sort((a, b) => a - b)) {
  const row = outputReport.perRule[rule]
  if (row) console.log(`  rule ${String(rule).padStart(2)}: ${row.caught}/${row.total}`)
}

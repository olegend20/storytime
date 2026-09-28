/**
 * "Does the child actually DO something?" - the product's central promise, checked for
 * free before any model call (F6 AC: every selected child "has at least one action").
 *
 * This is a heuristic and it is deliberately a loose one: it exists to catch the story
 * where a child is pure audience, not to grade agency. The real judgement is the review
 * pass's `kids_are_active_participants`. Speech and thought verbs are excluded, so "said
 * Cruz" and "Phoenix wondered" never satisfy it - which is the whole point.
 *
 * The lexicon is validated against the four reference stories in the F7 tests: every child
 * in every reference must pass, or the lexicon is wrong.
 */

/** Verbs that count as doing something. Base and irregular past forms; -ed is inferred. */
const ACTION_VERBS = [
  'grab', 'grabbed', 'pull', 'pulled', 'push', 'pushed', 'press', 'pressed',
  'build', 'built', 'make', 'made', 'place', 'placed', 'put', 'throw', 'threw',
  'hit', 'kick', 'kicked', 'jump', 'jumped', 'run', 'ran', 'climb', 'climbed',
  'dive', 'dived', 'dove', 'swim', 'swam', 'fly', 'flew', 'pick', 'picked',
  'lift', 'lifted', 'carry', 'carried', 'hand', 'handed', 'hold', 'held',
  'open', 'opened', 'close', 'closed', 'turn', 'turned', 'twist', 'twisted',
  'flip', 'flipped', 'spin', 'spun', 'tap', 'tapped', 'knock', 'knocked',
  'catch', 'caught', 'drop', 'dropped', 'pour', 'poured', 'mix', 'mixed',
  'draw', 'drew', 'write', 'wrote', 'sketch', 'sketched', 'test', 'tested',
  'fix', 'fixed', 'solve', 'solved', 'figure', 'figured', 'work', 'worked',
  'help', 'helped', 'save', 'saved', 'rescue', 'rescued', 'find', 'found',
  'spot', 'spotted', 'notice', 'noticed', 'count', 'counted', 'measure', 'measured',
  'choose', 'chose', 'decide', 'decided', 'lead', 'led', 'show', 'showed',
  'point', 'pointed', 'reach', 'reached', 'step', 'stepped', 'walk', 'walked',
  'march', 'marched', 'sprint', 'sprinted', 'skid', 'skidded', 'dodge', 'dodged',
  'block', 'blocked', 'aim', 'aimed', 'score', 'scored', 'strike', 'struck',
  'volley', 'volleyed', 'trap', 'trapped', 'pass', 'passed', 'toss', 'tossed',
  'roll', 'rolled', 'stack', 'stacked', 'snap', 'snapped', 'click', 'clicked',
  'wiggle', 'wiggled', 'squeeze', 'squeezed', 'tug', 'tugged', 'scratch', 'scratched',
  'dig', 'dug', 'unwrap', 'unwrapped', 'kneel', 'knelt', 'stand', 'stood',
  'sit', 'sat', 'lean', 'leaned', 'check', 'checked', 'type', 'typed',
  'plug', 'plugged', 'switch', 'switched', 'race', 'raced', 'chase', 'chased',
  'use', 'used', 'try', 'tried', 'take', 'took', 'give', 'gave', 'bring', 'brought',
  'start', 'started', 'finish', 'finished', 'fill', 'filled', 'empty', 'emptied',
  'tie', 'tied', 'untie', 'untied', 'fold', 'folded', 'cut', 'cuts', 'paint', 'painted',
  'plant', 'planted', 'wave', 'waved', 'clap', 'clapped', 'stamp', 'stamped',
  'crawl', 'crawled', 'slide', 'slid', 'swing', 'swung', 'balance', 'balanced',
  'invent', 'invented', 'design', 'designed', 'repair', 'repaired', 'assemble',
  'connect', 'connected', 'attach', 'attached', 'sort', 'sorted', 'search', 'searched',
  'gather', 'gathered', 'collect', 'collected', 'deliver', 'delivered', 'set', 'sets',
] as const

const ACTION_SET = new Set<string>(ACTION_VERBS)

/** Regular -ed and -s forms of anything in the lexicon also count. */
function isActionVerb(word: string): boolean {
  const w = word.toLowerCase()
  if (ACTION_SET.has(w)) return true
  if (w.endsWith('ed') && ACTION_SET.has(w.slice(0, -2))) return true
  if (w.endsWith('ed') && ACTION_SET.has(`${w.slice(0, -2)}e`)) return true
  if (w.endsWith('s') && ACTION_SET.has(w.slice(0, -1))) return true
  if (w.endsWith('ing') && ACTION_SET.has(w.slice(0, -3))) return true
  if (w.endsWith('ing') && ACTION_SET.has(`${w.slice(0, -3)}e`)) return true
  return false
}

/** Rough sentence split. Abbreviations produce extra fragments, which is harmless here. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * True when at least one sentence has the child's name followed by an action verb.
 * "Cruz flipped a brick over" passes; "said Cruz" and "Cruz watched" do not.
 */
export function hasChildAction(text: string, name: string): boolean {
  const nameRe = new RegExp(`(?<![\\p{L}])${escapeRegExp(name)}(?![\\p{L}])`, 'iu')
  for (const sentence of splitSentences(text)) {
    const match = nameRe.exec(sentence)
    if (!match) continue
    const after = sentence.slice(match.index + match[0].length)
    for (const word of after.split(/[^\p{L}'’-]+/u)) {
      if (word !== '' && isActionVerb(word)) return true
    }
  }
  return false
}

export const ACTION_VERB_COUNT = ACTION_SET.size

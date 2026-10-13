import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import namesConfig from '@/config/child-names.json'
import { ChildFirstName, ChildInput } from '@/lib/schemas'
import { checkField } from '@/lib/guardrails/l1'
import { GENERATED_CHILD_NAMES, pickGeneratedName } from '@/lib/children/names'

/**
 * Issue #43: a parent may leave a child's name blank and we choose one from
 * config/child-names.json. The name is saved as the child's first name, so it must pass
 * every rule a typed name passes.
 */

describe('VT-A3 every generated name passes the rules a typed name must', () => {
  it.each(namesConfig.names)('%s passes ChildFirstName and L1 (name_shape, blocklist, injection)', (name) => {
    expect(ChildFirstName.safeParse(name).success).toBe(true)
    const l1 = checkField({ field: 'first_name', value: name })
    expect(l1.ok, `${name}: ${l1.internal_reason}`).toBe(true)
  })

  it('has no duplicates and enough names for a full family', () => {
    const lower = GENERATED_CHILD_NAMES.map((n) => n.toLowerCase())
    expect(new Set(lower).size).toBe(lower.length)
    expect(lower.length).toBeGreaterThanOrEqual(24)
  })

  // The quality gate finds a child's name case-insensitively (lib/quality/deterministic.ts), so
  // a name that is also an everyday word ("wren", "hazel") would let the story's own words
  // stand in for the child. /usr/share/dict/words lists everyday words in lower case and
  // proper names capitalised; skipped where the system has no word list.
  const wordList = existsSync('/usr/share/dict/words')
    ? new Set(readFileSync('/usr/share/dict/words', 'utf8').split('\n').filter((w) => w !== '' && w === w.toLowerCase()))
    : null
  it.skipIf(!wordList)('no name is an everyday English word', () => {
    expect(GENERATED_CHILD_NAMES.filter((n) => wordList!.has(n.toLowerCase()))).toEqual([])
  })

  it('avoids the fixture children, whose names the quality-gate tests rely on', () => {
    for (const fixture of ['milo', 'juno', 'theo']) {
      expect(GENERATED_CHILD_NAMES.map((n) => n.toLowerCase())).not.toContain(fixture)
    }
  })
})

describe('VT-A2 pickGeneratedName', () => {
  it('returns a name from the list', () => {
    expect(GENERATED_CHILD_NAMES).toContain(pickGeneratedName([]))
  })

  it('never returns a sibling’s name, whatever the case', () => {
    const siblings = GENERATED_CHILD_NAMES.slice(0, -1).map((n) => n.toUpperCase())
    for (let i = 0; i < 20; i += 1) {
      expect(pickGeneratedName(siblings, () => i / 20)).toBe(GENERATED_CHILD_NAMES.at(-1))
    }
  })

  it('still returns a name if every one is taken', () => {
    expect(GENERATED_CHILD_NAMES).toContain(pickGeneratedName(GENERATED_CHILD_NAMES, () => 0.999))
  })
})

describe('ChildInput', () => {
  it('accepts no name, meaning "choose one for me"', () => {
    expect(ChildInput.parse({ age: 6 }).first_name).toBeNull()
    expect(ChildInput.parse({ first_name: null, age: 6 }).first_name).toBeNull()
  })

  it('still rejects a name that breaks the rules', () => {
    expect(ChildInput.safeParse({ first_name: 'Milo9', age: 6 }).success).toBe(false)
    expect(ChildInput.safeParse({ first_name: 'a'.repeat(31), age: 6 }).success).toBe(false)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import modelsJson from '@/config/models.json'
import { isConfiguredModel, masterPromptIdFor, modelForRole, priceFor } from '@/lib/ai/pricing'
import { buildPrompt } from '@/lib/generate/prompt'
import { ownerTrialWriter, withOwnerTrial } from '@/lib/generate/writer-trial'
import type { GenerationDeps } from '@/lib/generate/deps'
import { loadPrompt, promptVersions, resetPromptCache } from '@/lib/prompts'
import type { StoryBible } from '@/lib/schemas'
import { goodFactPack, request } from '../helpers/story'

const emptyBible = (): StoryBible => ({
  children: [{ name: 'Milo', age: 7, likes: ['LEGO'], role_notes: null }],
  recurring: [],
  catchphrases: [],
  topics_covered: [],
  last_story: null,
  tone_history: [],
  avoid: [],
})

/**
 * Issue #132: the owner's writer trial. VT-WT1 (who gets the trial writer, and when) and
 * VT-WT2 (the master prompt follows the writer; nobody else's prompt moves).
 */

const OWNER = '11111111-1111-4111-8111-111111111111'
const PARENT = '22222222-2222-4222-8222-222222222222'
const GLM = 'glm-5.3-flash'
const NOW = new Date('2026-11-28T20:00:00.000Z')

const ENV = ['OWNER_USER_ID', 'OWNER_WRITING_MODEL', 'OWNER_WRITING_MODEL_UNTIL', 'WRITING_MODEL', 'PROMPT_PIN_MASTER'] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
  for (const k of ENV) delete process.env[k]
  process.env.OWNER_USER_ID = OWNER
  resetPromptCache()
})
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  resetPromptCache()
  vi.restoreAllMocks()
})

describe('VT-WT1: who is given the trial writer', () => {
  it('nobody, with the switch unset or blank', () => {
    expect(ownerTrialWriter(OWNER, NOW)).toBeNull()
    process.env.OWNER_WRITING_MODEL = '   '
    expect(ownerTrialWriter(OWNER, NOW)).toBeNull()
  })

  it('the owner, and only the owner', () => {
    process.env.OWNER_WRITING_MODEL = GLM
    expect(ownerTrialWriter(OWNER, NOW)).toBe(GLM)
    expect(ownerTrialWriter(PARENT, NOW)).toBeNull()
    expect(ownerTrialWriter(null, NOW)).toBeNull()
    expect(ownerTrialWriter(undefined, NOW)).toBeNull()
  })

  it('nobody when no owner is named: the check fails closed', () => {
    process.env.OWNER_WRITING_MODEL = GLM
    delete process.env.OWNER_USER_ID
    expect(ownerTrialWriter(OWNER, NOW)).toBeNull()
  })

  it('the normal writer for a model with no capabilities or no price in config, with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.OWNER_WRITING_MODEL = 'glm-9-imaginary'
    expect(ownerTrialWriter(OWNER, NOW)).toBeNull()
    expect(ownerTrialWriter(OWNER, NOW)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('glm-9-imaginary')
    expect(isConfiguredModel('glm-9-imaginary')).toBe(false)
    // Not a prototype key either.
    expect(isConfiguredModel('constructor')).toBe(false)
  })

  it('through the whole of the end date (UTC), and not a moment after', () => {
    process.env.OWNER_WRITING_MODEL = GLM
    process.env.OWNER_WRITING_MODEL_UNTIL = '2026-12-12'
    expect(ownerTrialWriter(OWNER, new Date('2026-11-28T00:00:00Z'))).toBe(GLM)
    expect(ownerTrialWriter(OWNER, new Date('2026-12-12T23:59:59.000Z'))).toBe(GLM)
    expect(ownerTrialWriter(OWNER, new Date('2026-12-13T00:00:00.000Z'))).toBeNull()
  })

  it('the normal writer for an end date that is not a date', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.OWNER_WRITING_MODEL = GLM
    for (const bad of ['next friday', '12/12/2026', '2026-13-45', '2026-02-30', '2026-11-31']) {
      process.env.OWNER_WRITING_MODEL_UNTIL = bad
      expect(ownerTrialWriter(OWNER, NOW), bad).toBeNull()
    }
    expect(warn).toHaveBeenCalled()
  })

  it('the request deps: the trial model for the owner, the same object back for anyone else', () => {
    process.env.OWNER_WRITING_MODEL = GLM
    const deps: GenerationDeps = { deadlineMs: 123, thinkingDisplay: 'summarized' }
    expect(withOwnerTrial(deps, PARENT, NOW)).toBe(deps)
    const trial = withOwnerTrial(deps, OWNER, NOW)
    expect(trial).toMatchObject({ deadlineMs: 123, writingModel: GLM })
    delete process.env.OWNER_WRITING_MODEL
    expect(withOwnerTrial(deps, OWNER, NOW)).toBe(deps)
  })

  it('the trial model is one the app can call and price', () => {
    expect(isConfiguredModel(GLM)).toBe(true)
    expect(priceFor(GLM).input).toBeGreaterThan(0)
    // Never a role default: the trial is the owner's alone until the owner says otherwise.
    for (const role of Object.values(modelsJson.roles)) expect(role.model).not.toBe(GLM)
    expect(modelsJson.bakeoff_contestants).not.toContain(GLM)
  })
})

describe('VT-WT2: the master prompt follows the writer', () => {
  const input = { request: request(), bible: emptyBible(), factPack: goodFactPack() }

  it('GLM gets master.glm; the configured writer and an unlisted model get master', () => {
    expect(masterPromptIdFor(GLM)).toBe('master.glm')
    expect(masterPromptIdFor()).toBe('master')
    expect(masterPromptIdFor(modelForRole('writer'))).toBe('master')
    expect(masterPromptIdFor('some-other-model')).toBe('master')
    // The comment key in config is not a model.
    expect(masterPromptIdFor('$comment')).toBe('master')
  })

  it('a story for everyone else is sent the newest master, byte for byte', () => {
    const plain = buildPrompt(input)
    expect(plain.masterPromptId).toBe('master')
    expect(plain.masterPromptVersion).toBe(promptVersions('master')[0])
    expect(plain.system[0]!.text).toBe(loadPrompt('master').body)
  })

  it('a GLM story is sent master.glm, and only the system block differs', () => {
    const plain = buildPrompt(input)
    const glm = buildPrompt({ ...input, writerModel: GLM })
    expect(glm.masterPromptId).toBe('master.glm')
    expect(glm.system[0]!.text).toBe(loadPrompt('master.glm').body)
    expect(glm.system[0]!.text).not.toBe(plain.system[0]!.text)
    expect(glm.system[0]!.cache).toBe(true)
    expect(glm.messages).toEqual(plain.messages)
  })

  it('master.glm.v1.md is never a version of master', () => {
    expect(existsSync(join(process.cwd(), 'prompts', 'master.glm.v1.md'))).toBe(true)
    const versions = promptVersions('master')
    expect(versions.every((v) => existsSync(join(process.cwd(), 'prompts', `master.v${v}.md`)))).toBe(true)
    expect(loadPrompt('master').file.endsWith(`master.v${versions[0]}.md`)).toBe(true)
    expect(promptVersions('master.glm')).toEqual([1])
  })

  it('PROMPT_PIN_MASTER still pins master, and does not move the GLM prompt', () => {
    const older = promptVersions('master')[1]!
    process.env.PROMPT_PIN_MASTER = String(older)
    resetPromptCache()
    expect(buildPrompt(input).masterPromptVersion).toBe(older)
    expect(buildPrompt({ ...input, writerModel: GLM }).masterPromptVersion).toBe(1)
  })

  it('the safety, data and output sections of master.glm are those of master v6, but for a stricter rule 3', () => {
    // The tuned prompt changed how the story is told, not the rules. Sections 7-8 are v6's word
    // for word; section 6 differs only in hard rule 3, where a disaster's day is never a scene
    // for bands A-C (stricter than v6's "told from safety" for band B).
    const section = (body: string, from: string, to: string) => body.slice(body.indexOf(`\n## ${from}`), body.indexOf(`\n## ${to}`))
    const withoutRule3 = (text: string) => text.slice(0, text.indexOf('3. **Nothing written to frighten.**')) + text.slice(text.indexOf('4. **No self-harm'))
    process.env.PROMPT_PIN_MASTER = '6'
    resetPromptCache()
    const v6 = loadPrompt('master').body
    const glm = loadPrompt('master.glm').body
    expect(section(glm, '7', '9').length).toBeGreaterThan(1000)
    expect(section(glm, '7', '9')).toBe(section(v6, '7', '9'))
    expect(withoutRule3(section(glm, '6', '7')).length).toBeGreaterThan(1000)
    expect(withoutRule3(section(glm, '6', '7'))).toBe(withoutRule3(section(v6, '6', '7')))
    expect(section(glm, '6', '7')).toMatch(/the children never visit\s+its day/)
  })
})

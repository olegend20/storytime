import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __clearLocalStoreCache, readRaw, subscribeKey, writeRaw } from '@/lib/client/localStore'
import {
  CheckedFacts,
  DEFAULT_FORM_MEMORY,
  DEFAULT_READING_PREFS,
  FORM_KEY,
  NullableScrollMemory,
  PREFS_KEY,
  ReadingPrefs,
  StoryFormMemory,
  TEXT_SCALES,
  factsKey,
  forgetStory,
  loadCheckedFacts,
  loadFormMemory,
  loadReadingPrefs,
  loadScroll,
  parseStored,
  saveCheckedFacts,
  saveFormMemory,
  saveReadingPrefs,
  saveScroll,
  scrollKey,
} from '@/lib/client/storage'

/**
 * Preferences and per-story memory.
 *
 * The rule these tests protect: a browser that blocks or clears site data must degrade to
 * defaults, never throw. This app is used at bedtime, often in a private window, and a
 * `SecurityError` from a preference read is not an acceptable way to fail.
 */

class FakeStorage {
  private map = new Map<string, string>()
  getItem(key: string) {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  clear() {
    this.map.clear()
  }
}

function installStorage(storage: unknown) {
  // `localStore` reads `window.localStorage`, so the tests need a window.
  vi.stubGlobal('window', { localStorage: storage, addEventListener: () => {} })
  __clearLocalStoreCache()
}

beforeEach(() => installStorage(new FakeStorage()))
afterEach(() => {
  vi.unstubAllGlobals()
  __clearLocalStoreCache()
})

describe('localStore', () => {
  it('round-trips and caches', () => {
    writeRaw('k', 'v')
    expect(readRaw('k')).toBe('v')
  })

  it('notifies subscribers of that key only', () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribeKey('k', a)
    subscribeKey('other', b)
    writeRaw('k', 'v')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('does not notify when the value is unchanged, so readers do not re-render for nothing', () => {
    writeRaw('k', 'v')
    const listener = vi.fn()
    subscribeKey('k', listener)
    writeRaw('k', 'v')
    expect(listener).not.toHaveBeenCalled()
  })

  it('unsubscribing stops the notifications', () => {
    const listener = vi.fn()
    subscribeKey('k', listener)()
    writeRaw('k', 'v')
    expect(listener).not.toHaveBeenCalled()
  })

  it('returns null with no storage at all (server rendering)', () => {
    vi.stubGlobal('window', undefined)
    __clearLocalStoreCache()
    expect(readRaw('k')).toBeNull()
    expect(() => writeRaw('k', 'v')).not.toThrow()
  })

  it('survives storage that throws on every access', () => {
    installStorage({
      getItem() {
        throw new DOMException('blocked', 'SecurityError')
      },
      setItem() {
        throw new DOMException('quota', 'QuotaExceededError')
      },
      removeItem() {
        throw new DOMException('blocked', 'SecurityError')
      },
    })
    expect(readRaw('k')).toBeNull()
    expect(() => writeRaw('k', 'v')).not.toThrow()
  })
})

describe('parseStored', () => {
  it('falls back for a miss, for junk, and for the wrong shape', () => {
    expect(parseStored(null, CheckedFacts, [])).toEqual([])
    expect(parseStored('{not json', CheckedFacts, [])).toEqual([])
    expect(parseStored('{"a":1}', CheckedFacts, [])).toEqual([])
    expect(parseStored('[1,2]', CheckedFacts, [])).toEqual([1, 2])
  })
})

describe('reading preferences', () => {
  it('defaults to following the system theme', () => {
    expect(loadReadingPrefs()).toEqual(DEFAULT_READING_PREFS)
    expect(DEFAULT_READING_PREFS.theme).toBe('system')
    expect(DEFAULT_READING_PREFS.readingMode).toBe(false)
  })

  it('round-trips a chosen theme, reading mode and text size', () => {
    saveReadingPrefs({ theme: 'dark', readingMode: true, textScaleIndex: 3 })
    expect(loadReadingPrefs()).toEqual({ theme: 'dark', readingMode: true, textScaleIndex: 3 })
  })

  it('rejects an out-of-range text scale rather than indexing past the array', () => {
    writeRaw(PREFS_KEY, JSON.stringify({ theme: 'dark', readingMode: false, textScaleIndex: 99 }))
    expect(loadReadingPrefs()).toEqual(DEFAULT_READING_PREFS)
    expect(TEXT_SCALES[DEFAULT_READING_PREFS.textScaleIndex]).toBe(1)
  })

  it('the schema is what the inline theme script can rely on', () => {
    expect(ReadingPrefs.safeParse({ theme: 'nonsense' }).success).toBe(false)
  })
})

describe('form memory (F10 AC)', () => {
  it('defaults to no children and 10 minutes', () => {
    expect(loadFormMemory()).toEqual(DEFAULT_FORM_MEMORY)
  })

  it('remembers the last-used children and length', () => {
    saveFormMemory({ childIds: ['a', 'b'], lengthMinutes: 15 })
    expect(loadFormMemory()).toEqual({ childIds: ['a', 'b'], lengthMinutes: 15 })
  })

  it('ignores a stored length that is not 5, 10 or 15', () => {
    writeRaw(FORM_KEY, JSON.stringify({ childIds: [], lengthMinutes: 7 }))
    expect(loadFormMemory()).toEqual(DEFAULT_FORM_MEMORY)
    expect(StoryFormMemory.safeParse({ childIds: [], lengthMinutes: 7 }).success).toBe(false)
  })
})

describe('per-story memory (F9 AC)', () => {
  const storyId = 'a2117f05-0000-4000-8000-a2117f050000'

  it('scroll position is stored per story', () => {
    saveScroll(storyId, 1234.6)
    expect(loadScroll(storyId)?.y).toBe(1235)
    expect(loadScroll('other-story')).toBeNull()
    expect(scrollKey(storyId)).not.toBe(scrollKey('other-story'))
  })

  it('ticked facts are stored per story, sorted and de-duplicated on read', () => {
    saveCheckedFacts(storyId, [3, 1, 2])
    expect(loadCheckedFacts(storyId)).toEqual([1, 2, 3])
    expect(loadCheckedFacts('other-story')).toEqual([])
  })

  it('deleting a story leaves nothing behind on the device', () => {
    saveScroll(storyId, 900)
    saveCheckedFacts(storyId, [1])
    forgetStory(storyId)
    expect(readRaw(scrollKey(storyId))).toBeNull()
    expect(readRaw(factsKey(storyId))).toBeNull()
  })

  it('a corrupt scroll value reads as "no memory", not as a crash', () => {
    writeRaw(scrollKey(storyId), '{"y":"halfway"}')
    expect(loadScroll(storyId)).toBeNull()
    expect(NullableScrollMemory.safeParse({ y: -5, savedAt: 'x' }).success).toBe(false)
  })
})

/**
 * Incremental JSON scanner.
 *
 * The writing model returns one JSON object, but the reader has to see chapters appear as
 * they are written (F6 AC: "the client receives the title within 5 s and chapters
 * progressively"). So the response is scanned as it streams and string values are reported
 * at known paths - `title`, `chapters[0].heading`, `chapters[0].text` - long before the
 * object closes.
 *
 * It is a scanner, not a validator: malformed JSON produces fewer events, never an
 * exception mid-stream. The authoritative parse happens once on the finished text
 * (`lib/generate/parse.ts`), so a scanner slip can only cost progressive rendering, never
 * correctness.
 */

interface ObjectFrame {
  kind: 'object'
  key: string | null
  expectingKey: boolean
}
interface ArrayFrame {
  kind: 'array'
  index: number
}
type Frame = ObjectFrame | ArrayFrame

export interface JsonStreamHandlers {
  onStringStart?: (path: string) => void
  /** Decoded text, escapes already resolved. Concatenate in arrival order. */
  onStringDelta?: (path: string, text: string) => void
  onStringEnd?: (path: string, value: string) => void
  onScalar?: (path: string, value: unknown) => void
  onObjectStart?: (path: string) => void
  onObjectEnd?: (path: string) => void
  onArrayStart?: (path: string) => void
  onArrayEnd?: (path: string) => void
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

export class IncrementalJsonScanner {
  private readonly stack: Frame[] = []
  private state: 'idle' | 'string' | 'literal' = 'idle'
  private inKey = false
  private escaped = false
  private unicodeDigits: string | null = null
  private stringValue = ''
  private pendingDelta = ''
  private literal = ''
  private currentStringPath = ''
  /** True once the top-level value has closed; later bytes are ignored. */
  private done = false

  constructor(private readonly handlers: JsonStreamHandlers) {}

  /** Path of the value currently being read, e.g. `chapters[0].text`. */
  private path(): string {
    let out = ''
    for (const frame of this.stack) {
      if (frame.kind === 'object') {
        out = out === '' ? (frame.key ?? '?') : `${out}.${frame.key ?? '?'}`
      } else {
        out = `${out}[${frame.index}]`
      }
    }
    return out
  }

  /** Called when a value begins: an array parent advances its index first. */
  private beginValue(): void {
    const top = this.stack[this.stack.length - 1]
    if (top && top.kind === 'array') top.index += 1
  }

  feed(chunk: string): void {
    if (this.done) return
    for (const char of chunk) this.consume(char)
    this.flushDelta()
  }

  /** Flush any trailing delta. Call once the upstream stream has finished. */
  end(): void {
    this.flushDelta()
  }

  private flushDelta(): void {
    if (this.pendingDelta === '') return
    const text = this.pendingDelta
    this.pendingDelta = ''
    this.handlers.onStringDelta?.(this.currentStringPath, text)
  }

  private consume(char: string): void {
    if (this.state === 'string') {
      this.consumeInString(char)
      return
    }
    if (this.state === 'literal') {
      if (/[-+0-9.eE]/.test(char) || /[a-zA-Z]/.test(char)) {
        this.literal += char
        return
      }
      this.finishLiteral()
      // Fall through: this character belongs to the structure, not the literal.
    }
    this.consumeIdle(char)
  }

  private consumeInString(char: string): void {
    if (this.unicodeDigits !== null) {
      this.unicodeDigits += char
      if (this.unicodeDigits.length === 4) {
        const code = Number.parseInt(this.unicodeDigits, 16)
        this.unicodeDigits = null
        this.append(Number.isNaN(code) ? '' : String.fromCharCode(code))
      }
      return
    }
    if (this.escaped) {
      this.escaped = false
      if (char === 'u') {
        this.unicodeDigits = ''
        return
      }
      this.append(ESCAPES[char] ?? char)
      return
    }
    if (char === '\\') {
      this.escaped = true
      return
    }
    if (char === '"') {
      this.closeString()
      return
    }
    this.append(char)
  }

  private append(text: string): void {
    this.stringValue += text
    if (!this.inKey) this.pendingDelta += text
  }

  private closeString(): void {
    this.state = 'idle'
    const value = this.stringValue
    this.stringValue = ''
    if (this.inKey) {
      const top = this.stack[this.stack.length - 1]
      if (top && top.kind === 'object') top.key = value
      this.inKey = false
      return
    }
    this.flushDelta()
    this.handlers.onStringEnd?.(this.currentStringPath, value)
  }

  private finishLiteral(): void {
    const raw = this.literal
    this.literal = ''
    this.state = 'idle'
    if (raw === '') return
    let value: unknown = raw
    if (raw === 'true') value = true
    else if (raw === 'false') value = false
    else if (raw === 'null') value = null
    else {
      const num = Number(raw)
      value = Number.isNaN(num) ? raw : num
    }
    this.handlers.onScalar?.(this.path(), value)
  }

  private consumeIdle(char: string): void {
    switch (char) {
      case ' ':
      case '\n':
      case '\r':
      case '\t':
        return
      case '{': {
        this.beginValue()
        const path = this.path()
        this.stack.push({ kind: 'object', key: null, expectingKey: true })
        this.handlers.onObjectStart?.(path)
        return
      }
      case '[': {
        this.beginValue()
        const path = this.path()
        this.stack.push({ kind: 'array', index: -1 })
        this.handlers.onArrayStart?.(path)
        return
      }
      case '}': {
        const frame = this.stack.pop()
        if (frame) this.handlers.onObjectEnd?.(this.path())
        if (this.stack.length === 0) this.done = true
        return
      }
      case ']': {
        const frame = this.stack.pop()
        if (frame) this.handlers.onArrayEnd?.(this.path())
        if (this.stack.length === 0) this.done = true
        return
      }
      case '"': {
        const top = this.stack[this.stack.length - 1]
        if (top && top.kind === 'object' && top.expectingKey) {
          this.inKey = true
          this.state = 'string'
          this.stringValue = ''
          return
        }
        this.beginValue()
        this.inKey = false
        this.state = 'string'
        this.stringValue = ''
        this.pendingDelta = ''
        this.currentStringPath = this.path()
        this.handlers.onStringStart?.(this.currentStringPath)
        return
      }
      case ':': {
        const top = this.stack[this.stack.length - 1]
        if (top && top.kind === 'object') top.expectingKey = false
        return
      }
      case ',': {
        const top = this.stack[this.stack.length - 1]
        if (top && top.kind === 'object') {
          top.expectingKey = true
          top.key = null
        }
        return
      }
      default: {
        this.beginValue()
        this.state = 'literal'
        this.literal = char
        return
      }
    }
  }
}

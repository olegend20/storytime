import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Issue #126: the repository is open source under Apache-2.0. */
const root = join(__dirname, '..', '..')
const read = (file: string) => readFileSync(join(root, file), 'utf8')

describe('licence (issue #126)', () => {
  it('VT-LIC1: LICENSE is the unmodified Apache License 2.0 text', () => {
    // sha256 of https://www.apache.org/licenses/LICENSE-2.0.txt
    expect(createHash('sha256').update(read('LICENSE')).digest('hex')).toBe(
      'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    )
  })

  it('VT-LIC2: package.json names the licence', () => {
    expect(JSON.parse(read('package.json')).license).toBe('Apache-2.0')
  })

  it('VT-LIC3: the README names the licence and links the file', () => {
    expect(read('README.md')).toContain('[Apache License, Version 2.0](LICENSE)')
  })
})

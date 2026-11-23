'use client'

import { useEffect, useState } from 'react'

/**
 * Copies our sending address, so it reaches Amazon's form without a typing mistake - a
 * misspelt approved sender fails silently. When the browser will not copy (no clipboard, or
 * permission refused) it says so: the worst outcome is a parent pasting whatever was on the
 * clipboard before. The address is on the page to select by hand either way.
 */
export default function CopyAddress({ address }: { address: string }) {
  const [result, setResult] = useState<'idle' | 'copied' | 'failed'>('idle')

  // The note goes away, so pressing again announces it again.
  useEffect(() => {
    if (result === 'idle') return
    const timer = setTimeout(() => setResult('idle'), 4000)
    return () => clearTimeout(timer)
  }, [result])

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(address)
      setResult('copied')
    } catch {
      setResult('failed')
    }
  }

  return (
    <>
      <button type="button" className="btn btn-quiet" data-testid="kindle-copy" onClick={() => void copy()}>
        Copy address
      </button>
      <span role="status" className="text-sm" data-testid="kindle-copy-status">
        {result === 'copied' ? 'Copied.' : result === 'failed' ? 'Could not copy. Select the address and copy it by hand.' : ''}
      </span>
    </>
  )
}

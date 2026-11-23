'use client'

import { useState } from 'react'

/**
 * Copies our sending address, so it reaches Amazon's form without a typing mistake - a
 * misspelt approved sender fails silently. Where the clipboard is unavailable the address
 * is still on the page to select by hand.
 */
export default function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <>
      <button
        type="button"
        className="btn btn-quiet"
        data-testid="kindle-copy"
        onClick={() => {
          navigator.clipboard?.writeText(address).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }}
      >
        Copy address
      </button>
      <span role="status" className="text-sm">
        {copied ? 'Copied.' : ''}
      </span>
    </>
  )
}

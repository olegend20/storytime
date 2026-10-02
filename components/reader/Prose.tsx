import { parseParagraphs, type Inline } from '@/lib/client/markdown'

/**
 * Story prose.
 *
 * Tokens become React elements, so nothing from the model or from a parent's text ever reaches
 * `dangerouslySetInnerHTML`. Sound words get their own treatment because they are the part a
 * small child joins in with - see `isSoundWord`.
 */
function Token({ token }: { token: Inline }) {
  switch (token.kind) {
    case 'text':
      return <>{token.text}</>
    case 'em':
      return <em>{token.text}</em>
    case 'strong':
      return token.sound ? (
        <strong className="sound">{token.text}</strong>
      ) : (
        <strong>{token.text}</strong>
      )
    case 'strongEm':
      return token.sound ? (
        <strong className="sound">
          <em>{token.text}</em>
        </strong>
      ) : (
        <strong>
          <em>{token.text}</em>
        </strong>
      )
  }
}

/**
 * Whether the book's first paragraph can carry a drop cap: it must open with a plain letter
 * (not a quote mark, and not a sound word in its own typeface) and run long enough to wrap
 * around a three-line initial. Otherwise the paragraph is set like any other.
 */
export function canDropCap(tokens: readonly Inline[]): boolean {
  const first = tokens[0]
  // Any letter, not only A-Z: a story may open with Élodie or Øyvind.
  if (!first || first.kind !== 'text' || !/^\p{L}/u.test(first.text)) return false
  return tokens.reduce((n, t) => n + t.text.length, 0) >= 140
}

export function Prose({
  text,
  className = '',
  dropCap = false,
}: {
  text: string
  className?: string
  /** Set the first letter of the first paragraph as a drop cap, when it can take one. */
  dropCap?: boolean
}) {
  const paragraphs = parseParagraphs(text)
  return (
    <div className={`prose ${className}`}>
      {paragraphs.map((tokens, i) => (
        // Paragraph order is the only stable identity prose has; the array is rebuilt from the
        // same text on every render, so the index is a correct key here.
        <p key={i} className={dropCap && i === 0 && canDropCap(tokens) ? 'st-dropcap-p' : undefined}>
          {tokens.map((token, j) => (
            <Token key={j} token={token} />
          ))}
        </p>
      ))}
    </div>
  )
}

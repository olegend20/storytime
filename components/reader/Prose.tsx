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

export function Prose({ text, className = '' }: { text: string; className?: string }) {
  const paragraphs = parseParagraphs(text)
  return (
    <div className={`prose ${className}`}>
      {paragraphs.map((tokens, i) => (
        // Paragraph order is the only stable identity prose has; the array is rebuilt from the
        // same text on every render, so the index is a correct key here.
        <p key={i}>
          {tokens.map((token, j) => (
            <Token key={j} token={token} />
          ))}
        </p>
      ))}
    </div>
  )
}

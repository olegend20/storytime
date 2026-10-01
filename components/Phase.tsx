/**
 * A moon at a given phase: 0 = new (outline only), 0.5 = half, 1 = full.
 *
 * The one recurring motif of the design (issue #17): ten of them on the landing page, the stage
 * on the waiting screen, chapter progress in the reader. Decorative unless given a label.
 */
export function Phase({
  lit,
  size = 14,
  className,
  label,
}: {
  lit: number
  size?: number
  className?: string
  label?: string
}) {
  const f = Math.max(0, Math.min(1, lit))
  const rx = 9 * Math.abs(1 - 2 * f)
  const sweep = f < 0.5 ? 0 : 1
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
      {f > 0.02 ? (
        <path
          d={f > 0.98 ? 'M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18z' : `M12 3A9 9 0 0 1 12 21A${rx} 9 0 0 ${sweep} 12 3z`}
          fill="currentColor"
        />
      ) : null}
    </svg>
  )
}

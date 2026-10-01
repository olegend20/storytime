import type { SVGProps } from 'react'

/** Line icons, drawn at 1.6 stroke to sit beside Newsreader and Inter. All decorative. */
const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}
type P = SVGProps<SVGSVGElement>

export const ArrowRight = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 12h15M13 6l6 6-6 6" />
  </svg>
)
export const ArrowLeft = (p: P) => (
  <svg {...base} {...p}>
    <path d="M20 12H5M11 6l-6 6 6 6" />
  </svg>
)
export const ChevronDown = (p: P) => (
  <svg {...base} {...p}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)
export const ChevronLeft = (p: P) => (
  <svg {...base} {...p}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
)
export const Check = (p: P) => (
  <svg {...base} strokeWidth={2} {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
)
export const More = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="5" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="19" cy="12" r="1.2" fill="currentColor" />
  </svg>
)
export const Person = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="8.5" r="3.6" />
    <path d="M4.5 20c1.2-3.6 4-5.4 7.5-5.4s6.3 1.8 7.5 5.4" />
  </svg>
)

import { ImageResponse } from 'next/og'

/** The app icon, drawn at build time: a moon over an open book. 512px for Android. */
export const size = { width: 512, height: 512 }
export const contentType = 'image/png'

export default function Icon() {
  return new ImageResponse(<Mark />, size)
}

export function Mark() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(160deg, #2b2f5c 0%, #171a3a 100%)',
        borderRadius: 96,
      }}
    >
      <svg width="360" height="360" viewBox="0 0 100 100" fill="none">
        <path d="M63 22a22 22 0 1 0 14 39 26 26 0 1 1-14-39z" fill="#f2d98c" />
        <path d="M14 62q18-8 36 0 18-8 36 0v22q-18-8-36 0-18-8-36 0z" fill="#fbf8f2" />
        <path d="M50 62v22" stroke="#2b2f5c" strokeWidth="3" />
      </svg>
    </div>
  )
}

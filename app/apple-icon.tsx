import { ImageResponse } from 'next/og'
import { Mark } from './icon'

/** iOS reads its own 180px icon and ignores the manifest's. */
export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
  return new ImageResponse(<Mark />, size)
}

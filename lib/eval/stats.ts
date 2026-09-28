/**
 * Summary statistics for the eval and bake-off reports.
 *
 * JUDGE_AGENT.md §2: "Report medians and spreads, not single samples." Three samples per
 * scenario × contestant means a single unlucky generation must not move a verdict, so
 * every headline number in the report is a median and every median is printed next to its
 * min so a wide spread is visible rather than averaged away.
 */

export function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b)
}

/** Linear interpolation between order statistics (the R-7 / Excel convention). */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN
  if (q <= 0) return sorted(values)[0]!
  const s = sorted(values)
  if (q >= 1) return s[s.length - 1]!
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return s[lo]!
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo)
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5)
}

export function p95(values: readonly number[]): number {
  return quantile(values, 0.95)
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  return values.reduce((a, b) => a + b, 0) / values.length
}

export function min(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : sorted(values)[0]!
}

export function max(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : sorted(values)[values.length - 1]!
}

export function round(value: number, dp = 2): number {
  if (!Number.isFinite(value)) return value
  const f = 10 ** dp
  return Math.round(value * f) / f
}

/**
 * Index of the item whose value is the median. With an even count there is no single
 * median item, so the lower of the two middles is chosen - deterministic, and it is the
 * "median-scored story" §6 step 4 asks for, which must be an actual story and not an
 * interpolated one.
 */
export function medianIndex(values: readonly number[]): number {
  if (values.length === 0) return -1
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i)
  return order[Math.floor((order.length - 1) / 2)]!.i
}

/** Formats a number for a markdown table; `-` for a value we have no data for. */
export function fmt(value: number, dp = 2): string {
  return Number.isFinite(value) ? value.toFixed(dp) : '-'
}

export function fmtUsd(value: number): string {
  if (!Number.isFinite(value)) return '-'
  if (value === 0) return '$0.000000'
  return value < 0.01 ? `$${value.toFixed(6)}` : `$${value.toFixed(4)}`
}

export function fmtPct(value: number, dp = 1): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(dp)}%` : '-'
}

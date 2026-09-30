import pricingJson from '@/config/pricing.json'
import modelsJson from '@/config/models.json'

/**
 * Cost computation from config/pricing.json. Prices are NEVER hard-coded here
 * (kickoff rule 2). F8 VT hand-checks three cases against this file.
 */

export type CacheTtl = '5m' | '1h'

export interface ModelPrice {
  display_name: string
  input: number
  output: number
  cache_write_5m: number
  cache_write_1h: number
  cache_read: number
  cache_read_multiplier: number
}

export interface TokenUsage {
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
}

const PER_MILLION = 1_000_000

export const pricing = pricingJson as unknown as {
  updated_at: string
  sources: { page: string; url: string; fetched: string }[]
  refresh_policy: { max_age_days: number; note: string }
  modifiers: { batch_discount: number; inference_geo_us_multiplier: number }
  server_tools: { web_search: { usd_per_1000_searches: number } }
  models: Record<string, ModelPrice>
}

export const models = modelsJson as unknown as {
  roles: Record<string, { model: string; why: string; env_override: string }>
  bakeoff_contestants: string[]
  capabilities: Record<string, Record<string, unknown>>
}

export function priceFor(model: string): ModelPrice {
  const p = pricing.models[model]
  if (!p) {
    throw new Error(
      `No price in config/pricing.json for model "${model}". ` +
        `Add it from https://platform.claude.com/docs/en/about-claude/pricing (do not guess), ` +
        `then bump updated_at. Known models: ${Object.keys(pricing.models).join(', ')}`,
    )
  }
  return p
}

export interface ComputeCostInput {
  model: string
  input: number
  cacheRead?: number
  cacheWrite?: number
  output: number
  cacheTtl?: CacheTtl
  /** Server-tool surcharges, e.g. web searches performed (fact-pack builder only). */
  webSearches?: number
  batch?: boolean
}

/**
 * Returns USD. Rounded to 6dp to match generation_logs.cost_usd numeric(10,6).
 *
 * `input` must be the UNCACHED input token count, matching the API's
 * usage.input_tokens (which already excludes cache reads and cache writes).
 */
export function computeCost(input: ComputeCostInput): number {
  const p = priceFor(input.model)
  const cacheWritePrice = input.cacheTtl === '1h' ? p.cache_write_1h : p.cache_write_5m

  let usd =
    (input.input * p.input +
      (input.cacheRead ?? 0) * p.cache_read +
      (input.cacheWrite ?? 0) * cacheWritePrice +
      input.output * p.output) /
    PER_MILLION

  if (input.batch) usd *= pricing.modifiers.batch_discount

  // Server-tool surcharges are not discounted by batch and are priced per call.
  if (input.webSearches) {
    usd += (input.webSearches * pricing.server_tools.web_search.usd_per_1000_searches) / 1000
  }

  return Math.round(usd * 1e6) / 1e6
}

/** Age of the price table in whole days. F8 VT fails the suite past max_age_days. */
export function pricingAgeDays(now: Date = new Date()): number {
  const updated = new Date(`${pricing.updated_at}T00:00:00Z`)
  return Math.floor((now.getTime() - updated.getTime()) / 86_400_000)
}

export function pricingIsStale(now: Date = new Date()): boolean {
  return pricingAgeDays(now) > pricing.refresh_policy.max_age_days
}

/** Resolve a role to a model id: env override wins over config/models.json. */
export function modelForRole(role: keyof typeof models.roles | string): string {
  const entry = models.roles[role]
  if (!entry) throw new Error(`Unknown model role "${role}" in config/models.json`)
  const override = process.env[entry.env_override]
  return override && override.length > 0 ? override : entry.model
}

export function capabilities(model: string): Record<string, unknown> {
  return models.capabilities[model] ?? {}
}

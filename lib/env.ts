import { z } from 'zod'

/**
 * F1 AC: missing env vars fail fast with a clear message.
 * Never log a value from here - several are secrets.
 */

/** Accepts the shell-ish spellings of a boolean. Defaults are post-transform in zod 4. */
const Booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

/**
 * A Supabase key must be one Supabase can actually use: a JWT (three dot-separated parts, the
 * `supabase start` demo keys and legacy project keys) or a new-style `sb_publishable_` /
 * `sb_secret_` key. `test-` and `ci-` are the explicit placeholders of runs that never reach a
 * database (test/setup.ts, the CI check job).
 *
 * Why: `.env.local` shipped with `local-anon-key` / `local-service-role-key`. They passed a
 * "non-empty" check, sign-in even worked, and then every service-role read failed with
 * "Expected 3 parts in JWT" - on the new-story form, in front of a parent.
 */
const supabaseKey = (name: string, newPrefix: string) =>
  z
    .string()
    .min(1, `${name} is required`)
    .refine(
      (k) =>
        k.split('.').length === 3 ||
        k.startsWith(newPrefix) ||
        k.startsWith('test-') ||
        k.startsWith('ci-'),
      `${name} is not a usable Supabase key (expected a JWT or ${newPrefix}...). ` +
        'For local dev, copy the keys from `supabase status`.',
    )

/**
 * An optional feature's variable left as `KEY=` in .env is unset, not invalid: a blank
 * must never take down login and generation over a feature that is off.
 */
const blankIsUnset = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional())

const ServerEnv = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a URL'),
  SUPABASE_ANON_KEY: supabaseKey('SUPABASE_ANON_KEY', 'sb_publishable_'),
  SUPABASE_SERVICE_ROLE_KEY: supabaseKey('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_'),

  /**
   * F8: kill switch and budget cap. Changing either needs no code change, but a running
   * instance keeps the value it started with (this module caches the parsed env): on Vercel,
   * set the variable and redeploy - see DEPLOY.md.
   */
  GENERATION_ENABLED: Booleanish.default(true),
  DAILY_BUDGET_USD: z.coerce.number().positive().default(5),

  /**
   * Send to Kindle (issue #11): the app mails an EPUB over SMTP. All optional - with
   * SMTP_HOST or KINDLE_FROM_EMAIL unset the feature says it is not set up. Locally the
   * Supabase mailbox is the provider (127.0.0.1:54325, no auth).
   */
  SMTP_HOST: blankIsUnset(z.string().min(1)),
  SMTP_PORT: blankIsUnset(z.coerce.number().int().positive()).default(587),
  SMTP_USER: blankIsUnset(z.string().min(1)),
  SMTP_PASS: blankIsUnset(z.string().min(1)),
  SMTP_SECURE: Booleanish.default(false),
  KINDLE_FROM_EMAIL: blankIsUnset(z.string().email()),

  /** F12: /admin is gated to this user id; everyone else gets a 404. */
  OWNER_USER_ID: z.string().uuid().optional(),

  /** Model overrides. Defaults live in config/models.json. */
  WRITING_MODEL: z.string().optional(),
  HELPER_MODEL: z.string().optional(),
  FACTPACK_MODEL: z.string().optional(),
  JUDGE_MODEL: z.string().optional(),
  JUDGE_MODEL_SECONDARY: z.string().optional(),

  /** Test-harness switches. Live API calls are opt-in only (kickoff rule 3). */
  LIVE_API: Booleanish.default(false),
  RECORD_FIXTURES: Booleanish.default(false),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
})

export type ServerEnv = z.infer<typeof ServerEnv>

function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
  return [
    'Invalid environment configuration:',
    ...lines,
    '',
    'Copy .env.example to .env.local and fill in the missing values.',
  ].join('\n')
}

let cached: ServerEnv | null = null

/** Throws with an actionable message when anything required is missing. */
export function serverEnv(): ServerEnv {
  if (cached) return cached
  const parsed = ServerEnv.safeParse(process.env)
  if (!parsed.success) throw new Error(formatIssues(parsed.error))
  cached = parsed.data
  return cached
}

/** For tests: parse an arbitrary record without touching process.env or the cache. */
export function parseEnv(raw: Record<string, unknown>) {
  return ServerEnv.safeParse(raw)
}

export function resetEnvCache(): void {
  cached = null
}

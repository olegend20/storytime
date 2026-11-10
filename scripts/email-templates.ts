/**
 * Writes supabase/templates/*.html from lib/email/auth-templates.ts, and their subject into
 * supabase/config.toml (issue #98). Run after
 * changing the email layout or copy: `pnpm tsx scripts/email-templates.ts`, then commit the
 * files and push them to production with `supabase config push` (DEPLOY.md).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AUTH_TEMPLATE_KINDS, AUTH_TEMPLATE_SUBJECT, authTemplates } from '@/lib/email/auth-templates'

const dir = join('supabase', 'templates')
mkdirSync(dir, { recursive: true })
for (const [name, html] of Object.entries(authTemplates())) writeFileSync(join(dir, name), html)

// The subject lives in config.toml, beside content_path; keep it in step with EMAIL.signIn.
const configPath = join('supabase', 'config.toml')
let config = readFileSync(configPath, 'utf8')
for (const kind of AUTH_TEMPLATE_KINDS) {
  config = config.replace(
    new RegExp(`(\\[auth\\.email\\.template\\.${kind}\\]\\nsubject = )"[^"]*"`),
    `$1${JSON.stringify(AUTH_TEMPLATE_SUBJECT)}`,
  )
}
writeFileSync(configPath, config)

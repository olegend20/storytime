/**
 * Writes supabase/templates/*.html from lib/email/auth-templates.ts (issue #98). Run after
 * changing the email layout or copy: `pnpm tsx scripts/email-templates.ts`, then commit the
 * files and push them to production with `supabase config push` (DEPLOY.md).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { authTemplates } from '@/lib/email/auth-templates'

const dir = join('supabase', 'templates')
mkdirSync(dir, { recursive: true })
for (const [name, html] of Object.entries(authTemplates())) writeFileSync(join(dir, name), html)

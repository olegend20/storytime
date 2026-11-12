# Deploying StoryTime (lastten.org)

Production runs on **Vercel** (project `storytime`, team `olegend20s-projects`) with a hosted
**Supabase** project (`Story Time`, ref `llmhodfcvdbcljwyqlau`, org "Last Ten StoryTime",
US East). First deployed 2026-10-01 (issue #18). No secret values are recorded here or
anywhere in the repo — names only.

## How a change reaches production

`main` is the production branch. The Vercel project is connected to this GitHub repo, so a
merge to `main` builds and deploys by itself. Nothing is deployed by hand in normal use.
(`vercel deploy --prod` from a checkout works too, and is how the very first deployment was
made.)

**Pull requests do not get preview deployments.** `vercel.json` turns automatic deployments
off for every branch except `main`. A preview would need its own database: the only one
that exists is production's, and a preview must never be given the production service-role
key. (The first PR after the project was connected showed why this has to be explicit: its
preview build failed with "Invalid environment configuration", because the variables are
set for Production only.) To have previews later, create a second, non-production Supabase
project, set the Preview environment's variables to it, and remove the rule from
`vercel.json`. CI's Playwright suites remain the check on a pull request.

Database changes are **not** automatic: after a PR with a new file in `supabase/migrations/`
merges, apply it with

```
supabase link --project-ref llmhodfcvdbcljwyqlau   # once per machine
supabase db push --dry-run                          # read what it will do
supabase db push
RUN_SCHEMA_TESTS=1 SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… SUPABASE_ANON_KEY=… \
  pnpm vitest run test/int/schema.test.ts           # RLS and column checks against production
```

## Environment variables (Vercel → Settings → Environment Variables → Production)

| Name | What it is |
|---|---|
| `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL` | The hosted project's URL |
| `SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The public key. Safe in a browser: row-level security is what protects the data |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only. Bypasses RLS; never `NEXT_PUBLIC_` |
| `ANTHROPIC_API_KEY` | The production key: an Understudy `sk_` key (issue #41). **A placeholder until the owner sets it** |
| `ANTHROPIC_BASE_URL` | `https://api.understudylabs.com` (no trailing `/v1`): model calls go through the Understudy gateway to the same Claude models. Unset = Anthropic directly |
| `UNDERSTUDY_PROJECT` | `storytime`: the Understudy project production's calls are tagged with (issue #76). The project must exist with its workloads (`pnpm understudy:workloads --project storytime`). Unset = the eval project `rehearsal`, and the server logs a warning |
| `LIVE_API` | Must be `1` in production for real model calls (unset means fixture replay) |
| `GENERATION_ENABLED` | The kill switch. `false` pauses new stories; saved ones still read |
| `NEXT_PUBLIC_API_MOCK`, `UI_MOCK_API` | **Must be unset in production.** Test-only: the first is inlined at build time and points the whole UI at `/api/mock/*` |
| `DAILY_BUDGET_USD` | Global daily spend cap (5) |
| `OWNER_USER_ID` | The owner's auth user id: unlocks `/admin` and the unlimited quota |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `KINDLE_FROM_EMAIL` | Send to Kindle. Unset = the feature says it is not set up, and the landing page does not mention it |
| `WAITLIST_ENABLED` | Issue #92. Unset or `true`: lastten.org is the coming-soon page, and only an address approved at `/admin/waitlist` can create an account. `false` is the public launch: the homepage returns at `/` and anyone can sign up |
| `SITE_URL` | `https://lastten.org`: where the waitlist invite links, wherever the owner approved from. Unset = the address the owner approved from |
| `MAIL_FROM_EMAIL` | The sender of the waitlist's "your place is ready" email, e.g. `hello@lastten.org` (same SMTP settings). Unset falls back to `KINDLE_FROM_EMAIL`; with neither, approving still works and `/admin/waitlist` says no email was sent |

A changed variable takes effect on the **next deployment**, not instantly: after flipping the
kill switch or the budget cap, redeploy (`vercel redeploy <url>` or Deployments → Redeploy).
On Vercel that takes about a minute and needs no code change, which is what "without a
deploy" in the plan amounts to here; a running instance keeps the values it started with.

## Sign-in (Supabase Auth)

Site URL is `https://lastten.org`; allowed redirects are `lastten.org`, `www.lastten.org` and
the Vercel production URL. To change them, edit a config with only those keys and
`supabase config diff` / `supabase config push` (undeclared settings are left alone).

## The waitlist (issue #92)

lastten.org opens a few families at a time. To run it:

0. **Right after the merge, apply the migration** (`supabase db push`, above). `WAITLIST_ENABLED` is on by
   default and the merge deploys itself; until the `waitlist` table exists, every join on the
   coming-soon page fails and no new account can be created. Existing accounts are unaffected.
1. **Supabase dashboard → Authentication → Sign In / Providers → "Allow new users to sign up": off.**
   Without this, someone who calls Supabase's API directly can still create an account. The app's own
   sign-in page is gated either way. `supabase/config.toml` sets the same thing for local dev and CI.
   **Leave the Email provider itself enabled.** Turning that off stops magic links for every existing
   account too ("Email logins are disabled"). Only the sign-up toggle goes off.
   *Done for production on 2026-11-09 (`enable_signup = false`, checked: new addresses are refused).*
2. Leave `WAITLIST_ENABLED` unset (on). Set `OWNER_USER_ID` so `/admin/waitlist` opens for you, and
   `SITE_URL=https://lastten.org` so invites always link there.
3. Production mail (item 2 below) is needed for both sign-in links and the "you're in" email.
4. Approve people at **lastten.org/admin/waitlist**. Pressing Approve again on someone whose invite
   did not go out resends it. Since issue #95 the list shows only addresses confirmed from the
   "Confirm your place" email; it counts the unconfirmed, which are deleted after 7 days (30 if their email could not be sent). Its
   migrations `20261110000001` and `…0002` are additive, so apply them before the merge; apply
   `20261110000003_waitlist_confirm_backfill.sql` right **after** the deploy - within minutes, since
   it also matches rows the new code held back by the daily cap. It confirms anyone the old code
   added in between, who would otherwise be hidden and purged.
5. Issue #98: the sign-in email's design is Supabase's template, not app code, so it reaches
   production only by pushing it. **Never `supabase config push` the repo's `supabase/config.toml`
   to production**: it carries `site_url = "http://localhost:3000"`, localhost-only redirect URLs
   and no SMTP, and pushing it would send every magic link to localhost and stop sign-in. Instead:
   - make a scratch folder `<dir>` with `<dir>/supabase/config.toml` holding only
     `project_id = "storytime"` and the two `[auth.email.template.magic_link]` /
     `[auth.email.template.confirmation]` blocks copied from the repo, and copy
     `supabase/templates/` to `<dir>/supabase/templates/`. `content_path` resolves from `<dir>`
     (the `--workdir`), so `./supabase/templates/magic_link.html` finds the copy;
   - link it to production: `supabase link --project-ref <prod ref> --workdir <dir>` (check the
     org is "Last Ten StoryTime");
   - issue #101: the sign-in link is `{{ .SiteURL }}/auth/callback…`, so production's `site_url`
     must be `https://lastten.org`. Check it first: add `[auth]` `site_url = "https://lastten.org"`
     to the scratch config, push, and answer **no**. If the list does not name `site_url`,
     production already has it; remove the line again. If it does, stop: changing `site_url` is
     its own decision;
   - `supabase config push --workdir <dir>`. It prints the changes and asks before applying: the
     list must show only `mailer_subjects_*` and `mailer_templates_*`. Anything else, answer no.
   The CLI sends only the fields that differ from production and names each one before asking:
   the 2026-11-09 push of `enable_signup` by this method listed `auth.enable_signup [update]` and
   nothing else, and the 2026-11-10 SMTP push likewise; sign-in on lastten.org kept working after
   both. If the list ever names `site_url`, redirect URLs or anything outside the templates,
   answer no and paste the templates in Dashboard → Authentication → Email Templates instead. Re-run
   `pnpm tsx scripts/email-templates.ts` and push again whenever the layout or `EMAIL` copy
   changes. The waitlist emails need nothing: they deploy with the app.
6. Public launch: set `WAITLIST_ENABLED=false` and redeploy. Anyone can then create an account by email
   (the server creates it, so the dashboard toggle can stay off). **If Google sign-in is on**, also switch
   "Allow new users to sign up" back on: Supabase refuses new Google accounts while it is off.

## Not done yet — each one matters before telling families about it

1. **The production model key.** Until `ANTHROPIC_API_KEY` (Understudy) with `ANTHROPIC_BASE_URL`, `LIVE_API=1` and
   `GENERATION_ENABLED=true` are set and redeployed, the creator says new stories are paused. Set `UNDERSTUDY_PROJECT=storytime`
   at the same time, after creating that project and registering its workloads, so parent traffic does not mix with the evals.
2. **Sign-in email for the public.** Supabase's built-in mailer only delivers to members of
   the Supabase organisation and is rate-limited. Real families need custom SMTP (Resend) on
   lastten.org: SPF, DKIM and return-path DNS records, then Auth → SMTP settings.
3. **DNS.** At the registrar: `A  @  76.76.21.21` and `CNAME  www  cname.vercel-dns.com`.
4. **Send to Kindle.** Same SMTP provider; set the six variables above and
   `KINDLE_FROM_EMAIL=kindle@lastten.org`.
5. **Rate limiting.** The API limiter counts in process memory, so on serverless each
   instance has its own count. `RateLimitStore` in `lib/http/ratelimit.ts` is the seam for a
   shared store (Upstash).
6. **The database is on Supabase's free plan**: it pauses after about a week with no
   activity and has no backups. Moving to Pro is a plan change on the same project.
7. **Launch checklist** (`storytime-plan/IMPLEMENTATION_PLAN.md` §8): a live guardrail-corpus
   run within seven days, the writing model chosen from the bake-off, cost recorded for 20
   production stories, the reader tried on a real iPhone and Android phone.

## Checking a deployment

```
curl -sI https://lastten.org/ | grep -iE 'strict-transport|x-frame|content-security'
curl -s -o /dev/null -w '%{http_code}\n' https://lastten.org/api/quota    # 401 signed out
```

Then sign in, add a child, open the library. With generation paused the creator shows
"New stories are paused right now."

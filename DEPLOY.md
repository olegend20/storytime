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
| `ANTHROPIC_API_KEY` | The production key. **A placeholder until the owner sets it** |
| `LIVE_API` | Must be `1` in production for real model calls (unset means fixture replay) |
| `GENERATION_ENABLED` | The kill switch. `false` pauses new stories; saved ones still read |
| `NEXT_PUBLIC_API_MOCK`, `UI_MOCK_API` | **Must be unset in production.** Test-only: the first is inlined at build time and points the whole UI at `/api/mock/*` |
| `DAILY_BUDGET_USD` | Global daily spend cap (5) |
| `OWNER_USER_ID` | The owner's auth user id: unlocks `/admin` and the unlimited quota |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `KINDLE_FROM_EMAIL` | Send to Kindle. Unset = the feature says it is not set up, and the landing page does not mention it |

A changed variable takes effect on the **next deployment**, not instantly: after flipping the
kill switch or the budget cap, redeploy (`vercel redeploy <url>` or Deployments → Redeploy).
On Vercel that takes about a minute and needs no code change, which is what "without a
deploy" in the plan amounts to here; a running instance keeps the values it started with.

## Sign-in (Supabase Auth)

Site URL is `https://lastten.org`; allowed redirects are `lastten.org`, `www.lastten.org` and
the Vercel production URL. To change them, edit a config with only those keys and
`supabase config diff` / `supabase config push` (undeclared settings are left alone).

## Not done yet — each one matters before telling families about it

1. **The production Anthropic key.** Until `ANTHROPIC_API_KEY`, `LIVE_API=1` and
   `GENERATION_ENABLED=true` are set and redeployed, the creator says new stories are paused.
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

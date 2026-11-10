-- The waitlist (issue #92): lastten.org opens a few families at a time. A visitor leaves an
-- email address; the owner approves it at /admin/waitlist; only then can that address create
-- an account (app/api/auth/prepare/route.ts - Supabase's own sign-up is switched off, so the
-- server is the only way an account is made).
--
-- An adult's email address and nothing else: no name, no child, no tracking. Kept only to
-- say "your place is ready" and to let that address sign up.
--
-- Service role only: RLS on, no policies. The anon key cannot read who is waiting, and a
-- visitor cannot approve themselves.

create table waitlist (
  email       text primary key check (email = lower(email) and char_length(email) between 3 and 254),
  created_at  timestamptz not null default now(),
  -- Set by the owner. Null means still waiting.
  approved_at timestamptz,
  -- When the "your place is ready" email went out. Null with approved_at set means the owner
  -- has to tell them (mail not configured, or the send failed).
  invited_at  timestamptz
);

-- The owner page's two lists (lib/waitlist/store.ts listWaitlist).
create index waitlist_waiting_idx on waitlist (created_at) where approved_at is null;
create index waitlist_approved_idx on waitlist (approved_at desc) where approved_at is not null;

alter table waitlist enable row level security;
revoke all on waitlist from anon, authenticated;

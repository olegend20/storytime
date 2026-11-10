-- Double opt-in for the waitlist (issue #95): an address reaches the owner's list only after
-- its inbox confirms it, so bots and typos do not fill the list. Additive only: the code
-- before this migration keeps working against it.
--
-- The token itself is never stored, only its SHA-256 (lib/waitlist/confirm.ts): a leaked
-- table cannot confirm anyone.

alter table waitlist
  -- When the inbox confirmed (or the owner approved, which vouches for it). Null = unconfirmed.
  add column confirmed_at       timestamptz,
  -- SHA-256 (hex) of the one live confirmation token. Cleared when used.
  add column confirm_token_hash text,
  -- When the last confirmation email went out: the 24-hour resend limit and the 7-day expiry.
  add column confirm_sent_at    timestamptz;

-- Everyone who joined before confirmation existed stays on the list.
update waitlist set confirmed_at = coalesce(approved_at, created_at) where confirmed_at is null;

create unique index waitlist_confirm_token_idx on waitlist (confirm_token_hash)
  where confirm_token_hash is not null;

-- The owner's "waiting" list is now confirmed-and-unapproved.
drop index waitlist_waiting_idx;
create index waitlist_waiting_idx on waitlist (created_at)
  where approved_at is null and confirmed_at is not null;

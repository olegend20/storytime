-- Issue #95, from the reviewer on #96: the first migration (20261110000001) was applied to
-- production before the code that sends confirmation emails was deployed. Anyone who joined
-- in between was stored unconfirmed by the old code, was never emailed, and would be hidden
-- from the owner's list and later purged. They were told "You're on the list", so they are.
--
-- Apply AFTER the #95 code is live (DEPLOY.md, the waitlist, step 4). A row the new code made
-- has a confirmation email on record, or was held back seconds ago; `confirm_sent_at is null`
-- with no token picks out the old code's rows. On a fresh database this matches nothing.

update waitlist
   set confirmed_at = created_at
 where confirmed_at is null
   and approved_at is null
   and confirm_sent_at is null
   and confirm_token_hash is null
   and created_at < now() - interval '1 minute';

-- Issue #95, from code review: every public join runs the 7-day purge and counts the day's
-- confirmation emails. Partial indexes keep both off a full scan as the waitlist grows.

-- purgeUnconfirmed: unconfirmed, unapproved rows by age.
create index waitlist_unconfirmed_idx on waitlist (created_at)
  where confirmed_at is null and approved_at is null;

-- confirmEmailsSince: the daily cap's count.
create index waitlist_confirm_sent_idx on waitlist (confirm_sent_at)
  where confirm_sent_at is not null;

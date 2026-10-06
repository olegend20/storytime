-- Issue #32 rung 1: the mend call (a Haiku edit of the sentences that broke a hard rule) is
-- a logged purpose like every other model call.
alter table generation_logs drop constraint if exists generation_logs_purpose_check;
alter table generation_logs add constraint generation_logs_purpose_check check (purpose in (
  'normalize', 'factpack', 'factpack_review', 'write', 'rewrite', 'quality',
  'safety_review', 'bible_update', 'repair', 'mend', 'classify_input',
  'judge_score', 'judge_pairwise'
));

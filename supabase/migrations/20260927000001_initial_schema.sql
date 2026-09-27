-- StoryTime initial schema. IMPLEMENTATION_PLAN.md s3.
--
-- Children's data is deliberately minimal: first name, age, likes, notes, reading level.
-- There is no last_name, birthdate, photo or location column and there must never be one
-- (kickoff rule 7). F11 VT asserts their absence.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- families
create table families (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null default 'My family' check (char_length(display_name) <= 60),
  timezone text not null default 'UTC',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One family per user (F2 AC: re-login never creates a second family).
create unique index families_owner_user_id_key on families (owner_user_id);

-- ---------------------------------------------------------------- children
create table children (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families (id) on delete cascade,
  first_name text not null check (char_length(first_name) between 1 and 30),
  age int not null check (age between 1 and 17),
  likes text[] not null default '{}' check (array_length(likes, 1) is null or array_length(likes, 1) <= 10),
  notes text check (char_length(notes) <= 300),
  reading_level text check (reading_level in ('younger', 'typical', 'older')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index children_family_id_idx on children (family_id);

-- ---------------------------------------------------------------- series
create table series (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families (id) on delete cascade,
  child_ids uuid[] not null,
  child_key text not null,
  title text check (char_length(title) <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A series is keyed by the EXACT set of children: "Cruz + Phoenix" and "Lennon"
  -- are different series with different recurring characters (s3).
  unique (family_id, child_key)
);
create index series_family_id_idx on series (family_id);

-- ---------------------------------------------------------------- story_bibles
create table story_bibles (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null unique references series (id) on delete cascade,
  family_id uuid not null references families (id) on delete cascade,
  version int not null default 1,
  content jsonb not null,
  token_estimate int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index story_bibles_family_id_idx on story_bibles (family_id);

-- ---------------------------------------------------------------- fact_packs
-- Shared globally: built once per topic, read by every family. This is what makes
-- research cost scale with the topic library rather than with stories generated.
create table fact_packs (
  id uuid primary key default gen_random_uuid(),
  topic_key text not null unique,
  topic_label text not null,
  content jsonb not null,
  sources jsonb not null default '[]'::jsonb,
  model text not null,
  version int not null default 1,
  use_count int not null default 0,
  quality_score numeric,
  status text not null default 'building' check (status in ('ready', 'building', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index fact_packs_status_idx on fact_packs (status);
create index fact_packs_use_count_idx on fact_packs (use_count desc);

-- ---------------------------------------------------------------- stories
create table stories (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families (id) on delete cascade,
  series_id uuid not null references series (id) on delete cascade,
  topic_input text not null,
  topic_key text not null,
  fact_pack_id uuid references fact_packs (id) on delete set null,
  tones text[] not null default '{}',
  length_minutes int not null check (length_minutes in (5, 10, 15)),
  age_band text not null check (age_band in ('A', 'B', 'C', 'D')),
  title text not null,
  content jsonb not null,
  word_count int not null default 0,
  quality jsonb not null default '{}'::jsonb,
  status text not null default 'ready' check (status in ('ready', 'flagged', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index stories_family_id_created_idx on stories (family_id, created_at desc);
create index stories_series_id_created_idx on stories (series_id, created_at desc);
create index stories_topic_key_idx on stories (topic_key);

-- ---------------------------------------------------------------- generation_logs
-- Service role only. family_id is nullable so account deletion can anonymize rows
-- while keeping the cost history (F2 AC).
create table generation_logs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references families (id) on delete set null,
  story_id uuid references stories (id) on delete set null,
  fact_pack_id uuid references fact_packs (id) on delete set null,
  purpose text not null check (purpose in (
    'normalize', 'factpack', 'factpack_review', 'write', 'rewrite', 'quality',
    'safety_review', 'bible_update', 'repair', 'classify_input',
    'judge_score', 'judge_pairwise'
  )),
  model text not null,
  input_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric(10, 6) not null,
  latency_ms int,
  ok boolean not null default true,
  error text,
  created_at timestamptz not null default now()
);
create index generation_logs_created_idx on generation_logs (created_at desc);
create index generation_logs_purpose_idx on generation_logs (purpose);
create index generation_logs_story_id_idx on generation_logs (story_id);

-- ---------------------------------------------------------------- daily_usage
create table daily_usage (
  family_id uuid not null references families (id) on delete cascade,
  usage_date date not null,
  count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (family_id, usage_date)
);

-- ---------------------------------------------------------------- guardrail_events
-- GUARDRAILS.md s1.5: log every refusal, but never keep raw refused text beyond 24h.
create table guardrail_events (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references families (id) on delete set null,
  layer text not null check (layer in ('L1', 'L2', 'L3', 'L4')),
  category text not null,
  input_hash text not null,
  field text,
  raw_text text,
  created_at timestamptz not null default now()
);
create index guardrail_events_created_idx on guardrail_events (created_at desc);
create index guardrail_events_category_idx on guardrail_events (category);

-- ---------------------------------------------------------------- updated_at triggers
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'families', 'children', 'series', 'story_bibles',
    'fact_packs', 'stories', 'daily_usage'
  ]
  loop
    execute format(
      'create trigger %I_set_updated_at before update on %I
       for each row execute function set_updated_at()', t, t);
  end loop;
end;
$$;

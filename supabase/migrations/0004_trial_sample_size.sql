-- ============================================================================
-- Per-org trial sample size.
--
-- A trial run copies this many RANDOM records of each selected type. Default 3
-- so a customer can prove the tool works without a trial being useful as a way
-- to extract real data. A platform admin can raise it for a specific org (e.g.
-- to 5 or 10) when they want that customer to test more.
--
-- Run in the Supabase SQL Editor after 0003.
-- ============================================================================

alter table public.orgs
  add column if not exists trial_sample_size int not null default 3;

-- Keep it sane: 1..50.
alter table public.orgs
  drop constraint if exists orgs_trial_sample_size_range;
alter table public.orgs
  add constraint orgs_trial_sample_size_range
  check (trial_sample_size between 1 and 50);

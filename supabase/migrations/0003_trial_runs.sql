-- ============================================================================
-- Trial runs.
--
-- A "trial" run (mode = dry_run) copies 5 random real records of each selected
-- entity into the target system so a customer can see the result, then must
-- pay to unlock the full migration. Each org gets ONE trial by default; a
-- platform admin can grant more. This column tracks the remaining allowance.
--
-- Run this in the Supabase SQL Editor after 0001.
-- ============================================================================

alter table public.orgs
  add column if not exists trial_runs_remaining int not null default 1;

-- Atomically spend one trial. Returns true if the org may run a trial
-- (unlimited orgs always may; otherwise decrements when > 0). The conditional
-- update is race-safe: two concurrent callers cannot both take the last one.
create or replace function public.consume_trial_run(p_org_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  is_free boolean;
begin
  select unlimited into is_free from orgs where id = p_org_id;
  if coalesce(is_free, false) then
    return true;
  end if;

  update orgs
     set trial_runs_remaining = trial_runs_remaining - 1
   where id = p_org_id
     and trial_runs_remaining > 0;

  return found;
end;
$$;

revoke all on function public.consume_trial_run(uuid) from public, anon, authenticated;

-- Admin: grant N more trial runs to an org.
create or replace function public.grant_trial_runs(p_org_id uuid, p_count int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update orgs
     set trial_runs_remaining = trial_runs_remaining + greatest(1, p_count)
   where id = p_org_id;
end;
$$;

revoke all on function public.grant_trial_runs(uuid, int) from public, anon, authenticated;

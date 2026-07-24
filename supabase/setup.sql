-- ============================================================
-- AutoHalo — full schema. Paste this whole file into the
-- Supabase SQL Editor and click Run.
-- ============================================================

-- ============================================================================
-- AutoHalo — core schema
--
-- Design notes:
--  * Every tenant-owned row carries org_id. RLS is enforced on every table.
--  * Browser clients use the anon key and are constrained by RLS.
--  * The worker and webhooks use the service-role key, which bypasses RLS, so
--    they must filter by org_id explicitly. Helper views are not used for that
--    path on purpose — explicit is safer than implicit here.
--  * Platform admins are identified by profiles.is_platform_admin. They bypass
--    entitlement checks in application logic and RLS via is_platform_admin().
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type org_role         as enum ('owner', 'admin', 'member');
create type system_kind      as enum ('autotask', 'halo');
create type run_status       as enum ('draft', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled');
create type task_status      as enum ('pending', 'running', 'succeeded', 'failed', 'skipped');
create type run_mode         as enum ('dry_run', 'live');
create type entitlement_kind as enum ('single_run', 'admin_grant');
create type log_level        as enum ('debug', 'info', 'warn', 'error');

-- ---------------------------------------------------------------------------
-- Orgs, profiles, membership
-- ---------------------------------------------------------------------------
create table orgs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_at  timestamptz not null default now(),
  -- Set by an admin to let an org run migrations without buying entitlements.
  unlimited   boolean not null default false
);

create table profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  email              text not null,
  full_name          text,
  is_platform_admin  boolean not null default false,
  created_at         timestamptz not null default now()
);

create table memberships (
  org_id     uuid not null references orgs(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  role       org_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index memberships_user_idx on memberships (user_id);

-- ---------------------------------------------------------------------------
-- Connections — one row per PSA instance an org has linked.
--
-- Credentials are stored as an AES-256-GCM envelope in secret_ciphertext and
-- are NEVER selectable by the browser: the column-level grant below withholds
-- it from anon/authenticated, so even a policy mistake cannot leak it.
-- ---------------------------------------------------------------------------
create table connections (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  system            system_kind not null,
  label             text not null,
  -- Non-secret config: base urls, tenant name, zone info. Safe to show.
  config            jsonb not null default '{}'::jsonb,
  secret_ciphertext text,
  secret_iv         text,
  secret_tag        text,
  key_version       int not null default 1,
  last_verified_at  timestamptz,
  last_verify_error text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index connections_org_idx on connections (org_id);

-- ---------------------------------------------------------------------------
-- Entitlements — a purchase (or admin grant) that permits one migration run.
-- ---------------------------------------------------------------------------
create table entitlements (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references orgs(id) on delete cascade,
  kind                      entitlement_kind not null default 'single_run',
  -- Consumed when a run transitions out of draft. Null while unused.
  consumed_by_run_id        uuid,
  consumed_at               timestamptz,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id  text,
  amount_total              int,
  currency                  text,
  granted_by                uuid references profiles(id),
  note                      text,
  created_at                timestamptz not null default now()
);

create index entitlements_org_unused_idx
  on entitlements (org_id)
  where consumed_by_run_id is null;

-- ---------------------------------------------------------------------------
-- Migration runs
-- ---------------------------------------------------------------------------
create table migration_runs (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references orgs(id) on delete cascade,
  created_by         uuid references profiles(id),
  source_connection  uuid not null references connections(id) on delete restrict,
  target_connection  uuid not null references connections(id) on delete restrict,
  direction          text not null,          -- 'autotask_to_halo' | 'halo_to_autotask'
  mode               run_mode not null default 'dry_run',
  status             run_status not null default 'draft',
  -- Which entity types the user selected, plus per-entity options.
  selection          jsonb not null default '{}'::jsonb,
  -- Rolling counters so the dashboard does not have to aggregate run_tasks.
  stats              jsonb not null default '{}'::jsonb,
  error              text,
  started_at         timestamptz,
  finished_at        timestamptz,
  -- Advisory lease so only one worker processes a run at a time.
  leased_until       timestamptz,
  lease_holder       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index migration_runs_org_idx on migration_runs (org_id, created_at desc);
create index migration_runs_claimable_idx
  on migration_runs (status, leased_until)
  where status in ('queued', 'running');

alter table entitlements
  add constraint entitlements_run_fk
  foreign key (consumed_by_run_id) references migration_runs(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Run tasks — the work queue. One row per (run, entity, phase).
--
-- The engine processes a task in time-boxed slices, persisting `cursor` after
-- each slice, so a run survives function timeouts and cold starts.
-- ---------------------------------------------------------------------------
create table run_tasks (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references migration_runs(id) on delete cascade,
  org_id         uuid not null references orgs(id) on delete cascade,
  entity         text not null,
  phase          text not null default 'copy',
  -- Lower runs first. Encodes the dependency order (companies before contacts…).
  seq            int not null,
  status         task_status not null default 'pending',
  cursor         jsonb,
  processed      int not null default 0,
  created_count  int not null default 0,
  updated_count  int not null default 0,
  skipped_count  int not null default 0,
  failed_count   int not null default 0,
  total_estimate int,
  attempts       int not null default 0,
  last_error     text,
  next_attempt_at timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  updated_at     timestamptz not null default now(),
  unique (run_id, entity, phase)
);

create index run_tasks_run_idx on run_tasks (run_id, seq);
create index run_tasks_pending_idx on run_tasks (run_id, status, seq)
  where status in ('pending', 'running');

-- ---------------------------------------------------------------------------
-- id_map — the heart of idempotency and of "and back again".
--
-- Records that source record X in system A became record Y in system B for a
-- given org. Re-running a migration therefore updates instead of duplicating,
-- and a reverse migration can recognise records it already owns.
-- ---------------------------------------------------------------------------
create table id_map (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  entity         text not null,
  source_system  system_kind not null,
  source_id      text not null,
  target_system  system_kind not null,
  target_id      text not null,
  -- Hash of the payload last written, so unchanged records can be skipped.
  content_hash   text,
  run_id         uuid references migration_runs(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, entity, source_system, source_id, target_system)
);

create index id_map_reverse_idx on id_map (org_id, entity, target_system, target_id);

-- ---------------------------------------------------------------------------
-- Run logs — append-only, shown live in the UI.
-- ---------------------------------------------------------------------------
create table run_logs (
  id         bigserial primary key,
  run_id     uuid not null references migration_runs(id) on delete cascade,
  org_id     uuid not null references orgs(id) on delete cascade,
  level      log_level not null default 'info',
  entity     text,
  message    text not null,
  context    jsonb,
  created_at timestamptz not null default now()
);

create index run_logs_run_idx on run_logs (run_id, id desc);

-- ---------------------------------------------------------------------------
-- Failed records — every individual record that could not be written, with
-- enough detail to fix and retry without re-running the whole migration.
-- ---------------------------------------------------------------------------
create table run_failures (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references migration_runs(id) on delete cascade,
  org_id      uuid not null references orgs(id) on delete cascade,
  entity      text not null,
  source_id   text,
  source_name text,
  error       text not null,
  payload     jsonb,
  resolved    boolean not null default false,
  created_at  timestamptz not null default now()
);

create index run_failures_run_idx on run_failures (run_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Stripe webhook idempotency
-- ---------------------------------------------------------------------------
create table stripe_events (
  id           text primary key,
  type         text not null,
  processed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Helper functions used by RLS. SECURITY DEFINER + a pinned search_path so a
-- caller cannot shadow the tables these read.
-- ---------------------------------------------------------------------------
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.is_platform_admin from profiles p where p.id = auth.uid()),
    false
  );
$$;

create or replace function public.is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from memberships m
    where m.org_id = target_org and m.user_id = auth.uid()
  ) or public.is_platform_admin();
$$;

create or replace function public.is_org_admin(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from memberships m
    where m.org_id = target_org
      and m.user_id = auth.uid()
      and m.role in ('owner', 'admin')
  ) or public.is_platform_admin();
$$;

-- ---------------------------------------------------------------------------
-- Auto-provisioning: a new auth user gets a profile, an org, and ownership.
-- Runs as the auth trigger so it must be SECURITY DEFINER.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_org_id uuid;
  base_slug  text;
  final_slug text;
  suffix     int := 0;
  org_label  text;
begin
  insert into profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;

  -- Name the org after the company field if supplied at signup, else the
  -- email domain, else the local part. Keeps auto-provisioned orgs legible.
  org_label := coalesce(
    nullif(new.raw_user_meta_data ->> 'company', ''),
    nullif(split_part(new.email, '@', 2), ''),
    split_part(new.email, '@', 1)
  );

  base_slug := regexp_replace(lower(org_label), '[^a-z0-9]+', '-', 'g');
  base_slug := trim(both '-' from base_slug);
  if base_slug = '' then
    base_slug := 'org';
  end if;

  final_slug := base_slug;
  while exists (select 1 from orgs o where o.slug = final_slug) loop
    suffix := suffix + 1;
    final_slug := base_slug || '-' || suffix::text;
  end loop;

  insert into orgs (name, slug) values (org_label, final_slug)
  returning id into new_org_id;

  insert into memberships (org_id, user_id, role)
  values (new_org_id, new.id, 'owner');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger connections_touch     before update on connections     for each row execute function public.touch_updated_at();
create trigger migration_runs_touch  before update on migration_runs  for each row execute function public.touch_updated_at();
create trigger run_tasks_touch       before update on run_tasks       for each row execute function public.touch_updated_at();
create trigger id_map_touch          before update on id_map          for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table orgs           enable row level security;
alter table profiles       enable row level security;
alter table memberships    enable row level security;
alter table connections    enable row level security;
alter table entitlements   enable row level security;
alter table migration_runs enable row level security;
alter table run_tasks      enable row level security;
alter table id_map         enable row level security;
alter table run_logs       enable row level security;
alter table run_failures   enable row level security;
alter table stripe_events  enable row level security;

-- orgs
create policy orgs_select on orgs for select
  using (public.is_org_member(id));
create policy orgs_update on orgs for update
  using (public.is_org_admin(id)) with check (public.is_org_admin(id));

-- profiles: you see yourself; admins see everyone.
create policy profiles_select on profiles for select
  using (id = auth.uid() or public.is_platform_admin());
create policy profiles_update_self on profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- memberships
create policy memberships_select on memberships for select
  using (public.is_org_member(org_id));
create policy memberships_write on memberships for all
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

-- connections
create policy connections_select on connections for select
  using (public.is_org_member(org_id));
create policy connections_write on connections for all
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

-- entitlements are read-only to members; only Stripe webhooks and platform
-- admins (service role) create them.
create policy entitlements_select on entitlements for select
  using (public.is_org_member(org_id));

-- runs and their children
create policy runs_select on migration_runs for select
  using (public.is_org_member(org_id));
create policy runs_write on migration_runs for all
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));

create policy run_tasks_select on run_tasks for select
  using (public.is_org_member(org_id));
create policy id_map_select on id_map for select
  using (public.is_org_member(org_id));
create policy run_logs_select on run_logs for select
  using (public.is_org_member(org_id));
create policy run_failures_select on run_failures for select
  using (public.is_org_member(org_id));

-- stripe_events: service role only. No policies means no access for anyone else.

-- ---------------------------------------------------------------------------
-- Column-level hardening: withhold ciphertext columns from client roles.
-- The service role is unaffected (it bypasses RLS and column grants).
-- ---------------------------------------------------------------------------
revoke all on connections from anon, authenticated;
grant select (
  id, org_id, system, label, config,
  last_verified_at, last_verify_error, created_at, updated_at
) on connections to authenticated;
grant insert, update, delete on connections to authenticated;

-- ---------------------------------------------------------------------------
-- Atomic entitlement consumption.
--
-- Claims one unused entitlement for the org and binds it to the run in a
-- single statement, so two concurrent run-starts cannot spend the same one.
-- Returns true when the run may proceed (admin/unlimited orgs always may).
-- ---------------------------------------------------------------------------
create or replace function public.consume_entitlement(p_org_id uuid, p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed uuid;
  is_free boolean;
begin
  select o.unlimited into is_free from orgs o where o.id = p_org_id;
  if coalesce(is_free, false) then
    return true;
  end if;

  -- Already paid for on a previous attempt at this same run.
  if exists (select 1 from entitlements e where e.consumed_by_run_id = p_run_id) then
    return true;
  end if;

  update entitlements
     set consumed_by_run_id = p_run_id,
         consumed_at        = now()
   where id = (
     select e.id
       from entitlements e
      where e.org_id = p_org_id
        and e.consumed_by_run_id is null
      order by e.created_at
      for update skip locked
      limit 1
   )
  returning id into claimed;

  return claimed is not null;
end;
$$;

revoke all on function public.consume_entitlement(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Worker lease: claim the next runnable run without two workers colliding.
-- ---------------------------------------------------------------------------
create or replace function public.claim_run(p_holder text, p_lease_seconds int default 120)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  update migration_runs
     set leased_until = now() + make_interval(secs => p_lease_seconds),
         lease_holder = p_holder,
         status       = 'running',
         started_at   = coalesce(started_at, now())
   where id = (
     select r.id
       from migration_runs r
      where r.status in ('queued', 'running')
        and (r.leased_until is null or r.leased_until < now())
      order by r.created_at
      for update skip locked
      limit 1
   )
  returning id into claimed_id;

  return claimed_id;
end;
$$;

revoke all on function public.claim_run(text, int) from public, anon, authenticated;

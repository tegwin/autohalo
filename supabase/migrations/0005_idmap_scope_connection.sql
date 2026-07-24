-- ============================================================================
-- Scope id_map to the target connection.
--
-- id_map records "source record X became target record Y". It was keyed by
-- target *system* (halo/autotask), not target *connection*. So if an org runs
-- migrations against two different Halo instances, the mappings from the first
-- get reused against the second — and those ids do not exist there, producing
-- Halo "Record not found" errors on every write.
--
-- Adding target_connection to the key gives each connection its own clean
-- mapping namespace. Existing rows keep target_connection = NULL and simply
-- stop matching the new, connection-scoped lookups — a clean slate per
-- connection without a manual reset.
--
-- Run in the Supabase SQL Editor after 0004.
-- ============================================================================

alter table public.id_map
  add column if not exists target_connection uuid references connections(id) on delete cascade;

-- Drop whatever single unique constraint exists on id_map (auto-named), then
-- recreate it including target_connection.
do $$
declare c text;
begin
  select conname into c
    from pg_constraint
   where conrelid = 'public.id_map'::regclass and contype = 'u'
   limit 1;
  if c is not null then
    execute 'alter table public.id_map drop constraint ' || quote_ident(c);
  end if;
end $$;

create unique index if not exists id_map_scoped_unique
  on public.id_map (org_id, entity, source_system, source_id, target_system, target_connection);

create index if not exists id_map_target_conn_idx
  on public.id_map (org_id, entity, target_system, target_connection);

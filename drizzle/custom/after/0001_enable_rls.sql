-- Runs AFTER every schema push and migration (scripts/db-custom.ts --after). Idempotent.
-- The CRM connects to Postgres directly as the owner of these tables. On Supabase, the Data API (anon and
-- authenticated keys) can also reach the public schema; row level security with no policies shuts that door
-- without affecting the owner (owners bypass RLS unless it is forced). Harmless on plain Postgres.
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' and not rowsecurity loop
    execute format('alter table public.%I enable row level security', r.tablename);
  end loop;
end $$;

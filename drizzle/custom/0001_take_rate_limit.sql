-- Per-user lookup limits (src/lib/auth/rate-limit.ts, takeRateLimit): counts one lookup for a subject when it is
-- under the limit, race-safe, in ONE statement. Idempotent; safe to run before the tables exist (PL/pgSQL looks the
-- table up on the first call, not here).
--
-- Why a function: lookups sent at the same moment must take turns, or they all count the same rows and overshoot
-- the limit. A transaction-scoped advisory lock per bucket and subject does that, but taken by the app as a
-- statement of its own it would be held across network round trips (BEGIN, lock, count, COMMIT), and every lookup
-- waiting for it would hold a pooled connection meanwhile. Here the lock, the count and the insert run on the
-- server in one call: an autocommit call holds the lock only while the server runs it. Inside a caller's
-- transaction the lock lasts until that transaction ends.
--
-- VOLATILE: each statement inside takes a fresh snapshot (READ COMMITTED), so the count, which runs after the lock
-- is granted, sees every lookup committed by the call that held it before.
--
-- Returns the number of lookups counted in the window BEFORE this one (counted < p_max means this one was counted)
-- and the oldest of them (when the next slot frees up). A refused lookup is not recorded.
create or replace function public.edapt_take_rate_limit(
  p_bucket text,
  p_subject text,
  p_max integer,
  p_since timestamptz,
  p_now timestamptz,
  out counted integer,
  out oldest timestamptz
)
language plpgsql
volatile
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('edapt:rate:' || p_bucket || ':' || p_subject));
  select count(*)::integer, min(h.created_at)
    into counted, oldest
    from public.rate_limit_hits h
    where h.bucket = p_bucket and h.subject = p_subject and h.created_at > p_since;
  if counted < p_max then
    insert into public.rate_limit_hits (bucket, subject, created_at) values (p_bucket, p_subject, p_now);
  end if;
end
$$;

-- Only the CRM calls it (it connects as the owner, who keeps the right to run it). On Supabase the Data API would
-- otherwise offer every public function as an RPC to the anon and authenticated keys.
revoke all on function public.edapt_take_rate_limit(text, text, integer, timestamptz, timestamptz) from public;
do $$
declare r text;
begin
  for r in select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role') loop
    execute format('revoke all on function public.edapt_take_rate_limit(text, text, integer, timestamptz, timestamptz) from %I', r);
  end loop;
end $$;

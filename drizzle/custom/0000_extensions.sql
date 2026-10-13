-- Runs BEFORE every schema push (npm run db:push, the test and e2e setups) and before the generated migrations
-- (npm run db:migrate): Drizzle cannot create extensions, and src/db/schema.ts has indexes that need them.
-- Every statement here must be idempotent. On Supabase, pg_trgm can also be enabled from Database > Extensions
-- (it then lives in the "extensions" schema, which is on the default search_path); this file is then a no-op.

-- trigram indexes for the Contacts search (contacts_name_trgm_idx, contacts_email_trgm_idx, contacts_phone_trgm_idx)
create extension if not exists pg_trgm;

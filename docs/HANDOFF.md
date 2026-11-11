# Handoff: state of the build (10 Nov 2026)

Read this first when you pick up the work in a new conversation, then `CLAUDE.md` (conventions) and the parts of
`docs/SPEC.md` your task touches. No secrets are written here: passwords and keys live in Vercel and Supabase only.

## Where everything is

| What | Where |
| --- | --- |
| Code | GitHub `matrixpkd/edaptcrm`, branch `claude/edapt-logo-x4jtjq` (the only branch, and the default). Every push to it deploys to production. On the owner's Mac, `gh` is signed in as `matrixpkd` (since 9 Nov), which can push; its other login, `youmeareorg-create`, is read-only. |
| Live app | https://edaptcrm.vercel.app (first admin: umertabdussalam@gmail.com) |
| Hosting | Vercel project `edaptcrm`, team `edapt4`, Hobby plan, functions in `sin1` (`vercel.json`) |
| Database | Supabase project "matrixpkd's Project", ref `alseppmrzbnyxpwjwhss`, region ap-southeast-1 (Singapore; the spec asked for Mumbai, see README "Deploy") |
| 15-minute jobs | Supabase pg_cron + pg_net call `/api/cron/*` (`npm run cron:schedule`; Vault secrets `edapt_crm_url`, `edapt_cron_secret`). Vercel Cron runs the daily `nightly` and weekly `weekly` jobs (`vercel.json`). |
| Error log | Table `app_errors`, shown under Settings → Error log (server and browser errors) |

Vercel environment variables (names only): `DATABASE_URL`, `DATABASE_POOL_MAX` (to delete, below), `APP_URL`,
`CRON_SECRET`, the webhook secrets, `SUPABASE_URL`, `SUPABASE_STORAGE_BUCKET`; optional `ANTHROPIC_API_KEY`,
`RESEND_API_KEY`, `EMAIL_FROM`. README "Deploy" lists what each one is for.

## How the app reaches the database

`src/db/connection.ts` and `src/db/pool.ts`. node-postgres through Supabase's **transaction** pooler (port 6543; a
session-pooler URL on 5432 is moved there automatically). The session pooler admits only 15 clients and took the whole
site down on 18 Oct. On Vercel each instance keeps one connection; a full pooler (EMAXCONN) is retried for about 4 s;
`attachDatabasePool` closes idle connections before an instance is suspended. Read raw SQL rows with `queryRows(sql, tx)`.

Last verified on the live site (21 Oct, version `56d41a4`): all 32 screens load, 90 requests sent at once all
succeed, and `/api/health?deep=1` (needs `Authorization: Bearer <CRON_SECRET>`) is fine. `/api/health` shows the
deployed commit. On 30 Oct `/api/health` was ok on `b20b980` and the 15-minute pg_cron job had no failures.
On 9 Nov `4f626e0` went live: `/api/health` ok, the sign-in page loads, signed-in pages redirect to it, and
`app_errors` had no rows in the last 24 hours. On 10 Nov `3d4ce53` (Next 15.5.29 and the round-robin fix) went
live and passed the same checks; the 15-minute pg_cron job had no failures in the 2 hours before.

Locally (11 Nov, macOS, Next 15.5.29, after the access fixes): 1,119 unit/integration tests pass with no errors
on Node 24 (what Vercel runs) and Node 22, 105 Playwright tests pass (1 phone run skipped by design), and the perf
bench's 82 scenarios are all within budget at 50,000 contacts. Check
Vitest's summary for an "Errors" line too: an unhandled rejection fails the run even when every test passes.
macOS setup: Homebrew `postgresql@16` (started with `pg_ctl -D /opt/homebrew/var/postgresql@16 start`, role
`postgres`/`postgres` added) and `node@24` / `node@22` from Homebrew on PATH (the default Node 20 cannot run Vitest 5).
Production runs Postgres 17.11 (checked 10 Nov); `postgresql@17` is also installed from Homebrew for checking
database behaviour on that version (point `TEST_DATABASE_URL` at a 17 server). On 10 Nov the live database had no
active salesperson, so every new lead went to the unassigned pool.

## Open items

**Schema changes reach production before the code.** A push deploys the code but runs no migration, and new code
that reads a missing column breaks sign-in and every page. So: `npm run db:generate` at release, commit the migration,
apply it to Supabase, then push. Keep migrations additive so the version still live keeps working while Vercel builds
the new one. Two ways to apply one:
- `npm run db:migrate` from the laptop with a *session* connection string (README "Deploy", step 2). It also runs
  `drizzle/custom/*.sql` before and `drizzle/custom/after/*.sql` after.
- Without the password, through the Supabase connector, in ONE transaction: the migration's SQL; the row Drizzle
  records for it, `insert into drizzle.__drizzle_migrations (hash, created_at) values ('<sha256 of the .sql
  file>', <its "when" in drizzle/meta/_journal.json>)`, so a later `db:migrate` does not run it again (production had
  0000–0002 recorded on 10 Nov); and the body of `drizzle/custom/after/0001_enable_rls.sql`. That last part matters:
  it turns on row level security for new tables, which shuts the Supabase Data API (anon key) out of them; nothing
  else does. Then check: `select tablename from pg_tables where schemaname = 'public' and not rowsecurity` must
  return no rows. Run any new or changed `drizzle/custom/*.sql` file in the same transaction (they are idempotent).
`drizzle/0003_access_controls.sql` (10 Nov) adds `users.password_temporary_until` and the table `rate_limit_hits`,
and the code released with it calls the function `edapt_take_rate_limit` from `drizzle/custom/0001_take_rate_limit.sql`
(11 Nov): without it every Quick Add duplicate check and Edit page number check fails. Before 0003's row, check the
last recorded migration is 0002 (`select max(created_at) from drizzle.__drizzle_migrations` = 1792079207765). In the
same transaction, after 0003, give admin-issued passwords from before it an expiry (0 rows when there are none;
safe to run again later, since anyone who has chosen their own since is skipped):
```sql
with latest as (
  select distinct on (a.row_id) a.row_id, a.action, a.field, a.new_value
  from audit_log a
  where a.table_name = 'users'
    and ((a.action = 'insert' and a.field is null)
      or (a.action = 'create' and a.field = 'first_admin')
      or (a.action = 'update' and a.field = 'password'))
  order by a.row_id, a.id desc
)
update users u set password_temporary_until = now() + interval '7 days'
from latest l
where l.row_id = u.id::text and u.password_temporary_until is null
  and (l.action = 'insert' or (l.field = 'password' and l.new_value = '"reset"'::jsonb))
returning u.id;
```
Check after applying: `select 1 from information_schema.columns where table_name = 'users' and column_name =
'password_temporary_until'` returns a row, and `select * from edapt_take_rate_limit('release-check', 'x', 0, now(),
now())` returns one row (with a limit of 0 it records nothing; it proves the function runs for the app's role).

Owner actions (outside the code):
1. Vercel → Settings → Environment Variables: **delete `DATABASE_POOL_MAX`** (it is 3; unset means 1 per instance,
   which leaves more room under load) and **add `SUPABASE_SERVICE_ROLE_KEY`** (file uploads need it).
2. Rotate the Supabase database password (it was shared in a chat), then update `DATABASE_URL` in Vercel.
3. Connect the Supabase and Vercel connectors in the Claude account that continues the work. On 30 Oct Supabase
   worked; Vercel could read the project but refused calls naming team `edapt4` (logs, runtime errors) until the team
   access request is approved (still refused on 9 Nov; GitHub's commit status shows each Vercel build meanwhile).
4. Vercel project `edaptcrm-ew63` is a second copy linked to the same repository; every build there fails. Delete it
   if it is not needed (the live site is project `edaptcrm`).
5. Vercel → `edaptcrm` → Settings → Deployment Protection: turn on Vercel Authentication with **Standard
   Protection**. On 10 Nov it was off: every older production deployment answers publicly on its own
   `*-edapt4.vercel.app` address, still running the Next.js version it was built with (15.5.27 and older, open to
   the denial of service above). Standard Protection leaves `edaptcrm.vercel.app` public, which is what users,
   webhooks and the pg_cron job (`edapt_crm_url`) call; nothing in the code uses `VERCEL_URL`.

Security: `next` is on 15.5.29 (10 Nov), which fixes GHSA-2464-fhr4-w9xw (image optimiser with SVGs; the app was
not really exposed: no images config, and Vercel serves `/_next/image`) and GHSA-p3m5-59mp-jv5r (a CPU denial of
service reachable through the public sign-in action). `npm audit` still lists `next` as moderate for its own postcss
8.4.31, which runs only at build time on our CSS (docs/SECURITY.md). Other audit items, not yet looked at: `zod` 4.1
inside `@vercel/functions` → `@vercel/oidc` (high), `minimatch` in the lint tooling, `esbuild` in `drizzle-kit`
(dev only), `uuid` in `exceljs`.

Product notes from the last QA pass, not yet changed (each needs a decision, not just code):
- Logging a support issue moves a lead to Contacted.
- A manually recorded payment counts as self-serve (no sales call) unless a call is logged.
- WhatsApp on the contact page takes two taps (a message template picker opens first).

Access gaps still open (from the 10 Nov access review and the review of its fixes; the ones fixed are under
Technical notes):
- Accounts: reactivating someone brings back their old password; changing your own password has no attempt limit;
  a user's email cannot be changed; the temporary password travels inside the WhatsApp invite link; `npm run
  db:seed` can add an admin with no audit row; a password typed with a space at either end can leak, by timing,
  whether the email has an account; an admin can deactivate their own account through a hand-made request with
  their id in capitals (`deactivateUser` compares ids before the lock; the last-admin check still holds).
- Leads and alerts: a new Sales account goes to the front of the round robin (on 10 Nov production had none); the
  first active manager silently takes over manager alerts from the admins.
- What sales can reach: linking a referrer by phone says whether any number is in the CRM (counted against the
  lookup limit); the Referrals tab's network value can reveal one hidden referral's LTV by subtraction
  (spec-defined total); the Edit page answers "You cannot edit this contact" for a colleague's contact (reveals only
  that the id exists). Support can open any purchase page read-only.
- Rules: sales can mark a pool contact Lost but not reopen it; approving a hand-over request does not re-check the
  requester still owns the contact; sales credit can go to a deactivated user; the organisation unlink ignores which
  organisation it came from; someone moved to Support keeps their open tasks; `audit.view` is never checked;
  integrations settings save outside a transaction; original import files download with no audit row; exports have
  no row cap.
- Spec versus code: a leaver's contacts go to anyone the admin picks (spec: the manager); managers have more rights
  than the spec's table (merge, refund, credit, edit any contact); production runs in Singapore on Vercel Hobby
  (spec: Mumbai, Pro). Erasure keeps the original import file, failed webhook payloads (for reprocessing) and the
  organisation link (hidden: the organisation no longer lists or counts the person). It also leaves: the rows of an
  import still at the mapping step (not cleaned yet, so they cannot be matched); another contact's import row that
  lists the person's number as that contact's own alternate; a referrer column naming the person on a row never
  committed; export audit rows whose saved search holds the name; an import row, webhook payload or purchase/enquiry
  payload that reached another contact through the person's number while the two were merged (merge later undone).
  Committing an import that was in review during the erasure, or re-uploading the kept original file, brings the
  person back as a new contact: there is no do-not-recreate list. An import commit or undo running at the very
  moment of an erasure can write that row's warnings or before/after values back (it read them first). All of these
  were also true before 11 Nov.

Technical notes:
- Access controls tightened on 10–11 Nov (from an access review of every role, then an independent review of those
  fixes; what is still open is under "Access gaps still open" above):
  - Temporary passwords (`src/lib/auth/temporary-password.ts`): a password an admin issues (Add teammate, Reset
    password) works for 7 days (`TEMP_PASSWORD_DAYS`, a constant: the spec gives no number) and must be replaced on
    `/choose-password` at first sign-in. `users.password_temporary_until` holds the expiry; null means the person
    chose their own. Migration 0003 adds the column as null for every existing account, so a temporary password
    issued before it would never expire: at release, accounts whose latest password event in `audit_log` was
    admin-issued get an expiry 7 days out (the SQL is under Open items; on 11 Nov production had one user, the first
    admin, with no admin-issued password in its history, so it was expected to change 0 rows). The gate is in `src/lib/auth/session.ts`:
    `requireUser` sends such a session to `/choose-password`, and `getCurrentUser` / `getApiUser` return null for it,
    so pages, actions and API routes are all covered; sign-out still works. `createSession(userId, passwordHash)`
    opens a session only while that hash is still the person's password, so a sign-in racing a reset cannot
    outlive it. Deactivation voids open reset links. The demo seed clears the column for the demo team. An admin
    cannot reset their own password from the Team page (it signed them out before they saw the new one, and could
    lock out a sole admin); their own Team page links to Your account instead.
  - What a salesperson sees of contacts outside their own and the pool: the Quick Add check gives a colleague's
    contact's name and owner only (the spec wants those; stage and grade only for contacts they may open) and is
    limited to 300 lookups per person per 10 minutes (`QUICK_ADD_LOOKUP_LIMIT`, `src/lib/auth/rate-limit.ts`,
    table `rate_limit_hits`, pruned nightly); the Edit page's number checks, the referrer lookup included, count
    against the same limit and do not name a colleague's contact. Each lookup is one call to the SQL function
    `edapt_take_rate_limit` (`drizzle/custom/0001_take_rate_limit.sql`), which takes an advisory lock, counts and
    records on the server, so lookups sent at once cannot overshoot the limit and no pooled connection waits across a
    round trip (docs/PERFORMANCE.md, "The lookup limit"). Organisations show a salesperson only the people and deals of their own and pool
    contacts, a count of the others and no revenue totals. A pipeline drop (`src/lib/pipeline/move.ts`) or an
    organisation link on a colleague's contact answers like a missing contact. A contact's Referrals tab lists only
    the referred people they may open and counts the others; the "network value" total stays as the spec defines it.
    `canViewContactSql(user)` in `src/lib/auth/scope.ts` is the SQL twin of `canViewContact`.
  - Erasure (`src/lib/contacts/privacy.ts`): also removes payment proof files (unlinked in the transaction, deleted
    after the commit; a failed delete goes to the error log with source `erasure`), money rows' free text and the
    same text in their audit trail, typed owner-change reasons, and the erased name quoted on the referrer's "call to
    thank" task and "New lead" alert. Order ids, UTRs and amounts stay for the accounts. The erased contact is locked
    at the service layer (`assertNotErased`, `ContactErasedError`): no new edits, interactions, ratings, purchases,
    payments, tasks, owner changes or links, and its Edit / Log / Rate / Payment screens show a notice instead of a
    form. Money already recorded can still be verified, refunded, cancelled or re-credited (comment at the top of
    `src/lib/money/purchases.ts`). Since 11 Nov an erased contact also leaves every alert rule, Today, the digests
    and its organisation's people (a rule that read it just before the erasure committed closes what it raised); its
    import rows are wiped, including unlinked rows carrying its number or order id
    (`src/lib/import/erasure.ts`), while other contacts' rows keep their data and lose only the quote (so their
    import undo still works); and after a merge into another contact that was later undone, that contact's history
    no longer names it in the merge entry or holds its numbers and emails from while they were merged.
  - The weekly revenue summary and the VIP digest go to the owner (the earliest-created active admin,
    `ownerAdminId` in `src/lib/alerts/core.ts`) plus whoever is picked in Settings → Alerts, not to every admin.
  Tests: `tests/integration/temporary-password.test.ts`, `visibility.test.ts`, `beyond-spec.test.ts`,
  `erasure-webhook.test.ts`, `alerts-digest.test.ts`, `alerts-rules.test.ts`, `money-resolve-contact.test.ts`,
  `tests/unit/import-erasure.test.ts`, and e2e `team.spec.ts`,
  `auth.spec.ts`, `quick-add.spec.ts`, `scoping.spec.ts`, `notes-privacy.spec.ts`. The perf bench now also times
  the organisation screens and a salesperson's Referrals tab (all well inside budget at 50,000 contacts, and with
  one organisation of 2,000 people).
- Round robin (`pickAutoOwner`, `src/lib/contacts/assignment.ts`) had a race, fixed on 10 Nov. When four leads for
  one team arrived at the same moment, 1–3% of rounds gave one salesperson two and another none: under READ
  COMMITTED, `FOR UPDATE SKIP LOCKED` with `ORDER BY ... LIMIT 1` could lock someone a parallel pick had just
  assigned and committed, because Postgres re-checks the WHERE clause on the newest row, not the order. Each look is
  now a compare-and-set: it ranks the queue from its snapshot, locks the first free person `FOR NO KEY UPDATE`, and
  when that person's stamp has moved (or they are no longer active sales in the team) it rolls back its savepoint,
  which releases the lock, and looks again. 0 duplicates in 3,000 stress rounds on Postgres 16 and 17 (5–16 per 500
  before). `FOR NO KEY UPDATE` also stops picks skipping, or waiting for, a salesperson whom a parallel insert merely
  references (a notification, a task). Capture now locks an existing referrer's row before its pick (not for import
  rows, which recompute at the end of their chunk): that removed a deadlock between a referred lead and the
  referrer's own enquiry when every salesperson is busy. The doc comment states the rules, and "round robin and lock
  order under parallel captures" in `tests/integration/contacts-assignment.test.ts` replays each interleaving step
  by step (each test releases what it holds afterwards, so one failure does not hang the rest). Still open, rare
  and older than the fix: when every salesperson in a team is busy, a capture that picks twice (a new referrer plus
  the new lead), or an import chunk, can deadlock with another capture; Postgres cancels one after 1 s and that
  capture fails.
- Services run `Promise.all` on a transaction handle; pg@8 queues those (with a deprecation warning), pg@9 will not.
  Keep `pg` on `^8` until they run in turn.
- `src/components/shell/hydration-gate.tsx` works around a hydration bug in the React that ships with Next 15.5
  (intermittent error #418). Remove it once React 19.3 is in.
- The perf benches (`scripts/perf/bench.ts`, `scripts/bench-import.ts`) capture SQL through `__edaptQueryLog` in `src/db`.
- Toasts: the Toaster sits in its own Suspense boundary, which React hydrates last and not while an action is in
  flight. A tap before hydration is replayed and can answer before the Toaster listens, so `toast()`
  (`src/lib/toast-events.ts`) keeps that message for up to 10 s and the Toaster shows it when it starts listening.
  This fixed the intermittent "Linked to this organisation" failure in `tests/e2e/feedback.spec.ts` (8 in 30 runs
  before, none in 84 runs with the fix, 30 of them on the final version). `PaymentsToaster`/`announce()` is a
  separate copy that is not exposed to this race.
- Node 24's undici (7.x) writes an in-memory `FormData` request body from a loop that keeps going after the reader
  cancels, which leaves an unhandled "ReadableStream is already closed". A test that sends a form over a body cap
  must send it as bytes or a Node stream (as `tests/integration/security-auth.test.ts` does). Production is not
  affected: Next hands route handlers the network stream, and `next start` on Node 24 answered 2 MB webhook bodies
  with 413 and no error.

## Starting a new session

Suggested first message: "Read docs/HANDOFF.md and CLAUDE.md, then <task>. Run `npm run typecheck`, `npm run lint`,
`npm test` and `npm run test:e2e` before pushing: every push deploys to production." Local setup is in `CLAUDE.md`
(Commands) and README.

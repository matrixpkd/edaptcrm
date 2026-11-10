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

Locally (10 Nov, macOS, Next 15.5.29, after the round-robin fix): 1,053 unit/integration tests pass with no errors
on Node 24 (what Vercel runs) and Node 22, and 94 Playwright tests pass (1 phone run skipped by design). Check
Vitest's summary for an "Errors" line too: an unhandled rejection fails the run even when every test passes.
macOS setup: Homebrew `postgresql@16` (started with `pg_ctl -D /opt/homebrew/var/postgresql@16 start`, role
`postgres`/`postgres` added) and `node@24` / `node@22` from Homebrew on PATH (the default Node 20 cannot run Vitest 5).
Production runs Postgres 17.11 (checked 10 Nov); `postgresql@17` is also installed from Homebrew for checking
database behaviour on that version (point `TEST_DATABASE_URL` at a 17 server). On 10 Nov the live database had no
active salesperson, so every new lead went to the unassigned pool.

## Open items

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

Technical notes:
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

# Handoff: state of the build (9 Nov 2026)

Read this first when you pick up the work in a new conversation, then `CLAUDE.md` (conventions) and the parts of
`docs/SPEC.md` your task touches. No secrets are written here: passwords and keys live in Vercel and Supabase only.

## Where everything is

| What | Where |
| --- | --- |
| Code | GitHub `matrixpkd/edaptcrm`, branch `claude/edapt-logo-x4jtjq` (the only branch, and the default). Every push to it deploys to production. |
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

Locally (9 Nov, macOS): 1,046 unit/integration tests pass with no errors on Node 24 (what Vercel runs) and Node 22,
and 94 Playwright tests pass (1 phone run skipped by design). Check Vitest's summary for an "Errors" line too: an
unhandled rejection fails the run even when every test passes.
macOS setup: Homebrew `postgresql@16` (started with `pg_ctl -D /opt/homebrew/var/postgresql@16 start`, role
`postgres`/`postgres` added) and `node@24` / `node@22` from Homebrew on PATH (the default Node 20 cannot run Vitest 5).

## Open items

Owner actions (outside the code):
1. Vercel → Settings → Environment Variables: **delete `DATABASE_POOL_MAX`** (it is 3; unset means 1 per instance,
   which leaves more room under load) and **add `SUPABASE_SERVICE_ROLE_KEY`** (file uploads need it).
2. Rotate the Supabase database password (it was shared in a chat), then update `DATABASE_URL` in Vercel.
3. Connect the Supabase and Vercel connectors in the Claude account that continues the work. On 30 Oct Supabase
   worked; Vercel could read the project but refused calls naming team `edapt4` (logs, runtime errors) until the team
   access request is approved.
4. GitHub: the Mac's GitHub login `youmeareorg-create` has read-only access to `matrixpkd/edaptcrm`, so it cannot
   push. Add it as a collaborator with Write access (or sign the Mac in as `matrixpkd`).
5. Vercel project `edaptcrm-ew63` is a second copy linked to the same repository; every build there fails. Delete it
   if it is not needed (the live site is project `edaptcrm`).

Security: `next` 15.5.27 has a critical advisory (image optimisation with SVGs) and a high one (Server Actions
denial of service). The fix is 15.5.28, a patch release.

Product notes from the last QA pass, not yet changed (each needs a decision, not just code):
- Logging a support issue moves a lead to Contacted.
- A manually recorded payment counts as self-serve (no sales call) unless a call is logged.
- WhatsApp on the contact page takes two taps (a message template picker opens first).

Technical notes:
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

# Handoff: state of the build (29 Oct 2026)

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
deployed commit. Locally: 1,036 unit/integration tests and 94 Playwright tests pass.

## Open items

Owner actions (outside the code):
1. Vercel → Settings → Environment Variables: **delete `DATABASE_POOL_MAX`** (it is 3; unset means 1 per instance,
   which leaves more room under load) and **add `SUPABASE_SERVICE_ROLE_KEY`** (file uploads need it).
2. Rotate the Supabase database password (it was shared in a chat), then update `DATABASE_URL` in Vercel.
3. Connect the Supabase and Vercel connectors in the Claude account that continues the work. The Vercel connector of
   the previous account had lost access to team `edapt4`.

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

## Starting a new session

Suggested first message: "Read docs/HANDOFF.md and CLAUDE.md, then <task>. Run `npm run typecheck`, `npm run lint`,
`npm test` and `npm run test:e2e` before pushing: every push deploys to production." Local setup is in `CLAUDE.md`
(Commands) and README.

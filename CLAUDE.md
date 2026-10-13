# Edapt CRM — project brief

The full product spec is **docs/SPEC.md** ("Edapt CRM: Requirements and Build Spec"). It is the source of
truth for every rule, threshold, screen and formula. Read the sections relevant to your task before coding.
The CRM is Edapt's attention allocator: it decides who deserves a human, when, and with which offer.

## Stack

- Next.js 15 (App Router, Server Components, Server Actions), React 19, TypeScript strict, Tailwind CSS v4.
- Postgres (Supabase in production, Mumbai region) through Drizzle ORM (`postgres` driver, `prepare: false`).
- Auth: email + password (bcrypt), DB-backed sessions in the `sessions` table, cookie `edapt_session`.
- Files: `src/lib/storage.ts` (Supabase Storage when configured, `./uploads` in dev), served by `/api/files/<key>`.
- Email: `src/lib/email.ts` (Resend when `RESEND_API_KEY` is set, otherwise logged).
- AI import mapping: Claude API via `@anthropic-ai/sdk` (`ANTHROPIC_API_KEY`), with a heuristic fallback.
- Phone numbers: `libphonenumber-js/max` via `src/lib/phone.ts`.
- Tests: Vitest (unit + integration against a real local Postgres `edapt_test`), Playwright for e2e.

## Commands

```bash
service postgresql start          # local Postgres 16 (user postgres / password postgres)
createdb -h localhost -U postgres edapt        # once each: edapt (dev), edapt_test (npm test), edapt_e2e (e2e)
npm run dev                       # http://localhost:3000  (admin: umer@edapt.in / change-me-now after db:seed)
npm run db:push                   # sync src/db/schema.ts into the dev database (.env.local)
npm run db:seed                   # first admin + starter products  (add `-- --demo` for demo data)
npm run typecheck && npm run lint
npm test                          # vitest; global setup pushes the schema into edapt_test (TEST_DATABASE_URL overrides)
npm run test:e2e                  # playwright
```

## Layout

```
src/db/schema.ts          all tables + shared value types (Role, Stage, TaskType, ...)
src/db/index.ts           `db` and the `Tx` type (a db handle or an open transaction)
src/lib/settings/         every configurable list/weight/threshold with spec defaults; getSetting()/setSetting()
src/lib/auth/             session.ts (requireUser, getCurrentUser), permissions.ts (can()), scope.ts (contactScope)
src/lib/phone.ts          normalizePhone(), formatPhone(), whatsappLink(), telLink()
src/lib/audit.ts          audit(), auditDiff()
src/lib/contacts/         identity, capture (single entry for every inbound touch), assignment, ownership, stage, merge, profile
src/lib/money/            fx, purchases, payments, refunds, verification, sales credit, LTV facts
src/lib/metrics/          scoring, repeat/cohorts, next best offer, recompute (the one place calculated columns are written)
src/lib/alerts/           tasks + notifications helpers, alert rules, digests
src/lib/import/           import wizard pipeline
src/lib/webhooks/         TagMango, Libromi, Pabbly handlers
src/components/ui/        UI kit (Button, Field, Input, Select, Card, Badge, GradeBadge, StageBadge, Tabs, Table, ChipGroup, StarInput, Sheet, SubmitButton)
src/components/shell/     AppShell (sidebar on desktop, bottom bar on phones), nav config
src/app/(auth)/           login, setup (first admin); actions.ts has login, logout and setup
src/app/(app)/            every signed-in screen
src/app/api/              webhooks/*, cron/*, files/*, export/*, health
tests/unit, tests/integration, tests/e2e, tests/support (resetDb, makeUser)
```

## Conventions (follow these exactly)

- **Server Components by default.** Mark client components with `"use client"` and keep them small. Never import
  `@/db`, `@/lib/settings` (index), `@/lib/auth/session` or anything with `import "server-only"` from a client component.
- **Mutations are Server Actions** in a colocated `actions.ts` (`"use server"`). Every action starts with
  `const user = await requireUser()` and checks `can(user, ...)` / `canEditContact(...)`. Actions used with
  `useActionState` return `ActionResult` from `src/lib/action.ts` (`ok()` / `fail()`); read FormData with `str/int/num/bool/list`.
  After mutating, `revalidatePath(...)` the affected pages.
- **Domain logic lives in `src/lib/**`, not in pages or actions.** Pages/actions call services. Services take an
  optional `tx: Tx = db` parameter so callers can compose them in one `db.transaction`.
- **Visibility:** every contacts list/search must include `contactScope(user)` in its WHERE (it also hides merged rows).
  For a single contact page use `canViewContact(user, contact)` and 404 when false.
- **Settings, not constants:** dropdown lists, scoring weights, thresholds, currency rates, ladder families/rungs,
  next-best-offer rules and teams come from `getSetting(key)`/`getSettings([...])` (`src/lib/settings`). Stored values are
  keys; show labels with `labelFor(list, key)`. Never hard-code a threshold the spec says is configurable.
- **Calculated columns** on `contacts` (ltv_inr, purchase_count, scores, grade, next_expected_at, next_offer, ...) are
  written ONLY by `recomputeContact()` in `src/lib/metrics/recompute.ts`. Any service that changes purchases,
  payments, ratings, interactions, enquiries, referrals or profile fields must call `recomputeContact(contactId, tx)`
  afterwards (and for the referrer when referrals/payments change).
- **Money:** INR is the base. Every purchase/payment stores amount, currency, fx_rate and amount_inr at the time of
  entry (rate from settings `currency.rates`, month of the payment). LTV = verified payments − verified refunds, in INR.
  Unverified bank/UPI payments never count. `reference` (TagMango order id / UTR) is unique: reject duplicates with a
  friendly message.
- **Phone is identity.** Always normalise with `normalizePhone()`. Match order: exact phone (incl. alt phones), then
  exact email (incl. alt emails). Same name + same city is only flagged in `duplicate_reviews`, never merged.
- **Ownership:** every owner change goes through the ownership service (writes `ownership_log` with a reason).
  `first_owner_id` never changes after it is first set. Support never owns.
- **Audit:** profile edits, stage changes, verifications, merges, reassignments, exports and settings changes are
  written to `audit_log` via `audit()`/`auditDiff()`.
- **Idempotency:** webhooks dedupe on `webhook_events.event_key`, `enquiries.source_ref`, `purchases.reference`,
  `payments.reference`, `interactions.external_ref`; alerts dedupe on `tasks.dedupe_key` / `notifications.dedupe_key`
  (use `onConflictDoNothing`).
- **Time:** store UTC (`timestamptz`). Display in the user's `timezone` (default Asia/Kolkata) via `formatDate*` in
  `src/lib/utils.ts`. Pass `now` into pure functions so they are testable.
- **UI:** Tailwind tokens from `globals.css` (`bg-surface`, `border-border`, `text-muted`, `bg-brand`, `text-grade-a`, ...)
  and the kit in `src/components/ui`. Brand is black and white (logo at `/brand/edapt-logo.png`, mark at
  `/brand/edapt-mark.png`). Today, Quick Add, Contact page, Log interaction and Rate customer are **phone-first**:
  design at 390px width first (big tap targets, chips instead of dropdowns where possible), then widen.
  Other screens are laptop-first but must not break on a phone. Use native `<select>` for long lists.
- **Copy:** plain, short, sentence case. Show *why* (e.g. every Today row shows its reason).
- **Schema changes:** edit `src/db/schema.ts` (additive only), then `npm run db:push`. Migration SQL is generated at release
  with `npm run db:generate`; do not hand-write migration files. The one exception is `drizzle/custom/*.sql`: idempotent
  SQL Drizzle cannot express (e.g. `create extension pg_trgm`), applied by `scripts/db-custom.ts` before every push,
  migration and test setup.
- **Performance:** lists are paginated and scoped in SQL, never filtered in JS; aggregates run in SQL. Check new queries
  against the 50,000-contact scale data with `scripts/perf/bench.ts` (docs/PERFORMANCE.md has the budgets).
- **Tests:** pure logic gets unit tests in `tests/unit`. Services that touch the DB get integration tests in
  `tests/integration` using `resetDb()` and `makeUser()` from `tests/support/db.ts`. Run `npm test` before finishing.
- Never weaken a check, skip a test or catch-and-ignore an error to make something pass.

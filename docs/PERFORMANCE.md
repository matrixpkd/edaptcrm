# Performance at Edapt's real scale

The CRM has to stay fast with Edapt's real book: about 50,000 contacts, three years of purchases, and thousands of
open alerts. This page records what was measured on scale data, what was fixed, the indexes the fixes rely on, and
the limits that are still known.

Measured 13 Oct 2026 on the build machine: 4 vCPU, 15 GB RAM, local Postgres 16 with default settings
(`shared_buffers` 128 MB, `work_mem` 4 MB, `jit` on). Other engineers were using the same machine at the time, more
heavily during the "after" run (load average 4 to 7 on 4 cores). Rows whose code did not change
read 10 to 40% slower "after" because of that, not because of a regression.

## Data volumes

`edapt_perf`, filled by `npm run db:seed:scale` (`scripts/seed-scale.ts`: multi-row INSERTs, then `recomputeAll` and
the alert rules once):

| Table | Rows | Notes |
| --- | ---: | --- |
| contacts | 50,000 | 37,894 on +91 and 8,535 on +971 numbers (the rest other GCC countries); 35,677 customers; 2,956 referred |
| purchases | 77,889 | 21 Oct 2023 to 13 Oct 2026 |
| payments | 79,813 | 79,440 verified, 59 unverified, 410 refunds |
| enquiries | 129,863 | 72,567 TagMango checkouts, 30,282 WhatsApp API, 13,866 Meta lead forms, ... |
| interactions | 64,301 | |
| ratings | 15,992 | on 15,097 contacts (30%) |
| tasks | 52,453 | **24,258 open**: about 6,100 each for three Kerala salespeople, 2,900 each for two in Dubai |
| ownership_log / audit_log | 62,504 / 47,429 | |
| organisations, users, products | 200, 9, 10 | |

That is about 5 times the "~5,000 open tasks" planned: the alert rules raised next-rung and at-risk tasks for the
whole book on their first run. It makes the Today queue a harsher test, so it was kept. The database is 301 MB.

## How to measure

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/edapt_perf \
  npx tsx --conditions=react-server scripts/perf/bench.ts [--explain] [--heavy] [--only today,contacts] [--runs 5]
```

`scripts/perf/bench.ts` calls the same server functions the pages, actions and cron routes call (a page's whole
`Promise.all`, not one query) as an admin, a manager and the salesperson with the most open tasks. Each scenario
gets one warm-up run, then the median of 5 runs is reported. `--explain` also captures every SQL statement the
scenario sent (through the query-log hook `src/db` reads, `__edaptQueryLog`) and runs `EXPLAIN (ANALYZE, BUFFERS)` on each distinct read,
keeping the three slowest plans. `--heavy` adds exports, alerts, import matching, `recomputeAll` and the nightly job.
Writes run in a transaction that is rolled back; `recomputeAll` writes for real, which is safe because it is
idempotent. The script refuses any database whose name does not contain `perf` or `bench`.

To re-check after a schema change, run `npm run db:push` against `edapt_perf` first.

## Budgets

| What | Budget |
| --- | --- |
| Interactive page: server time for its data | < 300 ms each (dashboard < 1.5 s in total) |
| One capture or purchase, including the recompute | < 150 ms |
| `recomputeAll` on 50,000 contacts | < 3 min |
| Alert rules (`runAllAlerts`) | < 30 s |
| Nightly cron (`/api/cron/nightly`) | within Vercel's `maxDuration` of 300 s |

## Results: server functions, before and after

Medians, warm. "Queries" counts the statements sent in one run of the "after" code. ✗ marks a miss in the "before"
run; every row is within budget "after".

| Scenario | Before | After | Queries | Budget |
| --- | ---: | ---: | ---: | ---: |
| **Shell** | | | | |
| Layout unread count (every page) | 1.4 ms | 1.3 ms | 1 | 50 ms |
| Notifications inbox | 4.8 ms | 4.4 ms | 2 | 300 ms |
| **Contacts list** (the page's whole `Promise.all`: list, count, saved views, countries, owners) | | | | |
| Default sort (Edapt Score), admin | 43 ms | 58 ms | 7 | 300 ms |
| Default sort, salesperson (own + pool scope) | 62 ms | 69 ms | 5 | 300 ms |
| Page 500 (offset 24,950) | 102 ms | 132 ms | 7 | 300 ms |
| Sort by LTV / activity / newest / name | 32–42 ms | 38–60 ms | 7 | 300 ms |
| Filter grade A / stage / first door / tag / owner pool | 27–41 ms | 34–56 ms | 7 | 300 ms |
| Filter campaign | **748 ms ✗** | 90 ms | 7 | 300 ms |
| Filter channel | 133 ms | 166 ms | 7 | 300 ms |
| Filter family / country / language / at risk | 49–66 ms | 62–76 ms | 7 | 300 ms |
| Filter unrated | 121 ms | 110 ms | 7 | 300 ms |
| Owner "mine" (salesperson) | 28 ms | 52 ms | 5 | 300 ms |
| Several filters together (salesperson) | 32 ms | 30 ms | 4 | 300 ms |
| Search, first 4 letters of a first name | 95 ms | 32 ms | 7 | 300 ms |
| Search, 5 digits of a phone | 112 ms | 36 ms | 7 | 300 ms |
| Search, a full phone number | 123 ms | 37 ms | 7 | 300 ms |
| Search "@gmail" (matches 34,000 contacts) | 138 ms | 122 ms | 7 | 300 ms |
| Merge-tab contact picker search | 47 ms | 2.4 ms | 1 | 300 ms |
| **Contact page** | | | | |
| Header + footprint + timeline, the contact with the most history | 12 ms | 14 ms | 5 | 300 ms |
| Header + purchases tab, same contact | 6.8 ms | 7.6 ms | 6 | 300 ms |
| Header + timeline, a typical contact | 10 ms | 12 ms | 5 | 300 ms |
| Ratings and referrals tabs | 1.8 ms | 1.5 ms | 2 | 300 ms |
| **Today** | | | | |
| Today queue, salesperson with 6,100 open tasks | **1,359 ms ✗** | 135 ms | 3 | 300 ms |
| Today queue, manager | 14 ms | 6.7 ms | 3 | 300 ms |
| Team view (manager: 24,000 open tasks, 5 people and the pool) | **1,973 ms ✗** | 241 ms | 4 | 300 ms |
| **Payments desk** | | | | |
| Desk totals | 4.9 ms | 4.7 ms | 1 | 150 ms |
| Unverified tab / Due tab (totals + list) | 5.4 / 6.5 ms | 4.6 / 4.9 ms | 2 | 300 ms |
| Recent tab, manager / salesperson | 59 / 56 ms | 56 / 48 ms | 3 | 300 ms |
| Recent tab, page 100 | 49 ms | 69 ms | 1 | 300 ms |
| **Dashboard** (`src/lib/dashboard/metrics.ts`, month to date unless noted) | | | | |
| revenueByFamily / newCustomers / leadsAndConversionByChannel | 32 / 31 / 27 ms | 31 / 33 / 28 ms | 1–3 | 300 ms |
| leadsAndConversionByChannel, 90 days | 38 ms | 44 ms | 3 | 300 ms |
| ltvByFirstDoor / repeatRate / medianDaysFirstToSecond | 41 / 28 / 109 ms | 45 / 28 / 159 ms | 1–2 | 300 ms |
| rungMoves / rungMoves 90 days | 41 / 89 ms | 38 / 91 ms | 2 | 300 ms |
| forecast90d / atRiskPool / abandonedCheckoutsRecovered | 30 / 25 / 4.6 ms | 28 / 26 / 4.7 ms | 1 | 300 ms |
| assistedVsSelfServe / teamView / teamView 90 days | 28 / 67 / 139 ms | 22 / 59 / 170 ms | 1–4 | 300 ms |
| beyondUmerShare / languageMix / referralLeaderboard | 65 / 26 / 25 ms | 79 / 36 / 33 ms | 2 | 300 ms |
| dataHealth / lostReasons | 103 / 4.6 ms | 103 / 3.8 ms | 2–4 | 300 ms |
| **Dashboard page: all 18 in parallel** | 270 ms | 321 ms | 33 | 1.5 s |
| Calibration report | 292 ms | 361 ms | 3 | 1.5 s |
| **Typing and single writes** | | | | |
| Quick Add duplicate check while typing (known / new number) | 2.5 / 1.5 ms | 3.2 / 1.6 ms | 1–2 | 100 ms |
| captureEnquiry: new contact / existing / the contact with the most history | 30 / 22 / 24 ms | 32 / 22 / 21 ms | 21–28 | 150 ms |
| recordPurchase + recompute: typical / heaviest contact | 26 / 25 ms | 32 / 26 ms | 26–27 | 150 ms |
| recomputeContact, heaviest contact | 8.9 ms | 12 ms | 11 | 100 ms |
| **Jobs** | | | | |
| buildCohorts | 229 ms | 263 ms | 3 | 2 s |
| Daily digest: busiest salesperson / manager | – | 205 / 21 ms | 10–11 | 1 s |
| Weekly summary | – | 336 ms | 20 | 3 s |
| Export all contacts (50,000 rows, 20 MB CSV, streamed) | **19.2 s** | 5.7 s (3.6 s at low load) | 29 | 30 s |
| Export all purchases (77,889 rows, 20 MB) | **14.1 s** | 3.9 s (3.6 s at low load) | 42 | 30 s |
| runAllAlerts, today (most alerts already raised) | 371 ms | 383 ms | 35 | 30 s |
| runAllAlerts, 35 days on (a new month: 1,747 next-rung tasks, 300 leads released, 96 instalment tasks, ...) | – | 3.5 s | 2,940 | 30 s |
| Import: clean + match a 5,000-row file (1,856 matches by phone or email, 3,144 new) | 2.1 s | 2.4 s | 102 | 60 s |
| recomputeAll, 50,000 contacts | 14.3 s | 18.8 s (14.6 s at low load) | 909 | 3 min |
| Nightly job, every step | 15.4 s | 16.9 s | 924 | 300 s |

The import commit phase has its own benchmark, `scripts/bench-import.ts` (README).

## What was slow, and the fixes

1. **Contacts: campaign filter, 748 ms.** The filter was `first_campaign = $1 OR EXISTS (select … from enquiries …)`.
   The planner costs a correlated EXISTS inside an OR at about 815,000, which is above `jit_above_cost` (100,000).
   Postgres then JIT-compiled the query on every request: 446 ms of JIT for a 45 ms scan, twice per page (count and
   rows). It is now written as `contacts.id IN (select contact_id from enquiries where campaign = $1)`, which the
   planner costs at about 11,000. That means no JIT and a hashed subplan. The new `enquiries_campaign_idx` index makes
   that subplan an index scan.
2. **Contacts search, 95–140 ms**, with a sequential scan of all 50,000 rows run twice (count and rows). It now
   uses trigram GIN indexes (`pg_trgm`) on `lower(name)`, `lower(coalesce(email,''))` and `phone_e164`. The
   alternate-phone and alternate-email arms of the OR were the only ones no index could serve: `array_to_string()`
   is not immutable, so it cannot be indexed. Those arms are now guarded by `cardinality(alt_phones) > 0` and
   `cardinality(alt_emails) > 0`, which match two tiny partial indexes. Every arm can then use an index, and the
   whole OR becomes a `BitmapOr`. A selective search now takes 0.1 ms in SQL. The merge-tab picker uses the same
   condition and fell from 47 ms to 2.4 ms.
3. **Today queue, 1.36 s for a salesperson with 6,100 open tasks.** Only 165 ms of that was SQL. The rest was
   JavaScript:
   - `buildQueue()` built the "why it is here" context for every one of up to 2,000 rows, but only the 40 rows that
     survive the cap are shown. Context is now built after the cap.
   - Each context line created several `Intl.DateTimeFormat` objects through `validTimeZone()`, `localTimeInDays()`,
     `shortDate()` and `localTime()`. Building one takes about 70 µs; formatting with a cached one takes about 1 µs.
     Those formatters, and `formatDate`, `formatDateTime`, `formatRelative` (`src/lib/utils.ts`) and `csvDateTime`, are
     now cached per time zone.
   - In SQL, the ranking sort computed `log()` on a `numeric` (arbitrary precision, about 15 µs each). It now casts
     to `float8`, which is the same double precision `rank.ts` uses in JavaScript.
   - The count of rows left out ("+N more") was a second scan of tasks joined to contacts. It now comes from the
     same query: `dense_rank()` over the row key, and `max()` of it, before the limit.
4. **Team view, 1.97 s.** The same JavaScript fixes, plus the query was restructured. It used to rank all 24,000
   open tasks with a window function, join the result back to tasks and contacts, then run another scan to count
   the people whose list was cut. Now one query ranks narrow rows (task id, assignee, rank), computes each person's
   true row count with `dense_rank`/`max`, keeps 400 tasks per person, and only then joins those ~2,000 tasks to
   their columns (`loadRankedTasks` in `src/lib/today/queue.ts`). SQL fell from 630 ms to about 150 ms.
5. **Exports, 19 s and 14 s.** The SQL was 25 keyset pages of 2,000 rows, under 100 ms each. The time went into
   `csvDateTime()`, which built a new `Intl.DateTimeFormat` for each of the ~300,000 dates. With the formatter cached
   per time zone, an export takes 4–6 s. The first byte arrives in about 50 ms, because the stream is pull-based.

Nothing else missed its budget. The writes are 20–35 ms with 21–28 statements each: the recompute is one locked
bulk read and one UPDATE. The dashboard queries are already set-based aggregates in SQL. The payments desk is
bounded and indexed.

## Indexes added (src/db/schema.ts, additive)

| Index | For |
| --- | --- |
| `contacts_name_trgm_idx`: GIN `lower(name) gin_trgm_ops` | search anywhere in a name |
| `contacts_email_trgm_idx`: GIN `lower(coalesce(email,'')) gin_trgm_ops` | search anywhere in an email |
| `contacts_phone_trgm_idx`: GIN `phone_e164 gin_trgm_ops` | search by any 3+ digits of a number |
| `contacts_has_alt_phones_idx`: btree `(id) where cardinality(alt_phones) > 0` | the alternate-number arm of the search |
| `contacts_has_alt_emails_idx`: btree `(id) where cardinality(alt_emails) > 0` | the alternate-email arm of the search |
| `enquiries_campaign_idx`: btree `(campaign)` | the campaign filter |

Building them on 50,000 contacts takes under a second (GIN email about 0.35 s). Writes are unaffected: capture,
purchase and `recomputeAll` stayed within noise.

### The pg_trgm extension (drizzle/custom)

Drizzle cannot create extensions, and `drizzle-kit push` fails on a `gin_trgm_ops` index when `pg_trgm` is missing.
So `drizzle/custom/*.sql` holds idempotent SQL that must run **before** the schema push or the generated migrations,
in file-name order. Today that is only `0000_extensions.sql` (`create extension if not exists pg_trgm`).
`scripts/db-custom.ts` applies it, and every schema flow runs it first:

- `npm run db:push` is now `tsx scripts/db-custom.ts && drizzle-kit push --force`
- `npm run db:migrate` (`scripts/migrate.ts`) runs it before the migrator, for Supabase deploys
- the Vitest global setup (`tests/support/global-setup.ts`) and the Playwright global setup (`tests/e2e/global-setup.ts`)
  run it before their push

On Supabase, `pg_trgm` is available. If it was already enabled from Database > Extensions, it lives in the
`extensions` schema, which is on the default `search_path`, and the custom file is a no-op. Running
`drizzle-kit push` directly, without `npm run db:push`, on a database that has never had the extension fails with
`operator class "gin_trgm_ops" does not exist`. Run `npx tsx scripts/db-custom.ts` once and push again.

## Over HTTP (dev server)

`next dev` on port 3404 against `edapt_perf`, signed in through the login form, warm (one hit, then the median of 5).
These are **development-mode** timings. In development, React 19 adds debug information (owner stacks, file
positions) to the RSC payload for every rendered element, and nothing is minified. The cost of a page therefore grows
with the number of rows it renders, not with its queries. The contacts page with 50 rows is 1.4 MB, and 640 KB of
its 960 KB RSC payload is development-only debug rows. Compare `/contacts?q=anil` (3 rows, 120 KB) at about 210 ms
with `/contacts` (50 rows) at about 1.4 s, when the data for both takes 30–60 ms. Production builds were not measured:
`next build` was out of scope for this work, because the dev servers share the build directory.

| User | Page | Size | Median | Server data (bench) |
| --- | --- | ---: | ---: | ---: |
| admin | /today | 50 KB | 211 ms | 7 ms |
| admin | /contacts | 1,396 KB | 1,451 ms | 58 ms |
| admin | /contacts?grade=A | 1,396 KB | 1,420 ms | 36 ms |
| admin | /contacts?campaign=… | 1,399 KB | 1,440 ms | 90 ms |
| admin | /contacts?q=98502 (phone digits) | 312 KB | 403 ms | 36 ms |
| admin | /contacts?q=anil | 120 KB | 215 ms | 32 ms |
| admin | /contacts?channel=whatsapp_api | 1,402 KB | 1,502 ms | 166 ms |
| admin | /contacts?unrated=1 | 1,384 KB | 1,465 ms | 110 ms |
| admin | /contacts?page=500 | 1,405 KB | 1,736 ms | 132 ms |
| admin | /contacts/[id], the contact with the most history | 235 KB | 627 ms | 14 ms |
| admin | same, purchases tab | 190 KB | 450 ms | 8 ms |
| admin | /contacts/[id], typical | 129 KB | 314 ms | 12 ms |
| admin | /payments (unverified) | 950 KB | 1,316 ms | 5 ms |
| admin | /payments?tab=due | 923 KB | 1,160 ms | 5 ms |
| admin | /payments?tab=recent | 499 KB | 654 ms | 56 ms |
| admin | /dashboard | 526 KB | 1,044 ms | 321 ms |
| admin | /dashboard/calibration | 896 KB | 1,469 ms | 361 ms |
| admin | /contacts/new (Quick Add) | 54 KB | 211 ms | – |
| admin | /notifications | 114 KB | 265 ms | 4 ms |
| sales (6,100 open tasks) | /today | 346 KB | 695 ms | 135 ms |
| sales | /contacts | 1,303 KB | 1,448 ms | 69 ms |
| sales | /contacts?owner=mine | 1,286 KB | 1,902 ms | 52 ms |
| sales | /contacts?q=anil | 115 KB | 361 ms | 32 ms |
| sales | /payments | 909 KB | 1,467 ms | 5 ms |
| sales | /payments?tab=recent | 497 KB | 814 ms | 48 ms |
| manager | /today | 278 KB | 454 ms | 7 ms |
| manager | /today?view=team | 1,728 KB | 2,682 ms | 241 ms |
| manager | /payments | 948 KB | 1,303 ms | 5 ms |
| manager | /dashboard | 521 KB | 932 ms | 321 ms |
| admin | GET /api/export/contacts (20 MB) | | 5.3–7.6 s, first byte 52 ms | |
| admin | GET /api/export/purchases (20 MB) | | 6.7 s (cold route) | |

Before the fixes, the team view's data alone took about 2 s and a salesperson's Today about 1.4 s, on top of
rendering.

## Known limits

- **Team view page weight.** The page renders up to 40 rows for each of 5–6 people (about 240 rows, 1.3 MB of HTML
  in dev). The data is 0.2 s; the remaining time is rendering. If the team grows, render the groups collapsed and
  load a person's rows when the group is opened.
- **`recomputeAll` rewrites every contact every night** (`scored_at` changes even when nothing else does). At
  50,000 contacts that is 50,000 dead tuples a night. Autovacuum cleans them (it ran during these tests), but the
  table and its indexes stay about twice their packed size. Skipping rows whose calculated values did not change
  would stop that, but it would also change what "Scored" on the contact page means, so it was left as is.
- **Nightly cron headroom.** The whole nightly job takes 15–19 s locally. On Supabase, each of its ~920 statements
  adds a network round trip (about 1–2 ms from Vercel `bom1` to Supabase Mumbai), and a small Supabase compute is
  slower than this machine. Expect 1 to 2 minutes, well inside the 300 s `maxDuration`, so the nightly route stays
  a single invocation. If the book grows past roughly 200,000 contacts, make `recomputeAll` resumable: keep its
  keyset cursor (`after`) in a settings row and let the route stop at a time budget.
- **JIT on Supabase.** Postgres JIT is on by default. Queries whose estimated cost passes 100,000 get compiled,
  which adds 20–450 ms and never pays back on a query that runs in 50 ms. After the campaign fix, the remaining cases
  are small: about 17–55 ms on `teamView (90d)`, `dataHealth` and the weekly summary. If dashboards look slow on
  Supabase, `alter role postgres set jit = off` (or `alter database … set jit = off`) is a safe setting for this
  workload. Set it on the role or database, not as a connection startup parameter: the transaction pooler (port 6543) may
  not pass those through.
- **Broad searches are not faster.** A search that matches most contacts, such as "@gmail" (34,000 rows), still
  reads most of the table, so it takes about 120 ms. The trigram statistics also under-estimate such patterns, so
  the planner picks the bitmap path even though a sequential scan would be no slower. Queries of 1–2 characters
  cannot use a trigram index and fall back to a sequential scan.
- **Contacts page fixed costs.** Every load counts the whole filtered set for the pager, and also counts contacts by
  country for the country filter. That is a sequential scan of about 30 ms. Both scale linearly with the book.
- **Deep pages use OFFSET.** Page 500 of the contacts list costs about 130 ms. Keyset paging would keep it flat, but
  nobody pages that deep; filters and search are the way in.
- **Dashboard "unrated" count** runs its `NOT EXISTS (ratings)` subplan twice per contact (about 100 ms). It is within
  budget; `unratedCondition()` is shared with the contacts filter and the export, so it was left alone.
- **Alerts in a new month** send about 2,900 statements, because tasks and notifications are written alert by alert.
  That takes 3.5 s locally and is fine at 15-minute and nightly cadences.

## Beyond-the-spec screens at 50,000 contacts

Measured on the scale database (`npm run db:seed:scale`), median of three warm runs, October 2026. All within the
300 ms interactive budget without new indexes.

| Query | Time |
| --- | --- |
| Pipeline board, admin (8 grouped counts + top 25 cards per column, `src/lib/pipeline/board.ts`) | 142 ms |
| Pipeline board, salesperson (own + pool) | 58 ms |
| Activity feed, everything (seven newest-first arms, `src/lib/activity/feed.ts`) | 207 ms (each arm 9–42 ms) |
| Activity feed, one person | 91 ms |
| Global search, name / phone digits (`src/lib/search/global.ts`) | 3–5 ms |
| Team tasks / My tasks / tab counts / week agenda (`src/lib/tasks/service.ts`) | 64 / 25 / 55 / 19 ms |

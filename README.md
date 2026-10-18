<p align="center"><img src="public/brand/edapt-logo.png" alt="Edapt" width="220"></p>

# Edapt CRM

Edapt's attention allocator: with ~2,000 new paid customers a month across five salespeople, the CRM decides
**who deserves a human, when, and with which offer**. The product spec lives in [`docs/SPEC.md`](docs/SPEC.md);
the domain services are documented in [`docs/DOMAIN_API.md`](docs/DOMAIN_API.md); integrations in
[`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md); what was added beyond the spec, and why, in
[`docs/CRM_GAP_ANALYSIS.md`](docs/CRM_GAP_ANALYSIS.md).

## What's inside

| Area | What it does |
| --- | --- |
| **Capture** | Quick Add with a live duplicate check, TagMango order webhooks (purchases, abandoned checkouts, affiliates, self-ratings), Libromi WhatsApp API, Meta lead forms and website forms via Pabbly, and the import wizard for the ~50,000 old records. |
| **One person, one record** | Phone number is the identity key (normalised to E.164, India by default, UAE `05X…` understood). Matching by phone, then email; same name + city is flagged for review, never merged. Merges keep the oldest First Door and are fully undoable. |
| **Labels** | Channel (per enquiry), First Door (set once, never overwritten), Campaign, Tags — all edited in Settings. |
| **Ownership** | GCC numbers to the Dubai team, others to Kerala, round robin among active salespeople; first owner kept forever; untouched leads return to the pool after 7 days; only managers reassign; leaver handover in one action; sales credit if the owner talked to the buyer in the 30 days before a purchase. |
| **Money** | Purchases, instalments (EMI), refunds, INR/AED/USD at the month's rate stored on each row, unique TagMango order ids and UTRs, bank/UPI payments count only after a manager verifies them. |
| **Brain** | Fit, Readiness and Value → Edapt Score and A–D grade; repeat-purchase cohorts, expected next purchase, at-risk flag, next best offer, 90-day revenue forecast; recalculated after every change and nightly. Every weight is editable in Settings. |
| **Today** | One ranked list per salesperson (abandoned checkouts and overdue follow-ups on top, customers by expected revenue, leads by Edapt Score), with one-tap Call and WhatsApp; after a call the Log interaction screen is already open. |
| **Alerts** | Abandoned checkout, hot lead, new lead, untouched lead, follow-up due, due for next rung, at risk, instalment due, unverified payment, new advocate, VIP gone quiet, lead released; daily digest at 8:30 in each user's time zone and a Monday summary. |
| **Cockpit** | Revenue by product family, conversion by channel, LTV by First Door, repeat rate, rung moves, forecast, at-risk pool, recovered checkouts, assisted vs self-serve, team view, Beyond-Umer share, language mix, referral leaderboard, data health, and the calibration report. |
| **Roles** | Admin (everything, settings, imports, exports), Manager (all contacts, reassign, verify payments, team dashboard), Sales (own contacts + the unassigned pool), Support (all contacts, logs notes/issues without owning). |
| **Tasks and agenda** | Reminders with a due date and time, an assignee (managers give tasks to anyone) and an optional contact, from /tasks, Today or a contact page; My tasks, Overdue, Upcoming, Team tasks, Done and a day/week agenda. Due tasks land on Today. |
| **Pipeline** | A board of the eight lifecycle stages (grade, owner, next offer, LTV per card; filters by owner, grade and first door). Only Qualified, Lost (with a reason) and Reopen are set by hand, by drag or Move; the rest move by themselves. |
| **Search** | One box in the sidebar (Ctrl/Cmd+K, or the search icon on phones) for contacts by name, phone or email, organisations and screens, within what the person may see. |
| **Notes, templates, privacy** | Quick notes with one pinned note at the top of a contact; admin-defined WhatsApp templates ({first_name}, {offer}, {owner}) that pre-fill the chat; one-tap marketing consent; an admin can erase a person's data on request (money rows kept, anonymised). |
| **Activity** | Managers see what the team did, newest first: calls and messages, leads added, payments, stage and owner changes, tasks done. |

The five screens the team uses all day (Today, Quick Add, Contact page, Log interaction, Rate customer) are designed
for phones first, and the app installs on a phone's home screen.

## Screens

From the demo data (`npm run db:seed -- --demo`): a salesperson's morning on a phone, a manager's desk on a laptop.

<p>
  <img src="docs/screenshots/phone-today.png" alt="Today on a phone: abandoned checkouts on top, each row with its reason, Call and WhatsApp" width="240">
  <img src="docs/screenshots/phone-contact.png" alt="Contact page on a phone: grade, scores, owner, Call / WhatsApp / Log, the ladder and next best offer" width="240">
  <img src="docs/screenshots/phone-rate.png" alt="Rate customer on a phone: anchored scales with a live score preview" width="240">
</p>

![Dashboard on a laptop: revenue, conversion, forecast, at-risk pool and Beyond-Umer share](docs/screenshots/laptop-dashboard.png)

![Contacts list on a laptop: search, filters by grade, stage, door, campaign, owner and more](docs/screenshots/laptop-contacts.png)

## Stack

Next.js 15 (App Router, Server Actions) · TypeScript · Tailwind CSS v4 · Postgres via Drizzle ORM (Supabase in
production) · Vitest + Playwright. Optional: Claude API for import column mapping, Resend for email, Supabase
Storage for payment proofs.

## Run it locally

Requirements: Node 22.12+ (Vitest 5 needs it), Postgres 15+.

```bash
npm install
cp .env.example .env.local          # then edit DATABASE_URL and ADMIN_* if needed
createdb -h localhost -U postgres edapt          # the database named in DATABASE_URL (the scripts do not create it)
npm run db:push                      # create the tables
npm run db:seed                      # first admin + starter products (add `-- --demo` for demo data)
npm run dev                          # http://localhost:3000
```

Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env.local` (defaults: `umer@edapt.in` / `change-me-now` —
change it in *Your account*, `/account`). With an empty database and no seed, `/login` sends you to `/setup`, which
creates the first admin instead (it closes once any user exists).

```bash
npm run typecheck && npm run lint
createdb -h localhost -U postgres edapt_test     # once: the test database named in .env.test
npm test                 # unit + integration tests; TEST_DATABASE_URL=postgres://… overrides .env.test's database
npm run build && npm start                       # production build, served on http://localhost:3000
createdb -h localhost -U postgres edapt_e2e      # once, for the end-to-end tests
npx playwright install chromium                  # once: the browser Playwright drives
npm run test:e2e         # Playwright end-to-end tests (about 3.5 minutes)
```

The end-to-end suite (`tests/e2e`, `playwright.config.ts`) builds the app into `.next-e2e`, serves it on port 3403
against the `edapt_e2e` database, empties that database and loads the admin, products and demo data, then runs the
specs in a laptop (1280×800) and a phone (390×844, touch) project: sign-in, Quick Add and Today in both, the other
phone-first screens on the phone, desk and API flows on the laptop. `E2E_DEMO=0` skips the demo data (the specs make
their own), `E2E_SKIP_BUILD=1` reuses the last build, and outside CI a server already running on 3403 is reused.

## Demo data

```bash
npm run db:push && npm run db:seed && npm run db:seed -- --demo    # empty database only; about 1.5 minutes
```

About 600 contacts and 18 months of history, built only through the domain services (capture, calls, ratings,
TagMango orders, bank transfers and their verification, refunds, EMIs, merges, transfers, the weekly lead release
and the nightly job), replayed under a simulated clock, then recomputed and alerted at the real now. It is
deterministic and refuses to run twice (for a fresh copy: `npm run db:reset && npm run db:seed -- --demo`; the
reset empties every table of the database in `.env.local`). Every login uses the password
`change-me-now`:

| Login | Role | Try |
| --- | --- | --- |
| `umer@edapt.in` | Admin | Dashboard (this month vs last, LTV by First Door, rung moves, referral leaderboard), Duplicates (four open, one merge in the history), his own VIP follow-ups on Today |
| `meera@edapt.in` | Manager | Payments: five bank/UPI payments to verify (three waiting over two days) and an overdue EMI instalment; Today: two transfer requests; Today → Team |
| `asha@` `biju@` `ravi@edapt.in` | Sales, Kerala | Today: abandoned checkouts from the last day, overdue and due-today follow-ups, new and untouched leads, next rung and at-risk customers, an advocate to thank |
| `fatima@` `omar@edapt.in` | Sales, Dubai (Asia/Dubai) | A grade A hot lead from the AI Office Dubai campaign, AED payments, an instalment due in two days |
| `sana@` `joseph@edapt.in` | Support | Contacts and the support issues on contact pages (a follow-up they set on a support issue lands on their own Today; the owner never changes) |

The seed log ends with a contact worth opening: an advocate with five purchases up to The AI Office, four referrals,
ratings, a support issue and a Premium follow-up due tomorrow. Contacts filters worth a click: tag
*Legacy: Delegation*, campaign *Koduvally AI Literacy Mission*, First Door *Referral*, grade A.

For performance work, `DATABASE_URL=… npm run db:seed:scale` bulk-loads 50,000 contacts (about 80,000 purchases,
130,000 enquiries, 64,000 interactions) over three years into an empty database after `db:seed`, then runs the
nightly recompute and the alert rules, timing each phase (about 2.5 minutes locally).

## Deploy (Supabase Mumbai + Vercel)

1. **Supabase** (Pro, region *South Asia (Mumbai)*): create the project. In *Storage*, create a private bucket named
   `crm-files`. Copy the database connection strings and the service role key.
2. **Database schema**: from your laptop, apply the migrations to Supabase using a *session* connection string on
   port 5432 (the session pooler shown below, or the direct connection), not the transaction pooler on 6543.
   `db:migrate` first runs `drizzle/custom/*.sql` (the `pg_trgm` extension the contact-search indexes need; Drizzle
   cannot create extensions), then the generated migrations. With `DATABASE_URL` set on the command line the scripts
   ignore `.env.local`, so pass the admin's details too; away from localhost the seed refuses the example password and
   anything under 10 characters:
   ```bash
   DATABASE_URL="postgres://postgres.<ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres" npm run db:migrate
   DATABASE_URL="…same…" ADMIN_EMAIL=umer@… ADMIN_NAME='Umer Abdussalam' ADMIN_PASSWORD='…' npm run db:seed
   ```
   (Or create the admin in the app: on the empty database `/setup` makes the first admin; then run the seed with
   `ADMIN_EMAIL` set to that admin's email and it only adds the starter products.)
3. **Vercel**: import the GitHub repository and set these environment variables. (The spec plans for Vercel Pro;
   the free Hobby plan works too, see step 5, but Vercel's terms limit Hobby to non-commercial use.)

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Supabase *transaction pooler* URL (port 6543). A session-pooler URL (5432) on the same host is moved to 6543 by the app: the session pooler admits only 15 clients on small plans, and a few page loads at once use more |
   | `DATABASE_POOL_MAX` | optional — connections per function instance (default 5) |
   | `APP_URL` | e.g. `https://crm.edapt.in` |
   | `CRON_SECRET` | a long random string (Vercel Cron and the Supabase schedule send it to the cron routes) |
   | `TAGMANGO_WEBHOOK_SECRET`, `LIBROMI_WEBHOOK_SECRET`, `PABBLY_WEBHOOK_SECRET` | long random strings, one per integration |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | from Supabase (bucket `crm-files`) |
   | `ANTHROPIC_API_KEY` | optional — AI column mapping and row extraction in the import wizard |
   | `RESEND_API_KEY`, `EMAIL_FROM` | optional — digests, alert emails and "Forgot password?" links (those also need `APP_URL`); without it emails are only logged and an admin resets passwords under Team |

   `vercel.json` sets the function region (`regions`): keep it next to the Supabase project, `sin1` for Singapore
   (ap-southeast-1, the current project) or `bom1` for Mumbai (ap-south-1, the spec's choice for keeping data in India).
4. **Domain**: add `crm.<yourdomain>` in Vercel.
5. **Scheduled jobs.** Three cron routes keep the alerts and scores moving:

   | Route | When | Run by |
   | --- | --- | --- |
   | `/api/cron/frequent` | every 15 minutes: abandoned checkouts, untouched leads, lead release, instalments, unverified payments, alert emails, the 8:30 digests | **Supabase** (pg_cron), set up below |
   | `/api/cron/nightly` | 02:00 IST: recompute every score, next rung, at risk, VIPs gone quiet, clean-up | Vercel Cron (`vercel.json`) |
   | `/api/cron/weekly` | Monday ≈ 09:00 IST: the weekly summary | Vercel Cron (`vercel.json`) |

   Vercel's Hobby plan allows only two cron jobs that each run at most once a day, so `vercel.json` holds the
   nightly and weekly jobs (Hobby may fire them at any minute within the scheduled hour), and the 15-minute job runs
   from inside Supabase:

   1. In Supabase, open **Database → Extensions** and enable **pg_cron** and **pg_net**.
   2. From your laptop, with the session connection string (port 5432) and the same `CRON_SECRET` as on Vercel:
      ```bash
      DATABASE_URL="postgres://postgres.<ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres" \
      APP_URL="https://crm.edapt.in" CRON_SECRET="<same value as on Vercel>" npm run cron:schedule
      ```
      The URL and secret are stored in Supabase Vault. Run it again whenever the domain or `CRON_SECRET` changes.
   3. After 15 minutes, `npm run cron:schedule -- --status` (same env) should show HTTP 200 responses. A 401 means
      the secret differs from Vercel's.

   As a safety net, the nightly job also runs every 15-minute step once, so alerts still arrive (a day late) if the
   Supabase schedule is missing. On Vercel Pro you may instead add `{ "path": "/api/cron/frequent", "schedule":
   "*/15 * * * *" }` to `vercel.json` and remove the Supabase job with `npm run cron:schedule -- --remove`.
   Any other scheduler (e.g. cron-job.org) also works: a GET to `/api/cron/frequent` with
   `Authorization: Bearer <CRON_SECRET>` every 15 minutes.

   The nightly job also deletes webhook deliveries older than 180 days that were processed without an error (failed
   ones stay for review).
6. **Integrations**: follow [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) to point TagMango, Libromi and Pabbly at the
   webhook URLs shown in *Settings → Integrations*.
7. **Import history**: in *Import*, load TagMango customers and orders first, then Zoho, the delegation list, MLA and
   constituency program sheets, then everything else.

## Files and upload limits

Vercel refuses request bodies over about 4.5 MB, so files never travel through a function when they can be big:

- **Import files** (a 50,000-row export can be 10–20 MB): with Supabase Storage configured, the browser asks the server
  for a signed upload URL (the server creates it with the service key:
  `POST {SUPABASE_URL}/storage/v1/object/upload/sign/{bucket}/imports/…`), uploads the file straight to the private
  bucket, and hands only the storage key to the server, which downloads and parses it. Files up to 24 MB. Without
  Supabase (local dev) the file is posted to the server action and saved under `./uploads`.
- **Payment proofs** are posted with the payment form, so they are capped at **4 MB** (the form says so; a phone
  screenshot is well under 1 MB).
- **Who can open a file** (`/api/files/…`): a payment proof only for people who can view the contact of the payment
  or purchase it belongs to; an import file only for admins; anything else is a 404. With Supabase the route
  redirects to a 5-minute signed URL.

Import speed: `scripts/bench-import.ts` runs a generated 2,000-row TagMango file through the whole wizard against a
scratch database (it empties it, so it only accepts a database whose name contains `test`, `perf` or `bench`):

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/edapt_perf npx tsx --conditions=react-server scripts/bench-import.ts 2000
```

Everything else at Edapt's real scale (50,000 contacts): `scripts/perf/bench.ts` times every screen's queries and the
jobs against a scale database (`npm run db:seed:scale`); results, indexes and known limits are in
[docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## Your account

Everyone has **/account** (the name in the sidebar, or *Your account* in the phone menu): their name, email, role,
team and time zone; change their own time zone; change their password (current password required, at least 10
characters, typed twice — every other session is signed out); and sign out other sessions.

## Data hygiene

- Data stays in India (Supabase Mumbai); daily backups are kept 7 days on Supabase Pro.
- Salespeople see only their own contacts and the pool; every query goes through one scope helper.
- Only the admin can export, and every export is written to the audit log.
- Every profile edit, stage change, reassignment, merge, verification and settings change is in the audit log.
- Every contact carries a marketing consent flag with a date (DPDP and UAE data protection readiness).

## Decisions still open (defaults in place)

| Decision | Default |
| --- | --- |
| Manager with reassign and payment-verify rights | Umer (any admin acts as manager until a manager user exists) |
| Kerala / Dubai split of the team | GCC leads to Dubai, all others to Kerala (Settings → Teams & assignment) |
| Does sales credit affect pay? | Tracked for reporting only |
| Days before an untouched lead returns to the pool | 7 (Settings → Alerts & thresholds) |
| Spending bands and score weights | As in the spec, editable in Settings → Scoring |
| Product list and prices | Placeholders seeded — set real prices in Settings → Products before go-live |

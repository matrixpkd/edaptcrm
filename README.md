<p align="center"><img src="public/brand/edapt-logo.png" alt="Edapt" width="220"></p>

# Edapt CRM

Edapt's attention allocator: with ~2,000 new paid customers a month across five salespeople, the CRM decides
**who deserves a human, when, and with which offer**. The product spec lives in [`docs/SPEC.md`](docs/SPEC.md);
the domain services are documented in [`docs/DOMAIN_API.md`](docs/DOMAIN_API.md); integrations in
[`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md).

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

The five screens the team uses all day (Today, Quick Add, Contact page, Log interaction, Rate customer) are designed
for phones first, and the app installs on a phone's home screen.

## Stack

Next.js 15 (App Router, Server Actions) · TypeScript · Tailwind CSS v4 · Postgres via Drizzle ORM (Supabase in
production) · Vitest + Playwright. Optional: Claude API for import column mapping, Resend for email, Supabase
Storage for payment proofs.

## Run it locally

Requirements: Node 20+, Postgres 15+.

```bash
npm install
cp .env.example .env.local          # then edit DATABASE_URL and ADMIN_* if needed
npm run db:push                      # create the tables
npm run db:seed                      # first admin + starter products (add `-- --demo` for demo data)
npm run dev                          # http://localhost:3000
```

Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env.local` (defaults: `umer@edapt.in` / `change-me-now` —
change it in Settings → Users). With an empty database and no seed, `/setup` creates the first admin instead.

```bash
npm run typecheck && npm run lint
npm test                 # unit + integration tests (needs a Postgres database named in .env.test)
npm run test:e2e         # Playwright end-to-end tests
```

## Deploy (Supabase Mumbai + Vercel)

1. **Supabase** (Pro, region *South Asia (Mumbai)*): create the project. In *Storage*, create a private bucket named
   `crm-files`. Copy the database connection strings and the service role key.
2. **Database schema**: from your laptop, apply the migrations to Supabase using the *direct* connection string
   (port 5432):
   ```bash
   DATABASE_URL="postgres://postgres.<ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres" npm run db:migrate
   DATABASE_URL="…same…" ADMIN_EMAIL=umer@… ADMIN_PASSWORD='…' npm run db:seed
   ```
3. **Vercel** (Pro): import the GitHub repository and set these environment variables:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Supabase *transaction pooler* URL (port 6543) |
   | `APP_URL` | e.g. `https://crm.edapt.in` |
   | `CRON_SECRET` | a long random string (Vercel sends it to the cron routes) |
   | `TAGMANGO_WEBHOOK_SECRET`, `LIBROMI_WEBHOOK_SECRET`, `PABBLY_WEBHOOK_SECRET` | long random strings, one per integration |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | from Supabase (bucket `crm-files`) |
   | `ANTHROPIC_API_KEY` | optional — AI column mapping and row extraction in the import wizard |
   | `RESEND_API_KEY`, `EMAIL_FROM` | optional — digests and alert emails (without it they are only logged) |

   Set the Vercel project's function region to **Mumbai (bom1)** so the app sits next to the database.
4. **Domain**: add `crm.<yourdomain>` in Vercel.
5. **Scheduled jobs** are declared in `vercel.json` and start automatically on Vercel Pro.
6. **Integrations**: follow [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) to point TagMango, Libromi and Pabbly at the
   webhook URLs shown in *Settings → Integrations*.
7. **Import history**: in *Import*, load TagMango customers and orders first, then Zoho, the delegation list, MLA and
   constituency program sheets, then everything else.

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

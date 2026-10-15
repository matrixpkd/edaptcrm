# Spec coverage: docs/SPEC.md against the code

Every requirement in [docs/SPEC.md](SPEC.md), in the order the spec states it, with where it is built and how it was
checked. Reviewed on 13 Oct 2026 by reading the code, running the Vitest suite against a fresh Postgres database, and
driving the running app (demo data, phone width 390 px and laptop width) with Playwright.

**Status:** **Done** = built and behaves as written. **Partial** = built but short of the sentence. **Missing** = not
built. **Deferred-by-spec** = the spec puts it under "Later". Items marked *fixed in this review* were Partial or
Missing when the review started and were completed, with tests (see the last section).

Paths are relative to the repository root; `file:line` points at the function or block that implements the rule.

---

## 1. The big idea

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| The CRM is an attention allocator: who deserves a human, when, with which offer | Done | `src/lib/today/rank.ts:216` (`buildQueue`), `src/lib/metrics/nbo.ts:168` | One ranked Today list per person (who/when) plus a next best offer on every contact and Today row (which offer). |
| 1. A ladder, not a funnel: every customer has a current rung and a next likely rung; every contact page shows the next rung | Done | `src/lib/metrics/ladder.ts:51`, `src/components/contacts/ladder.tsx:13`, `src/app/(app)/contacts/[id]/page.tsx` (LadderCard in the right column) | Current rung = highest rung bought (`contacts.current_rung`, `src/lib/metrics/compute.ts:92`). The next rung jumps to the offer's rung when the offer sits higher. Seen on demo contacts. |
| Workshop buyers enter at Rung 1; offer delegation alumni Premium directly | Done | `src/lib/settings/defaults.ts:291` (ladder families: workshop = rung 1), `src/lib/settings/defaults.ts:425` (NBO rules `delegation`, `delegation_tag`) | Delegation alumni get "The AI Office and premium programs" (the NBO table's wording); the ladder card shows the jump. |
| 2. The machine captures, people enrich: TagMango buyers enter automatically | Done | `src/lib/webhooks/handlers.ts`, `src/lib/contacts/capture.ts:143` | A completed order creates the contact, the verified purchase and its payment with no typing. |
| 3. Three scores, one grade: Fit, Readiness, Value roll up into an Edapt Score and A–D grade | Done | `src/lib/metrics/scoring.ts:322` | See section 11. |
| 4. The First Door is stored forever | Done | `src/lib/contacts/capture.ts:276` (set only on create), `src/lib/contacts/profile.ts:347` (admin-only correction, audited), `src/lib/contacts/merge.ts:104` (merge keeps the oldest) | Returning touches never overwrite it. An admin can correct a mistake; the change is in the audit log. |
| 5. Referrers: each contact shows network value next to its own LTV | Done | `src/lib/metrics/facts.ts:118`, contact page LTV / Network value tiles (`src/app/(app)/contacts/[id]/page.tsx`), referrals tab | "Worth more as a referrer" shows when network value is higher. |
| 6. Beyond-Umer revenue share tracked apart | Done | `src/lib/dashboard/metrics.ts:695` | See section 15. |

## 2. Scope of v1

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| v1 records and alerts; it does not message customers | Done | `src/lib/email.ts` (team email only) | No code path sends WhatsApp, SMS or email to a customer. |
| Every revenue line, incl. ~400 delegation customers as a closed legacy line | Done | `src/lib/settings/defaults.ts:291` (families: workshop, applied_ai_mastery, ai_office, premium, consulting, b2b_program, constituency_program, delegation side group) | Delegation is a side group with no rung; the import preset tags it "Legacy: Delegation". |
| Individuals and B2B accounts (schools, constituency offices, partner firms), all entering as leads | Done | `src/db/schema.ts` (`organisations.kind`: school, constituency_office, company, partner), `src/lib/contacts/organisations.ts:89`, `src/app/(app)/organisations/*` | B2B people enter through the same capture (stage New). |
| INR base currency with AED entry | Done | `src/lib/money/fx.ts:39`, `src/lib/settings/defaults.ts:510` | |
| Web app for laptops that works comfortably on a phone | Done | `src/components/shell/app-shell.tsx` (sidebar / bottom bar) | Checked at 390 px: Today, Quick Add, contact, Log, Rate. |
| Later: WhatsApp and email follow-ups sent from the CRM | Deferred-by-spec | – | One-tap WhatsApp opens wa.me on the salesperson's phone; nothing is sent by the CRM. |
| Later: the customer-experience module | Deferred-by-spec | – | |
| Later: call recording, bank statement matching, sending purchase data back to Meta | Deferred-by-spec | – | |

## 3. Roles

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| Admin (Umer): sees everything; settings, scoring weights, imports, exports | Done | `src/lib/auth/permissions.ts:33` | `settings.manage`, `import.run`, `export.run` are admin only. |
| Manager: all contacts; reassign owners, verify payments, team dashboard | Done | `src/lib/auth/permissions.ts:33`, `src/lib/dashboard/access.ts:10` | |
| Sales: own contacts plus the unassigned pool; add leads, log calls, rate, record payments | Done | `src/lib/auth/scope.ts:10` (`contactScope`), `src/lib/auth/permissions.ts:87` | Every list and search goes through `contactScope`; a single contact 404s via `canViewContact`. |
| Support: all contacts; log support issues and notes without changing the owner | Done | `src/lib/contacts/interactions.ts:46` | Support never edits profiles, rates, sets stages or owns. |

## 4. Capture: every way in

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| TagMango checkout: purchases plus checkouts started or failed, by order webhook | Done | `src/app/api/webhooks/tagmango/route.ts`, `src/lib/webhooks/extract.ts:605`, `src/lib/webhooks/handlers.ts:487` | started/failed become `checkout_started` / `checkout_failed` enquiries; completed orders record a verified purchase (`source: tagmango`). |
| WhatsApp API (Libromi): new chats and replies, by Libromi API or via Pabbly | Done | `src/app/api/webhooks/libromi/route.ts`, `src/app/api/webhooks/pabbly/whatsapp/route.ts`, `src/lib/webhooks/extract.ts:718` | A message after `libromiWindowHours` of silence is a new enquiry; replies inside the window are inbound WhatsApp interactions. |
| Meta lead forms with their form answers, through Pabbly | Done | `src/app/api/webhooks/pabbly/meta-lead/route.ts`, `src/lib/webhooks/extract.ts:793` | Answers are kept on the enquiry note and raw payload; recognised answers fill self-ratings. |
| Website forms (call-back requests such as The AI Office), form webhook or Pabbly | Done | `src/app/api/webhooks/pabbly/website-form/route.ts` | |
| WhatsApp Business app on phones: manual Quick Add | Done | `src/app/(app)/contacts/new/*` | Channel chip "WhatsApp app". |
| Phone calls on company mobiles: Quick Add and call log | Done | Quick Add, `src/app/(app)/contacts/[id]/log/*` | *Fixed in this review:* a call or chat from a known contact can now be added as a new enquiry from Quick Add (`src/app/(app)/contacts/new/actions.ts:21`), so the Channel, the hot-lead check and the Lost/Dormant pull-back also work for manual channels. Before, Quick Add refused known numbers outright. |
| Bank transfer and UPI QR: Record payment with UTR and screenshot, then verified | Done | `src/components/payments/record-payment-form.tsx:72`, `src/lib/money/purchases.ts:747` (`verifyPayment`) | |
| Events, MLA programs, walk-ins: manual, or an attendance sheet through Import | Done | Channel "Walk-in or event"; import preset `program_sheet` (`src/lib/import/presets.ts:10`) | |
| Old data: TagMango history, Zoho, sheets, docs through the import wizard | Done | `src/lib/import/*` | See section 6. |
| Abandoned checkouts: anyone who started paying and has no completed order an hour later becomes a call task at the top of Today | Done | `src/lib/alerts/rules.ts:154`, `src/lib/today/rank.ts` (band "abandoned" first) | Runs every 15 minutes; a later payment marks the checkout "recovered" and closes the task. Seen at the top of a salesperson's Today in the demo. |
| Referrals arrive with the order: affiliate name and phone feed the referral score | Done | `src/lib/webhooks/handlers.ts:438` (`affiliateReferrer`), `src/lib/contacts/capture.ts` (resolveReferrer) | Unknown affiliate phones become a new contact (first door Other), linked as referrer. |
| Self-ratings arrive with the order: custom checkout fields | Done | `src/lib/webhooks/config.ts:61`, `src/lib/contacts/capture.ts:486` | |
| Route every new enquiry to the Libromi number | Done | `docs/INTEGRATIONS.md` | Operational guidance for Edapt's ads and website, not CRM code; the Libromi pipe it relies on is built. |

## 5. One person, one record

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| The phone number is the identity key: every channel, import and purchase attaches to one contact per normalised number | Done | `contacts_phone_uq` in `src/db/schema.ts`, `src/lib/contacts/capture.ts:143` | Every pipe goes through `captureEnquiry`. |
| 1. Normalise to international format with a standard library, default India | Done | `src/lib/phone.ts:51` (libphonenumber-js/max) | |
| 1. TagMango's separate dial code is joined back on | Done | `src/lib/phone.ts:62` | |
| 1. UAE 05X XXX XXXX becomes +971 5X XXX XXXX | Done | `src/lib/phone.ts:79` (GCC fallbacks), `tests/unit/phone.test.ts` | Checked: "050 123 4567" → +971501234567. |
| 2. Match exact phone, then exact email | Done | `src/lib/contacts/identity.ts:113` | |
| 2. Same name in the same city is only flagged for review, never merged | Done | `src/lib/contacts/identity.ts:132`, `src/app/(app)/duplicates/*` | |
| 3. Extra numbers and emails stored as alternates, and they match too | Done | `src/lib/contacts/identity.ts:35` (primary or alternate) | |
| 4. A merge keeps the oldest First Door, the first owner, every purchase and note | Done | `src/lib/contacts/merge.ts:69`, `:104`, `:158` | Child rows are re-pointed, never deleted. |
| 4. Nothing is deleted, every merge is logged, any merge can be undone | Done | `contact_merges` table, `src/lib/contacts/merge.ts:264` (`undoMerge`) | |
| 5. The duplicate check runs while typing and shows the existing contact and owner before saving | Done | `src/app/(app)/contacts/new/check/route.ts:14`, `src/app/(app)/contacts/new/quick-add-form.tsx:381`, `src/lib/contacts/identity.ts:172` | A salesperson who cannot open the record sees its name and owner and can request a transfer. |

## 6. Importing the 50,000 old records

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| The first number the import gives is the true count of unique customers | Done | `src/lib/import/batches.ts:716` (`uniqueCustomerCount`), Import page | |
| Import order: TagMango, Zoho, delegation list, MLA/constituency sheets, everything else | Done | `src/lib/import/types.ts:45` (`IMPORT_ORDER`), Import page guidance | The order is guidance with a checklist of committed sources; it is not enforced. |
| TagMango rows are real payments | Done | `src/lib/import/presets.ts` (`lockedForSource`), `src/lib/import/commit.ts` | Imported orders are verified purchases with a verified payment row, so they count toward LTV. |
| Zoho: owners and notes carry over | Done | preset `zoho` (`ownerFromFile: true`) | |
| Delegation list tagged Legacy: Delegation | Done | preset `delegation` | |
| MLA and constituency sheets tagged by program | Done | preset `program_sheet` (`tagWithCampaign`) | |
| Step 1: upload a CSV, an Excel file or a doc | Done | `src/lib/import/parse.ts:255` | .csv, .xlsx, .docx, .txt (old .xls/.doc get a clear "save as" message). |
| Step 2: AI proposes the column mapping; for docs it pulls rows out of free text; you confirm | Done | `src/lib/import/ai.ts:73`, `:160`, heuristic fallback `src/lib/import/heuristic.ts` | |
| Step 3: clean: phones normalised, names proper case, emails lower case, dates and amounts parsed, currency detected | Done | `src/lib/import/clean.ts` (`detectCurrency` at :448) | |
| Step 4: match against existing contacts with the rules above | Done | `src/lib/import/match.ts:128` | |
| Step 5: review counts of New, Will merge, Conflict, Invalid, with one-click fixes for conflicts | Done | `src/lib/import/batches.ts:490`, `:516`, `src/components/import/review-rows.tsx` | |
| Step 6: commit; each import is a batch undone in one click; every row keeps its raw original | Done | `src/lib/import/commit.ts:115`, `src/lib/import/undo.ts:54`, `import_rows.raw` | |
| First Door from the source (delegation → Delegation, constituency sheet → MLA program) | Done | `src/lib/import/presets.ts:10` | |
| Missing fields stay empty and are never guessed | Done | `src/lib/import/clean.ts` | One deliberate exception, shared by every channel: a new contact's country is filled from its phone number and marked as a guess (`field_sources.country = "system"`), so any real country replaces it later. |
| Delegation customers are a priority pool: they surface first for The AI Office and premium programs | Done | NBO rules `delegation` / `delegation_tag` (checked before every other buying rule) | Filter Contacts by tag "Legacy: Delegation" to work the pool. |

## 7. Labels: Channel, First Door, Campaign, Tags

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| Salespeople pick labels from dropdowns; lists are edited in Settings | Done | `src/app/(app)/settings/lists/*`, `src/lib/admin/lists.ts` | Stored as keys, shown with labels. |
| Channel: a new value with every enquiry; the 8 options | Done | `src/lib/settings/defaults.ts:178`, `enquiries.channel` | "Import" and "TagMango checkout" are system-only in Quick Add. |
| First Door: set once, never overwritten; the 12 options | Done | `src/lib/settings/defaults.ts:189` | |
| Campaign: per enquiry; the 4 examples | Done | `src/lib/settings/defaults.ts:204`, `enquiries.campaign` | `first_campaign` and `last_campaign` kept on the contact. |
| Tags: any time; the 4 examples | Done | `src/lib/settings/defaults.ts:211` | |
| After 90 days, LTV by First Door shows which doors produce valuable customers | Done | `src/lib/dashboard/metrics.ts:262` | |

## 8. Customer profile

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| Only phone, name, Channel and First Door are needed to save a contact | Done | `src/app/(app)/contacts/new/actions.ts:21` | |
| Phone (normalised; system or sales; required) | Done | `src/lib/phone.ts:51` | |
| Name (required) | Done | Quick Add, `src/lib/contacts/profile.ts:177` | |
| Channel, First Door (dropdowns, required) | Done | Quick Add | |
| Alternate phones, email | Done | Edit contact → Alternate numbers and emails | |
| Contact type: Individual or Business, default Individual | Done | `contacts.type` default `individual` | |
| Organisation: link to a school, office or company; required for B2B | Done | `src/lib/contacts/profile.ts:279` | *Fixed in this review:* a contact switched to Business must be linked to its organisation (was optional). Older business records without one can still be edited. |
| City, state, country: search dropdown; system (TagMango country) or sales | Done | `src/lib/contacts/places.ts:18`, `src/app/(app)/contacts/[id]/edit/edit-form.tsx`, Quick Add city | *Fixed in this review:* city and state were plain text boxes; they are now search dropdowns (suggestions from the Kerala cities and metros in Settings, GCC cities, Indian states and emirates, and what the team already typed; free text still allowed). Country was already a dropdown. |
| Preferred language: Malayalam, English, Hindi, Arabic, Tamil, Other | Done | `src/lib/settings/defaults.ts:218` | |
| Age band (sales or self-rating) | Done | `src/lib/settings/defaults.ts:227`, Rate screen | |
| Industry or role (dropdown) | Done | `src/lib/settings/defaults.ts:236` | |
| Designation, company name | Done | Edit contact | |
| Spending power bands 1–5 | Done | Rate screen | |
| AI knowledge 0–5 (sales or self-rating) | Done | Rate screen, self-ratings | |
| Umer familiarity 0–5 (sales or self-rating) | Done | Rate screen, self-ratings | |
| Gut rating 1–5 stars | Done | Rate screen | |
| Sales notes | Done | Rate screen notes, Edit contact | |
| Referred by: link to another contact (TagMango affiliate or sales) | Done | Edit contact → Referrer, `src/lib/webhooks/handlers.ts:438` | |
| Marketing consent: yes or no, with date | Done | `contacts.consent` / `consent_at`, Edit contact, details tab | |
| Tags: multi-select | Done | Edit contact, Quick Add | |
| Owner, first owner: automatic | Done | `src/lib/contacts/assignment.ts:83` | |
| Calculated, read-only: LTV, purchase count, product families bought, first and last purchase, average gap, expected next purchase, repeat probability, Fit, Readiness, Value, Edapt Score, grade, network value | Done | `src/lib/metrics/compute.ts:178`, details tab "Calculated" section | All listed fields are shown read-only; none is editable. |
| Preferred language doubles as the expansion meter | Done | `src/lib/dashboard/metrics.ts:761` | |

## 9. Lifecycle stages

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| Eight stages; the system moves contacts through six; salespeople set only Qualified and Lost | Done | `src/lib/metrics/stage.ts:38`, `src/lib/contacts/lifecycle.ts:25` | new, contacted, first_purchase, repeat, advocate, dormant are automatic. Dormant = no activity for `thresholds.dormantDays` (180, a setting; the spec gives no number). |
| Checkout buyers jump from New straight to First Purchase | Done | `src/lib/metrics/stage.ts:49` | |
| Lost needs a reason from: price, timing, not interested, wrong number, bought elsewhere, other | Done | `src/lib/settings/defaults.ts:250`, `src/lib/contacts/lifecycle.ts:25` | |
| Lost reasons show on the dashboard as product feedback | Done | `src/lib/dashboard/metrics.ts:912` | |
| Any new enquiry or payment pulls a Dormant or Lost contact back into the right stage | Done | `src/lib/metrics/stage.ts:38` | A contact that was Qualified before going Dormant comes back as Contacted (it is re-qualified by hand). Manual enquiries from known contacts now come in through Quick Add (fixed above). |

## 10. Ownership and handover rules

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| Exactly one owner at a time; first owner recorded forever; every change logged with a reason | Done | `src/lib/contacts/assignment.ts:83` (`setOwner`, the only writer of `owner_id`), `ownership_log` | |
| 1. New leads auto-assigned: GCC numbers to Dubai, all others to Kerala, then round robin among active salespeople | Done | `src/lib/contacts/assignment.ts:41`, `src/lib/contacts/rules.ts:254` | A salesperson's own Quick Add makes them the owner (they hold the conversation); webhooks, support entries and imports auto-assign. |
| 2. Returning contacts go to their current owner | Done | `src/lib/contacts/capture.ts:435` | An owner who left without a handover is treated as the pool. |
| 3. The first owner never changes | Done | `src/lib/contacts/assignment.ts:83` (`first_owner_id` only filled when empty), merge keeps the older one | |
| 4. An open lead with no logged interaction for 7 days returns to the pool and alerts the manager; customers never expire | Done | `src/lib/contacts/assignment.ts:301`, `src/lib/alerts/rules.ts:483` | Lost and Dormant contacts are not open leads either. |
| 5. Only the manager or admin reassigns; salespeople request a transfer | Done | `src/lib/contacts/assignment.ts:172`, `:422`, `:519` | Requests show on the manager's Today. |
| 6. Sales credit: owner credited if they logged an interaction in the 30 days before; otherwise self-serve; manager can adjust | Done | `src/lib/money/credit.ts:30`, `:71`, Payments → purchase page | |
| 7. Support never owns; logs on any contact without changing the owner | Done | `src/lib/contacts/assignment.ts` (`assertAssignableOwner` rejects support), `src/lib/contacts/interactions.ts:46` | |
| 8. When someone leaves, all their contacts move to the manager in one action, with full history | Done | `src/lib/contacts/assignment.ts:211`, `src/lib/admin/users.ts:277` (Settings → Users → Deactivate) | Set-based; the manager is suggested as the receiver. |
| Rule 6 gives assisted versus self-serve revenue | Done | `src/lib/dashboard/metrics.ts:514` | |

## 11. Purchases, payments and LTV

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| LTV counts cash received, in INR, net of refunds; list prices, unpaid balances and unverified transfers never inflate it | Done | `src/lib/metrics/facts.ts:47` | Only `payments.status = 'verified'` counts. |
| Every purchase records product, list price, discount, final amount, currency, INR value, date, mode, reference (unique), status, credited salesperson, B2B organisation, proof upload | Done | `src/db/schema.ts` (`purchases`), `src/lib/money/purchases.ts:222`, Record payment form | |
| TagMango order: created automatically, verified by default, order ID as reference | Done | `src/lib/money/purchases.ts:333` | |
| Bank transfer or UPI: UTR and screenshot, Unverified; counts toward LTV only after the manager verifies | Done | `src/lib/money/purchases.ts:333`, `:747` | Sales cannot mark a payment verified. |
| Part payment or EMI: one purchase with an instalment schedule; each instalment has a due date and its own status | Done | `src/lib/money/rules.ts:109` (`planInstalments`), `src/lib/money/purchases.ts:526` | |
| Refund: a negative payment with a reason; LTV drops | Done | `src/lib/money/purchases.ts:872` | |
| AED payment stored with its INR value at that month's rate, saved on the payment | Done | `src/lib/money/purchases.ts:247`, `src/lib/money/fx.ts:39` | `fx_rate` and `amount_inr` stored per row. |
| USD as a third currency in Settings, no code change | Done | `src/lib/admin/currency.ts:66`, Settings → Currency | USD is in the defaults; any other code can be added with a monthly rate. |
| B2B deal linked to both the organisation and the person who signed | Done | `purchases.organisation_id` + `contact_id` | |
| LTV = Σ verified payments − Σ refunds (INR) | Done | `src/lib/metrics/facts.ts:66` | |
| Network value = Σ LTV of the contacts they referred | Done | `src/lib/metrics/facts.ts:118` | |
| Duplicate references are rejected | Done | `purchases_reference_uq`, `payments_reference_uq`, `src/lib/money/internal.ts:119` | Friendly message names the existing record. |

## 12. Rating scales and self-rating

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| Four things rated in under 20 seconds on anchored scales | Done | `src/components/today/rate-form.tsx:63` | One screen, chips per scale. |
| AI knowledge anchors 0–5 (word for word) | Done | `src/lib/today/rating-scales.ts:10` | Seen on the Rate screen. |
| Umer familiarity anchors 0–5 | Done | `src/lib/today/rating-scales.ts` | |
| Spending power bands with India yearly and GCC monthly income | Done | `src/lib/today/rating-scales.ts:32` | GCC contacts see the AED bands first, with a switch to the India bands. |
| Gut rating 1–5 stars plus a free-text note | Done | Rate screen | |
| Self-rating at the door: how they first heard of Edapt and how well they know Umer, from WhatsApp one-tap replies or TagMango custom fields | Done | `src/lib/webhooks/config.ts:61`, `src/lib/webhooks/handlers.ts` (`fillSelfReportedFirstDoor`) | The welcome message itself is sent by Libromi (v1 never messages customers); the CRM reads the replies. |
| Self-ratings fill the fields; a salesperson's rating overrides them | Done | `src/lib/contacts/rules.ts:139` (`ratingMayOverwrite`), `src/lib/contacts/profile.ts:65` | A self-rating never overwrites a sales one. |
| Every rating is kept with who gave it and when; the contact shows the latest | Done | `ratings` table, Ratings tab | |

## 13. Scoring formulas

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| Three scores 0–100, an Edapt Score and A–D grade, recalculated every night and after every change | Done | `src/lib/metrics/recompute.ts:165`, `:271` (nightly), callers after every change | |
| Lead: 0.5F + 0.5R + G; customer: 0.25F + 0.25R + 0.5V + G; held between 0 and 100 | Done | `src/lib/metrics/scoring.ts:256` | |
| G: 1★ −10, 2★ −5, 3★ or unrated 0, 4★ +5, 5★ +10 | Done | `src/lib/metrics/scoring.ts:247`, `src/lib/settings/defaults.ts:302` | |
| Grade: A ≥ 75, B 60–74, C 40–59, D < 40 | Done | `src/lib/metrics/scoring.ts:270` | |
| Fit: spending power (band 1–5: 5/10/15/20/25, unknown 10) | Done | `src/lib/metrics/scoring.ts:169` | |
| Fit: industry (business owner 25 … student 5, unknown 10) | Done | defaults `fit.industry` | "IT or healthcare" and "government or freelancer" are separate list items with the same points. |
| Fit: age band (35–44: 25 … 18–24: 8, unknown 12) | Done | defaults `fit.ageBand` | |
| Fit: location (GCC 25, rest of world 20, Kerala cities and metros 18, rest of Kerala 15, rest of India 12, unknown 12) | Done | `src/lib/metrics/scoring.ts:79` | City lists are in Settings → Locations. |
| Readiness: Umer familiarity 8 per level; unknown = level 1 | Done | `src/lib/metrics/scoring.ts:194` | |
| Readiness: AI knowledge 0:10, 1:20, 2:30, 3:30, 4:24, 5:14, unknown 15 | Done | defaults `readiness.aiLevel` | |
| Readiness: recent interest (enquiry, chat or purchase in 7 days 30, 30 days 20, 90 days 10, older 0) | Done | `src/lib/metrics/facts.ts:168` (`last_chat_at`) | A chat is an inbound or answered call/WhatsApp/meeting/email; notes, support issues and unanswered calls do not count. (docs/DOMAIN_API.md's "notes count as recent interest" gap is closed.) |
| Value: money (LTV bands 5/10/15/20/25) | Done | `src/lib/metrics/scoring.ts:225` | |
| Value: frequency (1:5, 2:10, 3:14, 4–5:17, 6+:20) | Done | defaults `value.frequency` | |
| Value: breadth (1:5, 2:13, 3+:20) | Done | defaults `value.breadth` | |
| Value: referrals, paying customers brought (1:10, 2:15, 3+:20) | Done | `src/lib/metrics/facts.ts:118` | Only referred contacts who have paid count. |
| Value: recency (≤90 days 15, 91–180 10, 181–365 5, older 0) | Done | defaults `value.recency` | |
| Worked example 1: GCC business owner → 100 / 92 / 92 / 94 / A | Done | `tests/unit/scoring.test.ts:29`, `tests/integration/metrics-recompute.test.ts:392` | Recomputed by hand in this review. |
| Worked example 2: Kerala-city owner lead → 88 / 84 / – / 86 / A | Done | `tests/unit/scoring.test.ts:60`, `tests/integration/domain-e2e.test.ts:510` | |
| Worked example 3: workshop buyer, nothing rated, rest of Kerala, ₹699 five days ago → 47 / 53 / 30 / 40 / C | Done | `tests/unit/scoring.test.ts:74` | |
| Worked example 4: student lead → 30 / 30 / – / 30 / D | Done | `tests/unit/scoring.test.ts:100` | |
| AI knowledge is a curve; level 5 contacts are better invited as mentors or affiliates | Done | defaults `readiness.aiLevel`, NBO rule `mentor` | |
| Breadth and referrals weigh as much as frequency | Done | defaults (20 / 20 / 20) | |
| Every weight is a starting hypothesis; weights change in Settings with no code change | Done | `src/app/(app)/settings/scoring/*`, Recalculate button | |
| After 90 days, a calibration report shows conversion and repeat rates by score band and by each input | Done | `src/lib/dashboard/calibration.ts:52`, `src/lib/dashboard/calibration-core.ts:34`, Dashboard → Calibration | *Fixed in this review:* the report covered grade, score band, the four Fit inputs, Umer, AI and gut, but none of the five Value inputs nor Recent interest. It now has all twelve inputs: money, purchases, families and paying referrals judged at each matured purchase (today's totals would only measure themselves), and recent interest and recency judged at a snapshot one window ago. |

## 14. Repeat purchase and revenue forecast

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| Days since last purchase: today minus the last paid purchase date | Done | `src/app/(app)/contacts/[id]/_components/details-tab.tsx` (Calculated section), `src/lib/metrics/scoring.ts` (`daysSince`) | *Fixed in this review:* only the date was shown; the contact now shows the number of days. |
| Average gap: mean days between consecutive purchases, for 2 or more | Done | `src/lib/metrics/repeat-core.ts:66` | |
| Expected next purchase: last + average gap; one-time buyers use the median first-to-second gap | Done | `src/lib/metrics/repeat-core.ts:58` | |
| At risk: more than 30 days past the expected next purchase | Done | `src/lib/metrics/repeat-core.ts:74` | |
| Repeat probability (90 days): share of the same cohort (first family, purchases so far) who bought again within 90 days | Done | `src/lib/metrics/repeat.ts:25`, `src/lib/metrics/repeat-core.ts:58` | |
| Expected 90-day revenue = repeat probability × next best offer price | Done | `src/lib/metrics/compute.ts:250` | |
| 90-day forecast = sum over all customers | Done | `src/lib/dashboard/metrics.ts:409` | |
| Cohorts rebuilt every night; a cohort under 30 falls back to the company-wide rate | Done | `src/lib/metrics/recompute.ts:276`, `thresholds.cohortMinSize` | |
| NBO: free only (YouTube, webinar, MLA) → entry workshop ₹699–999 | Done | NBO rule `free` | |
| NBO: one workshop → different topic, or Applied AI Mastery if Fit ≥ 60 | Done | rules `workshop_fit`, `workshop` | |
| NBO: business owner, any workshop → AI Agents for Business, then The AI Office for GCC owners | Done | rules `owner_gcc`, `owner` | |
| NBO: Applied AI Mastery graduate → The AI Office or advanced workshops | Done | rule `aam_graduate` | |
| NBO: The AI Office member → renewal and an ask for referrals | Done | rule `ai_office_member` | |
| NBO: delegation alumni → The AI Office and premium programs | Done | rules `delegation`, `delegation_tag` | |
| NBO: AI knowledge 5 → mentor or affiliate invitation | Done | rule `mentor` | |
| NBO rules editable in Settings | Done | `src/app/(app)/settings/nbo/*` | |

## 15. Alerts and the Today queue

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| One ranked list per salesperson, capped at 40 by default | Done | `src/lib/today/queue.ts:340`, `thresholds.todayCap` | |
| Overdue follow-ups on top; customers by expected revenue, leads by Edapt Score | Done | `src/lib/today/rank.ts:216` | Abandoned checkouts sit above overdue follow-ups (both are "top of Today" in the spec). |
| Every row shows why it is there | Done | `tasks.reason`, `src/components/today/queue-row.tsx` | |
| Abandoned checkout → owner, or the pool; top of Today | Done | `src/lib/alerts/rules.ts:154` | |
| Hot lead: a grade A lead enquires → owner and manager, in-app and email | Done | `src/lib/contacts/capture.ts:529`, `src/lib/alerts/mailer.ts:41` | |
| New lead: a lead is assigned → owner, in-app | Done | `src/lib/contacts/capture.ts:512`, `src/lib/contacts/assignment.ts:172` | Also shown as a derived row on Today until the first call. |
| Untouched lead: no interaction 24 h after assignment → owner; manager at 48 h | Done | `src/lib/alerts/rules.ts:313` | |
| Follow-up due → owner, Today | Done | `src/lib/contacts/interactions.ts:46`, `src/lib/alerts/rules.ts:496` | |
| Due for next rung: within 7 days of the expected next purchase → owner, Today | Done | `src/lib/alerts/rules.ts:598` | |
| At risk: 30 days past the expected next purchase → owner, Today | Done | `src/lib/alerts/rules.ts:649` | |
| Instalment due: EMI due in 3 days or overdue → owner and manager, in-app | Done | `src/lib/alerts/rules.ts:700` | |
| Unverified payment: manual payment unverified after 2 days → manager, email | Done | `src/lib/alerts/rules.ts:814` | |
| New advocate: someone they referred makes a first payment → owner of the referrer, Today: call to thank | Done | `src/lib/money/internal.ts:274` | Not raised for imported history. |
| VIP gone quiet: grade A customer, no activity for 120 days → owner and Umer, email digest | Done | `src/lib/alerts/rules.ts:891`, digests | |
| Lead released: 7 days with no interaction on an open lead → manager, in-app | Done | `src/lib/contacts/assignment.ts:301` | |
| Daily digest at 8:30 am in each user's own time zone | Done | `src/lib/alerts/digest.ts:231`, `src/lib/alerts/schedule.ts:38`, 15-minute cron | |
| Weekly summary to Umer every Monday | Done | `src/lib/alerts/digest.ts:373`, `vercel.json` (Monday 03:30 UTC ≈ 09:00 IST) | |
| Every threshold configurable | Done | `src/lib/settings/defaults.ts:519`, Settings → Alerts & thresholds | |

## 16. Screens

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| Ten screens; the five used all day are phone-first; installable on a phone's home screen | Done | `src/app/manifest.ts:3`, `src/components/shell/service-worker.tsx:4` | |
| Today: the ranked queue with one-tap Call and WhatsApp; used by sales and support | Done | `src/app/(app)/today/page.tsx`, `src/components/contacts/quick-actions.tsx` | Checked at 390 px: every row has `tel:` and `wa.me` buttons. *Fixed in this review:* support's Today was always empty (their follow-ups went to the owner); a follow-up a support person sets on their own support issue now lands on their Today, and the owner still never changes. |
| Quick Add: phone, name, Channel, First Door with the live duplicate check; sales and support | Done | `src/app/(app)/contacts/new/*` | Plus, *fixed in this review*, "Add this enquiry to <name>" for a known number the user can open. |
| Contact page: grade, scores, owner and stage on top; timeline of every touch; tabs for purchases, ratings, referrals and details | Done | `src/app/(app)/contacts/[id]/page.tsx`, `_components/*` | |
| Log interaction: type, outcome chips, next follow-up chips (tomorrow, 3 days, 1 week), a note; under 30 seconds | Done | `src/app/(app)/contacts/[id]/log/*`, `src/components/today/log-form.tsx:23`, `src/lib/contacts/follow-up.ts:9` | Seen at 390 px. |
| Rate customer: four scales with anchors, gut stars, notes, live score preview | Done | `src/app/(app)/contacts/[id]/rate/*`, `src/components/today/score-preview.tsx:50` | The preview uses the same pure scoring code as the server. |
| Record payment: product, amount, INR or AED, mode, UTR, proof upload, instalments; sales and manager | Done | `src/app/(app)/contacts/[id]/payment/*`, `src/components/payments/record-payment-form.tsx:72` | |
| Contacts list: search; filters by grade, stage, door, campaign, owner, product, country, language and tag; saved views | Done | `src/lib/contacts/queries.ts:265`, `src/app/(app)/contacts/page.tsx`, `_components/saved-views.tsx` | *Fixed in this review:* "product" filtered only by product family; there is now a filter for one catalogue product too (`src/lib/contacts/queries.ts:288`), alongside the family filter. |
| Import: the six-step wizard; admin | Done | `src/app/(app)/import/*` | |
| Dashboard: the growth cockpit; Umer and manager | Done | `src/app/(app)/dashboard/page.tsx` | |
| Settings: users, teams, assignment rules, products and rungs, scoring weights, currency rates, alert thresholds, dropdown lists; admin | Done | `src/app/(app)/settings/*` | Also NBO rules, locations, integrations, export and audit log. |
| Tapping Call opens the dialler; on return the Log interaction sheet is already open | Done | `src/components/contacts/call-return-watcher.tsx:12` (mounted in the app shell) | |

## 17. Dashboard: the growth cockpit

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| Revenue this month vs last, by product family | Done | `src/lib/dashboard/metrics.ts:82` | Also month-to-date against the same days last month. |
| Leads and conversion by Channel | Done | `src/lib/dashboard/metrics.ts:178` | Imported history is not counted as leads. |
| LTV by First Door | Done | `src/lib/dashboard/metrics.ts:262` | |
| Repeat rate and median days from first to second purchase | Done | `src/lib/dashboard/metrics.ts:299`, `:316` | |
| Rung moves this month: how many climbed, from which rung | Done | `src/lib/dashboard/metrics.ts:354` | |
| 90-day revenue forecast | Done | `src/lib/dashboard/metrics.ts:409` | |
| At-risk pool: count and expected value | Done | `src/lib/dashboard/metrics.ts:420` | |
| Abandoned checkouts recovered: count and revenue saved | Done | `src/lib/dashboard/metrics.ts:455` | |
| Assisted vs self-serve revenue | Done | `src/lib/dashboard/metrics.ts:514` | |
| Team view: first-response time, contacts handled, conversion and assisted revenue per person | Done | `src/lib/dashboard/metrics.ts:576` | |
| Beyond-Umer revenue share: share of revenue from customers at familiarity 0–2 | Done | `src/lib/dashboard/metrics.ts:695` | Unrated customers are reported apart, with a 6-month trend. |
| Language mix: share of customers whose language is not Malayalam | Done | `src/lib/dashboard/metrics.ts:761` | |
| Referral leaderboard: top advocates and their network revenue | Done | `src/lib/dashboard/metrics.ts:813` | |
| Data health: unrated contacts, unverified payments, possible duplicates | Done | `src/lib/dashboard/metrics.ts:859` | |

## 18. Data model

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| One Postgres database | Done | `src/db/schema.ts` | |
| users: name, email, role, team, timezone, active | Done | `users` | |
| contacts: every listed field | Done | `contacts` | `consent` plus `consent_at`; `alt_emails` added. |
| organisations: name, kind, city, country | Done | `organisations` | |
| enquiries: contact, channel, campaign, product_interest, raw_payload, received_at, status | Done | `enquiries` | |
| interactions: contact, user, type, outcome, summary, next_follow_up_at | Done | `interactions` | |
| ratings: contact, rated_by (user or self), ai, umer, spending, gut, notes, created_at | Done | `ratings` (`rated_by_user_id` + `source` sales/self/import) | |
| products: name, family, rung, list_price, currency, active | Done | `products` | |
| purchases: every listed field, reference unique, source tagmango/manual/import | Done | `purchases` | |
| payments: purchase, kind payment/refund, amount, currency, amount_inr, due_at, paid_at, mode, reference, verified_by, proof_url | Done | `payments` | |
| ownership_log: contact, from, to, reason, changed_by, changed_at | Done | `ownership_log` | |
| tasks: contact, user, type, reason, due_at, status | Done | `tasks` | |
| import_batches: file_name, source, uploaded_by, counts, status | Done | `import_batches` | |
| import_rows: batch, raw, mapped, match_result, contact | Done | `import_rows` | |
| settings: key, value (json) | Done | `settings` | |
| audit_log: table, row, field, old, new, user, changed_at | Done | `audit_log` | |
| Calculated columns: ltv_inr, purchase_count, family_count, first/last_purchase_at, avg_gap_days, next_expected_at, repeat_prob_90d, expected_90d_inr, next_offer, fit, readiness, value, edapt_score, grade, network_value_inr | Done | `contacts`, written only by `src/lib/metrics/recompute.ts` | |
| Webhook handlers are idempotent: the same order or message twice changes nothing | Done | `webhook_events.event_key`, `enquiries.source_ref`, `purchases.reference`, `payments.reference`, `interactions.external_ref` | Covered by `tests/integration/webhooks.test.ts`. |

## 19. Tech stack, hosting, data hygiene

| Requirement | Status | Where | Notes |
| --- | --- | --- | --- |
| Next.js app on Vercel; Supabase (Mumbai) for database, login and files | Done | `vercel.json` (region bom1), `src/lib/storage.ts`, README "Deploy" | Login is the app's own email + password with DB sessions (Postgres in Supabase). |
| Scores and alerts rebuilt overnight from the same database | Done | `src/app/api/cron/nightly/route.ts`, `src/lib/alerts/jobs.ts` | |
| Pabbly / Zapier / Make bridge for Meta and website forms | Done | `/api/webhooks/pabbly/*`, `docs/INTEGRATIONS.md` | |
| Claude API for import mapping | Done | `src/lib/import/ai.ts` | Heuristic fallback without a key. |
| Transactional email for daily and weekly digests | Done | `src/lib/email.ts` (Resend) | Logged instead when no key is set. |
| Data stays in India (Supabase Mumbai) | Done | README "Deploy", `vercel.json` | A deployment setting. |
| Salespeople see only their own contacts and the pool | Done | `src/lib/auth/scope.ts:10` | |
| Only the admin can export, and every export is logged | Done | `src/app/api/export/handler.ts`, `src/lib/admin/export.ts` | Refused attempts are logged too. |
| Daily backups kept 7 days | Done | Supabase Pro (README "Data hygiene") | A hosting feature, not app code. |
| A consent field on every contact (DPDP, UAE) | Done | `contacts.consent`, `consent_at` | |
| Accounts to open before Phase 1 | Done | README "Deploy" | A checklist for Edapt, not code. |

## 20. Decisions still open (defaults)

| Decision | Status | Where | Notes |
| --- | --- | --- | --- |
| Manager with reassign and payment-verify rights: Umer | Done | `src/lib/alerts/core.ts:108` (`managerIds`) | Every admin acts as manager until a manager user exists. |
| Kerala / Dubai split: GCC leads to Dubai, others to Kerala | Done | `src/lib/settings/defaults.ts:277` | |
| Sales credit tracked for reporting only | Done | `purchases.credited_user_id`, `assisted` | Nothing touches pay. |
| Untouched lead returns to the pool after 7 days | Done | `thresholds.leadReleaseDays` | |
| The manager verifies bank and UPI payments | Done | `payments.verify` permission | |
| Self-rating questions in the WhatsApp welcome message | Done | Libromi button replies (`DEFAULT_SELF_RATING_CONFIG.buttons`) | |
| Spending bands and score weights as in the spec, reviewed after 90 days | Done | `src/lib/settings/defaults.ts:302`, calibration report | |
| Current product list and prices | Done | `scripts/starter-products.ts`, Settings → Products | Placeholders seeded; real prices go in before go-live. |

---

## What this review changed

| Gap | Fix | Tests |
| --- | --- | --- |
| Organisation was optional for a Business contact ("Required: For B2B") | `updateContactProfile` refuses to make a contact Business, or unlink a Business contact's organisation, without one (`src/lib/contacts/profile.ts`) | `tests/integration/contacts-profile.test.ts` ("a business (B2B) contact needs its organisation") |
| City and state were free text, not search dropdowns | `placeSuggestions` / `builtInCities` (`src/lib/contacts/places.ts`), `placeSuggestionList` (`src/lib/contacts/rules.ts`), datalists on Edit contact and Quick Add | `tests/unit/contacts-rules.test.ts` |
| "Days since last purchase" was not shown | Calculated section of the contact's details tab | Checked in the running app |
| Contacts list "product" filter only knew product families | `product` filter (one catalogue product, paid or part-paid) in `src/lib/contacts/queries.ts`, a "Product bought" select on Contacts; also honoured by the export | `tests/integration/contacts-queries.test.ts` ("filters by one product bought") |
| Quick Add refused a known number, so a manual enquiry from an existing contact could not be recorded (no Channel, no hot-lead check, no Lost pull-back) | "Add this enquiry to <name>" when the user can open the record; name and first door are kept; the owner rule is unchanged | Exercised end to end in the running app (enquiry added with channel Phone call, redirected to the contact) |
| Support's Today was always empty | A follow-up a support person sets on a support issue is theirs (`src/lib/contacts/interactions.ts`) | `tests/integration/contacts-interactions.test.ts` |
| Calibration report missed the five Value inputs and Recent interest | Value inputs judged at each matured purchase; Recent interest and Recency judged at a snapshot one window ago (`src/lib/dashboard/calibration.ts`, `calibration-core.ts`) | `tests/unit/dashboard-calibration.test.ts`, `tests/integration/dashboard-calibration.test.ts` |

## Known limits (by design, not gaps)

- The import order is guidance, not enforced: a later source can be imported first, and matching still merges correctly.
- A contact that was Qualified before going Dormant comes back as Contacted when it returns; Qualified is set by hand again.
- A new contact's country is filled from its phone number and marked as a guess; any real country replaces it.
- The calibration report groups people by today's ratings (there is no rating history by date); the Value and time
  inputs are measured at the moment that matters, as described above.

## Beyond the spec

Everyday CRM capabilities the spec takes for granted, found missing or partial when the app was compared with
HubSpot / Zoho / Pipedrive-class CRMs for a five-salesperson team ([docs/CRM_GAP_ANALYSIS.md](CRM_GAP_ANALYSIS.md)).
Built in October 2026 on the spec's own rules (stages, scope, ownership, audit); nothing the spec defers to "Later"
(sending WhatsApp or email, telephony, bank matching, Meta CAPI) was built.

| Capability | Where | Rules it keeps | Tests |
| --- | --- | --- | --- |
| Tasks and reminders: title, due date and time, assignee (self; managers anyone), optional contact and notes; edit, reschedule, done, cancel, reopen; My tasks / Overdue / Upcoming / Team tasks / Done | `/tasks`, `/tasks/new`, `/tasks/[id]`; `src/lib/tasks/service.ts`, `rules.ts`, `view.ts`; task type `task` (additive) | Due tasks land on Today (`src/lib/today/queue.ts`); overdue ones sit with overdue follow-ups (`OVERDUE_BAND_TYPES` in `rank.ts`). A logged call never closes a task. The assignee must be able to see the contact (contactScope rules). A task given to someone else notifies them. Follow-ups are rescheduled and completed here but never edited or cancelled (the Dismiss rule). | `tests/unit/beyond-spec-rules.test.ts`, `tests/integration/beyond-spec.test.ts`, `tests/e2e/tasks.spec.ts` |
| Agenda: day and week view of the person's tasks and follow-ups | `/tasks?view=agenda`, `agendaWindow` in `src/lib/tasks/rules.ts` | Whole local days in the person's time zone (DST-safe); overdue work is counted above it | same |
| "Add task" on the contact page and on Today | `src/components/contacts/contact-extras.tsx`, Today header | Returns to where it started (`safeReturnPath`) | `tests/e2e/tasks.spec.ts` |
| Pipeline board: eight lifecycle columns with grade, owner, next offer and LTV; filters (owner, grade, first door) | `/pipeline`, `src/lib/pipeline/board.ts`, `src/components/pipeline/board.tsx` | Scoped by `contactScope`. Only Qualified, Lost (with a reason from the list) and Reopen can be set (`moveIntent` in `src/lib/pipeline/rules.ts`), through `setManualStage` / `reopenContact`; the board says the other six move by themselves. Drag on laptops (a drop bar keeps the targets on screen), Move on phones. Counts and money per column in SQL; at most 25 cards per column with a link to the full list. | `tests/unit/beyond-spec-rules.test.ts`, `tests/integration/beyond-spec.test.ts`, `tests/e2e/pipeline.spec.ts` |
| Global search (sidebar, phone top bar, Ctrl/Cmd+K) | `src/components/shell/global-search.tsx`, `/api/search`, `src/lib/search/global.ts` | Contacts through the Contacts list's own search condition inside `contactScope` (phone in any format); organisations; screens the role may open | `tests/integration/beyond-spec.test.ts`, `tests/e2e/search.spec.ts` |
| Quick notes with one pinned note at the top of the contact | `src/lib/contacts/notes.ts`, `src/components/contacts/notes-card.tsx`, `interactions.pinned_at` (additive) | A note is an interaction of type note (timeline, audit of pinning). A note does not answer a follow-up (`logInteraction`) and does not make a lead Contacted (`facts.ts` `has_outbound`): writing "call back Friday" is not the call. | `tests/integration/beyond-spec.test.ts`, `tests/e2e/notes-privacy.spec.ts` |
| Erase a person's data on request (admin) | `src/lib/contacts/privacy.ts`, contact page Privacy card, `contacts.erased_at` / `erased_by_id` (additive), permission `contacts.erase` | Name, phone, email, alternates, free text, raw payloads, import rows, webhook payloads and the contact's audit values are wiped; purchases and payments stay (anonymised) so LTV and revenue do not move; open tasks close, alerts go; merged-in rows erased too and their merges can no longer be undone; refused while a payment is unverified or scheduled; audited without personal data; erased contacts leave every list and search (`contactScope`). | `tests/integration/beyond-spec.test.ts`, `tests/e2e/notes-privacy.spec.ts` |
| Marketing consent in one tap | Contact page Privacy card, `setConsent` | Through `updateContactProfile` (same rights, consent date, audit and recompute as the Edit form) | same |
| WhatsApp message templates with {name}, {first_name}, {offer}, {owner} | Settings → Message templates (`/settings/templates`), setting `templates.whatsapp`, `src/lib/templates/whatsapp.ts`, WhatsApp button on the contact page | Fills a wa.me link only; the salesperson sends it (spec "Later" for sending). Saving is admin-only and audited. | `tests/unit/beyond-spec-rules.test.ts`, `tests/e2e/notes-privacy.spec.ts` |
| Team activity feed (managers, admins) | `/activity`, `src/lib/activity/feed.ts` | Only what people did (calls and messages, leads added, payments recorded and verified, stage and owner changes, tasks done), newest first, filter by person and kind, cursor paging | `tests/integration/beyond-spec.test.ts`, `tests/e2e/activity.spec.ts` |

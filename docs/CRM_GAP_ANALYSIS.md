# CRM gap analysis: Edapt CRM vs everyday CRM expectations

October 2026. Compares the app with what a sales team expects from a HubSpot / Zoho / Pipedrive-class CRM, for
Edapt's size: **5 salespeople, about 5 support people, 2,000 new buyers a month**. The product spec
(`docs/SPEC.md`) stays the source of truth; this page only adds the everyday CRM habits the spec takes for granted.

Priority: **Must** = a 5-person team would trip over its absence in week one; **Should** = expected soon, cheap
enough to build now or next; **Later** = useful, not needed for go-live, or deferred by the spec.

Status is after the "Beyond the spec" build (the right-hand column says what was added). Items the spec defers
("Later" in docs/SPEC.md: sending WhatsApp or email from the CRM, telephony, bank statement matching, Meta CAPI)
stay Later whatever other CRMs do.

| # | Capability | Before | Now | Where in the code | Priority | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Contacts | Present | Present | `src/app/(app)/contacts/*`, `src/lib/contacts/*` | Must | Phone is identity; Quick Add with live duplicate check; profile, ratings, purchases, referrals, timeline. |
| 2 | Companies (organisations) | Present | Present | `src/app/(app)/organisations/*`, `src/lib/contacts/organisations.ts` | Must | People, revenue and purchases per B2B account; link people from the organisation page. |
| 3 | Leads / pipeline board | Partial (stage filter on the list only) | Present | `/pipeline`: `src/app/(app)/pipeline/*`, `src/lib/pipeline/board.ts` | Must | Columns for the eight lifecycle stages, scoped by `contactScope`, grade/owner/next offer/LTV per card, filters (owner, grade, first door). Drag (or "Move" on phones) only into Qualified, Lost (with reason) and out of Lost (Reopen): the other six stages are set by the system, and the board says so. |
| 4 | Tasks and reminders with due date and assignee | Partial (follow-ups only, created by logging a touch; alerts) | Present | `/tasks`, `src/lib/tasks/*`, task type `task` | Must | Manual task with title, due date and time, assignee (self; managers anyone), optional contact and notes; edit, reschedule, complete, reopen. Due tasks land on Today (overdue ones with overdue follow-ups). Assigning to someone else notifies them. |
| 5 | Calendar / agenda | Missing | Present (agenda) | `/tasks?view=agenda` | Should | Day and week agenda of the signed-in person's follow-ups and tasks. No calendar sync (Google/Outlook): Later. |
| 6 | Notes | Partial (a "note" interaction through the full Log screen) | Present | Contact page "Notes" card, `src/lib/tasks/notes.ts` | Must | One-field "Add note" on the contact page; pin one note so it shows at the top of the contact. |
| 7 | Activity timeline per contact | Present | Present | `getContactTimeline` in `src/lib/contacts/queries.ts` | Must | Enquiries, interactions, purchases, payments, ratings, owner and stage changes. |
| 8 | Team activity feed | Missing | Present | `/activity`, `src/lib/activity/feed.ts` | Should | Managers and admins: calls and messages logged, leads added, payments recorded and verified, stage and owner changes, tasks, newest first, filter by person and kind. |
| 9 | Assignment and routing | Present | Present | `src/lib/contacts/assignment.ts`, Settings → Teams and assignment | Must | GCC → Dubai, others → Kerala, round robin, 7-day release, transfer requests, leaver handover. |
| 10 | Team management (add teammates, roles) | Present (being fixed in parallel) | Present | `/team`, `src/lib/admin/users.ts` | Must | Owned by the team/admin workstream. |
| 11 | Global search | Partial (search box on the Contacts list only) | Present | Top bar / sidebar search, Ctrl/Cmd+K, `src/components/shell/global-search.tsx`, `/api/search`, `src/lib/search/global.ts` | Must | Contacts by name, phone (any format) or email, organisations by name or city, and screens; respects `contactScope`; Enter jumps to the record. |
| 12 | Filters and saved views | Present | Present | Contacts list filters, `saved_views` | Must | Grade, stage, door, campaign, channel, owner, product, family, country, language, tag, at risk, unrated; personal and shared views. |
| 13 | Bulk actions | Partial (bulk reassign) | Partial | `src/app/(app)/contacts/_components/bulk-reassign.tsx` | Should | Bulk tag and bulk stage are not built; reassign (the one the spec needs) is. |
| 14 | Import / export | Present | Present | Import wizard, Settings → Export | Must | Six-step wizard with undo; admin-only, audited CSV export. |
| 15 | Duplicate handling | Present | Present | Quick Add check, `/duplicates`, merge with undo | Must | Same name + city flagged, never merged automatically. |
| 16 | Roles and permissions | Present | Present | `src/lib/auth/permissions.ts`, `scope.ts` | Must | Admin, manager, sales (own + pool), support (all, never owns). |
| 17 | Notifications | Present | Present | Bell (`/notifications`), alert rules, email digests | Must | Now also "a task was assigned to you". |
| 18 | Reports / dashboard | Present | Present | `/dashboard`, calibration report | Must | Owned by the money/dashboard workstream. |
| 19 | Mobile | Present | Present | Phone-first Today, Quick Add, contact, log, rate; bottom bar | Must | New screens work at 390 px: the board scrolls sideways, tasks and search are one-thumb. |
| 20 | Audit | Present | Present | `audit_log`, Settings → Audit log | Must | Erasures, consent changes, task and template changes are audited too. |
| 21 | Data privacy: erase on request | Missing (consent flag only) | Present | Contact page "Privacy" card (admin), `src/lib/contacts/privacy.ts` | Must | DPDP / UAE PDPL readiness: anonymises name, phone, email, notes, raw payloads and audit values; keeps money rows for accounting against the anonymised contact; closes tasks; audited. |
| 22 | Consent toggling | Partial (inside the full Edit form) | Present | Contact page "Privacy" card | Should | One tap to record or withdraw marketing consent, with the date, audited. |
| 23 | Message templates | Missing | Present | Settings → Message templates, `templates.whatsapp` setting, contact page WhatsApp | Should | Admin-defined WhatsApp texts with `{name}`, `{first_name}`, `{offer}`, `{owner}` placeholders, opened as a pre-filled wa.me chat. Sending stays manual (spec "Later"). |
| 24 | Sending WhatsApp / email from the CRM | Missing | Missing | — | Later | Spec "Later": WhatsApp follow-ups through Libromi and the customer-experience module. |
| 25 | Telephony / call recording | Missing | Missing | — | Later | Spec "Later". Call opens the dialler and the Log sheet on return. |
| 26 | Bank statement matching | Missing | Missing | — | Later | Spec "Later". Manual UTR + proof + manager verification instead. |
| 27 | Ad platform feedback (Meta CAPI) | Missing | Missing | — | Later | Spec "Later". |
| 28 | Calendar sync (Google / Outlook), meeting booking links | Missing | Missing | — | Later | The agenda covers the team's own follow-ups. |
| 29 | Email inbox sync / BCC logging | Missing | Missing | — | Later | Edapt sells on WhatsApp and phone; email is rare. |
| 30 | Products / quotes / invoices | Partial (products, purchases, EMIs; no quotes) | Partial | Settings → Products, Record payment | Later | TagMango is the checkout; quotes are rare B2B work. |
| 31 | Custom fields | Missing (fixed profile + editable dropdown lists and tags) | Missing | Settings → Dropdown lists | Later | Tags and lists cover the spec's needs without schema changes. |
| 32 | Workflow automation builder | Partial (fixed alert rules with editable thresholds) | Partial | `src/lib/alerts/rules.ts`, Settings → Alerts | Later | Rules are the spec's; thresholds editable. |
| 33 | Deal value / forecast | Present (as LTV, next best offer, 90-day forecast) | Present | `src/lib/metrics/*` | Must | A person-centric ladder instead of deal records, by design. |
| 34 | Web-to-lead forms | Present | Present | Pabbly website-form webhook | Must | — |
| 35 | Backups / restore | Present (Supabase Pro daily backups) | Present | Infrastructure | Must | — |

## What was built ("Beyond the spec")

Everything marked **Must** that was missing or partial, plus the cheap **Should**s:

1. **Tasks and reminders** (`/tasks`): My tasks, Team tasks (managers and admins), Overdue, Upcoming, Done, and an
   agenda (day / week). Create from the contact page, from Today and from /tasks. A task is a row in `tasks` with the
   new additive type `task`; follow-ups created by logging a touch show in the same lists and can be rescheduled and
   completed there too.
2. **Pipeline board** (`/pipeline`).
3. **Global search** (sidebar on laptops, search button in the phone top bar, Ctrl/Cmd+K anywhere).
4. **Notes with a pinned note** on the contact page (additive column `interactions.pinned_at`).
5. **Agenda** (part of /tasks).
6. **Data privacy**: erase a contact on request (admin) and one-tap consent (additive columns
   `contacts.erased_at`, `contacts.erased_by_id`).
7. **WhatsApp message templates** (Settings → Message templates).
8. **Team activity feed** (`/activity`, in the menu for managers and admins, and in the global search).

## Left for later, and why

- Bulk tag / bulk stage on the Contacts list: the contacts list belongs to the contacts workstream, and only bulk
  reassign is in the spec.
- Calendar sync, inbox sync, quotes, custom fields, an automation builder: not needed for a five-person team selling
  on WhatsApp and phone, and each is a project of its own.
- Everything the spec defers (sending messages, telephony, bank matching, Meta CAPI).

# Security review

Oct 13, 2026. Scope: the whole app (every page, server action and route handler), its auth, files, webhooks, cron,
exports, headers and secrets. Each finding was fixed with a test where it is logic; what remains is listed with
the reason. Tests: `tests/integration/security-authz.test.ts` (every role against every id-taking action) and
`tests/integration/security-auth.test.ts` (auth, secrets, bodies, CSV, files, headers).

## Threat model (brief)

| Who | Wants | Main defences |
| --- | --- | --- |
| Internet stranger | Sign in by guessing, read files or exports, inject leads, run cron | bcrypt + lockout per email/IP; every page and route needs a session; shared secrets on webhooks and cron that fail closed in production; files and exports behind role checks |
| Curious salesperson (signed in) | See or change colleagues' contacts, money, tasks; verify own payments; export | `canViewContact` / `canEditContact` / `contactScope` on every read and write; `can(user, permission)` on every action; ids from the client are never trusted (IDOR tests) |
| Support (signed in) | Take ownership, edit profiles or ratings | Support has only `contacts.viewAll`, `contacts.create`, `interactions.log`; logging never changes the owner; support never owns |
| Manager | Settings, imports, exports, user admin | Admin-only permissions (`settings.manage`, `users.manage`, `import.run`, `export.run`) |
| Malicious upload / payload | Stored XSS through a proof file, CSV formula injection, oversized bodies | Byte sniffing, nosniff + sandbox CSP + download for non-images, formula neutralisation in every CSV, streamed size caps |
| Someone who frames or links the app | Clickjacking, open redirect after sign-in | `frame-ancestors 'none'` + `X-Frame-Options: DENY`; `safeNextPath` on `?next=` and `?return=` |

Trust boundaries: the browser (all input untrusted, server actions are public POST endpoints callable with any
arguments), the webhook senders (authenticated by a shared secret only), Vercel Cron (bearer secret), Supabase
Storage (service key server-side only; the browser only ever gets short-lived signed URLs).

## Fixed in this review

| # | Finding | Fix | Test |
| --- | --- | --- | --- |
| 1 | No sign-in brute-force protection | `login_attempts` table (additive) and `src/lib/auth/login-limit.ts`: 5 failures per email + IP, 20 per email, 50 per IP within 15 minutes lock before the password is checked; a success clears that email + IP; pruned nightly | security-auth: lockout, other IP, success clears, spraying |
| 2 | Unknown email answered faster than a wrong password (user enumeration by timing) | `verifyPassword` runs a bcrypt comparison against a throwaway hash when there is no hash | security-auth: timing |
| 3 | Open redirect after sign-in: `?next=/\evil.com` (browsers read `/\` as `//`) and `/\t/evil.com` passed the check | `safeNextPath` (`src/lib/auth/redirect.ts`): one leading `/`, no backslash or control characters, same origin after URL parsing; `safeReturnPath` (Log / Rate `?return=`) now uses it | security-auth: redirects |
| 4 | `/setup` race: two simultaneous submits could both create an admin (count, then insert) | `createFirstAdmin` counts and inserts in one transaction under `pg_advisory_xact_lock`; password minimum raised from 8 to 10 (same as /account), email validated, audited | security-auth: 4 parallel submits make one admin |
| 5 | Login trimmed passwords while /account keeps surrounding spaces, so such a password could never sign in | Login reads the password as typed and falls back to the trimmed form for older passwords | security-auth: spaces kept |
| 6 | bcrypt cost fixed at 11 with no upgrade path | `BCRYPT_COST`, `needsRehash`: weaker hashes are re-hashed at the next sign-in | security-auth: rehash |
| 7 | Expired sessions stayed in the table forever | `pruneExpiredSessions` in the nightly job (with `pruneLoginAttempts`) | security-auth, alerts-cron |
| 8 | Webhook body cap was checked after `req.text()` / `req.formData()` buffered the whole body (a chunked body without Content-Length could be any size) | `readBodyBytes` streams and stops at 1 MB (413); multipart is parsed from the capped bytes | security-auth: chunked, multipart |
| 9 | Secrets: string comparison leaked length; a blank env var counted as configured | `safeEqual` hashes both sides before `timingSafeEqual`; blank secrets are "missing"; still fail closed in production (logged once) | security-auth: cron + webhooks in production |
| 10 | CSV formula injection: the invalid-rows download let `-2+3+cmd\|' /C calc'!A0` through (`-` followed by a digit), and neither writer handled leading spaces or full-width `＝` | One `neutraliseFormula` (src/lib/admin/csv.ts) used by both CSV writers; phone numbers and negative amounts stay as they are | security-auth: CSV |
| 11 | Proof uploads trusted the browser's MIME type (an HTML page named receipt.png with type image/png was stored) | `sniffFileType` checks the bytes (PNG, JPEG, GIF, WebP, HEIC, PDF); the file is stored under its real extension and type, anything else is refused with a field error | security-auth: fake PNG refused, JPEG renamed |
| 12 | `/api/files` served every type inline (PDF, CSV, XLSX, HEIC) and without a CSP | `storedFileHeaders`: `nosniff`, `Content-Security-Policy: default-src 'none'; …; sandbox`, `inline` only for PNG/JPEG/GIF/WebP, otherwise `attachment; filename=…`; Supabase signed URLs get `download=` for non-images | security-auth: served headers |
| 13 | `/api/files/<key>`: a single URL segment holding an encoded `/` (`..%2F..%2Fetc`) was not split before the `..` check (the read itself was still refused further down) | `cleanStoredKey` splits every segment on `/` before checking | security-auth: keys |
| 14 | No security headers | `src/lib/security-headers.ts` via next.config.ts: CSP (below), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera, microphone, geolocation, payment, … off), `Cross-Origin-Opener-Policy: same-origin`, HSTS (2 years, subdomains) in production; `X-Powered-By` removed | security-auth: headers; checked in a browser on every main screen with no CSP violations |
| 15 | `/api/health` (public) returned the raw database error message | Generic `database unavailable` (503), error logged server-side | — |
| 16 | Webhook verification handshake echoed `hub.challenge` unbounded | Capped at 256 characters, `text/plain` + `nosniff` (only after the secret matched) | — |
| 17 | `npm run db:seed` against a remote database would create the admin with the example password `change-me-now` | Refuses unless `ADMIN_PASSWORD` is set to 10+ characters and not the example (local databases unchanged) | — |

CSP: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:
blob: <Supabase>; font-src 'self' data:; connect-src 'self' <Supabase>; media-src 'self'; worker-src 'self';
manifest-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors
'none'; upgrade-insecure-requests`. Development adds `'unsafe-eval'` and `ws:` for React Refresh.

## Authentication

| Check | Status |
| --- | --- |
| Password hashing | bcrypt cost 11 (`BCRYPT_COST`), upgraded on sign-in when lower. Passwords up to 200 characters (bcrypt reads the first 72 bytes). |
| Session token | 32 random bytes, only its SHA-256 is stored (`sessions.id`). |
| Session cookie | `edapt_session`: `HttpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/`, expires with the session. Verified in the browser. |
| Session expiry | 30 days absolute, checked on every request (`expires_at > now()`); expired rows pruned nightly. |
| Revocation | Deactivating a user deletes all their sessions and `getCurrentUser` also refuses inactive users; an admin password reset ends every session; changing your own password ends every other session; /account can sign out other sessions; sign-out deletes the session row. Role changes apply on the next request (role is read from `users` each time). |
| Brute force | Lockout per email + IP / email / IP (finding 1). |
| Enumeration | Same message and same bcrypt cost for unknown email and wrong password; "deactivated" only after the right password. |
| Timing-safe comparisons | bcrypt for passwords; `safeEqual` (hash + `timingSafeEqual`) for cron and webhook secrets; session lookup is by token hash in SQL. |
| /setup | Only while there are zero users (page redirects, action re-checks under an advisory lock). |
| Open redirect | `safeNextPath` on `?next=`; `safeReturnPath` on `?return=`; `notificationHref` only builds internal paths. |
| CSRF | Server actions: Next.js checks `Origin` against the host. Cookie is `SameSite=Lax`. Route handlers that change state are POST-only webhooks/cron with secrets; GET exports only download to the requester (and are logged). |

## Authorization checklist

Roles (spec): **sales** own + pool contacts only; **support** sees all, logs interactions only, never owns or edits;
**manager** sees all, reassigns, merges, verifies, refunds, adjusts credit, dashboard; **admin** everything plus
settings, users, imports, exports. Every action starts with `requireUser()`; "service" means the domain service
re-checks the same rule. IDOR column: what happens when the id belongs to someone the caller may not touch.
All rows: status OK (re-verified in this review); the ones marked * are exercised by `security-authz.test.ts`.

### Server actions

| File | Action | Check | IDOR on ids |
| --- | --- | --- | --- |
| (auth)/actions.ts | loginAction | public; lockout, safeNextPath | — |
| | logoutAction | session only | — |
| | setupAction | zero users, advisory lock | — |
| account/actions.ts | changePasswordAction, timezoneAction, signOutOthersAction | signed in; act on the session's own user id only (no id parameter) | n/a |
| contacts/[id]/actions.ts | setStageAction * | `contacts.setStage` + `canEditContact` (+ service) | colleague's contact refused |
| | reopenAction * | service: owner, manager or admin | refused |
| | reassignAction * | `contacts.reassign` (+ service; target must be an active non-support user) | sales/support refused |
| | requestTransferAction * | `contacts.requestTransfer` (sales only); handing to a colleague only for contacts you own | support refused |
| | mergeAction *, undoMergeAction * | `contacts.merge` (+ service) | sales refused |
| contacts/[id]/edit/actions.ts | updateProfileAction *, alternateAction *, referrerAction * | `contacts.edit` + `canEditContact` on the loaded contact; first door only by admin | colleague's / support refused |
| contacts/[id]/log/actions.ts | logInteractionAction * | `interactions.log` + visible contact (`loadLogScreen`); Mark lost needs edit rights; logging never changes the owner | colleague's refused; support logs anywhere, owner unchanged |
| contacts/[id]/rate/actions.ts | rateContactAction * | `ratings.edit` + `rateAccess` (never support, own + pool for sales) | refused |
| contacts/[id]/payment/actions.ts | recordPaymentAction * | `payments.record` + view + `canEditContact`; "verified now" needs `payments.verify` | refused |
| contacts/new/actions.ts | quickAddAction | `contacts.create`; sales own what they add; owner choice only for manager/admin (validated assignable); support never owns | duplicate shows owner name by spec |
| contacts/actions.ts | bulkReassignAction * | `contacts.reassign`, ≤ 4 pages of ids | sales refused |
| | saveViewAction * | own views; sharing needs manager/admin | sales cannot share |
| | deleteViewAction * | own views (admin also shared ones), in the WHERE | colleague's view untouched |
| duplicates/actions.ts | mergePairAction *, dismissPairAction * | `contacts.merge` (+ service) | sales/support refused |
| import/actions.ts | prepareImportUploadAction, uploadImportAction, changeSheetAction, saveMappingAction, runImportPhaseAction *, startCommitAction *, startUndoAction *, skipRowsAction, resolveConflictAction, resolveAllConflictsAction, discardBatchAction * | `import.run` (admin) in every action and again in the services; a browser-uploaded key must match `isNewStorageKey("imports", …)` | manager refused |
| notifications/actions.ts | markReadAction *, markAllReadAction, openNotificationAction * | user id in the WHERE; opening checks the contact is still visible | colleague's notification untouched |
| organisations/actions.ts | createOrganisationAction *, updateOrganisationAction | `canManageOrganisations` (sales, manager, admin) | support refused |
| payments/actions.ts | verifyPaymentAction *, rejectPaymentAction * | `payments.verify` + visible contact | sales/support refused |
| | recordInstalmentAction *, addPaymentAction *, cancelPurchaseAction * | `payments.record` + view + edit on the row's contact | colleague's purchase refused |
| | recordRefundAction * | `payments.refund` (manager/admin) | sales refused |
| | adjustCreditAction * | `credit.adjust` (manager/admin) | sales refused |
| settings/actions.ts | recalcScoresChunkAction | `settings.manage` | — |
| settings/{alerts,currency,lists *,locations,nbo,products,scoring,teams-assignment}/actions.ts | every action | `adminForAction()` = `settings.manage` | manager refused |
| settings/integrations/actions.ts | saveFieldPathsAction, saveSelfRatingsAction, saveOptionsAction, reprocessEventAction * | `settings.manage` (+ service for reprocess) | manager refused |
| settings/users/actions.ts | createUserAction *, updateUserAction *, resetPasswordAction *, deactivateUserAction *, reactivateUserAction, handoverContactsAction | `adminForAction()` + `assertAdmin` in the service; last active admin protected; support cannot be given contacts | manager refused (no self-promotion) |
| today/actions.ts | queueTaskAction * | service `canActOnTask`: assignee, manager/admin, or sales on a visible pool task | colleague's task refused |
| | transferDecisionAction * | `contacts.reassign` | sales refused |
| lib/alerts/actions.ts | runAlertsNowAction * | admin + `settings.manage` | manager refused |

### Route handlers

| Route | Auth | Notes |
| --- | --- | --- |
| GET /api/health | public | `{ ok }` only; no error details (finding 15) |
| GET /api/cron/{frequent,nightly,weekly} | `Authorization: Bearer $CRON_SECRET`, constant-time, fail closed in production | 401 otherwise |
| POST/GET /api/webhooks/{tagmango,libromi,pabbly/meta-lead,pabbly/website-form,pabbly/whatsapp} | shared secret (`?token=`, `x-webhook-secret` or Bearer), constant-time, fail closed in production | 1 MB streamed cap, ≤ `MAX_EVENTS_PER_DELIVERY` events, stored raw in `webhook_events` (jsonb, NULs and `__proto__`/`constructor`/`prototype` keys dropped) before processing, idempotent on `event_key` and the domain references; no outbound requests (no SSRF surface) |
| GET /api/export/{contacts,purchases} * | session + `export.run` (admin) in `prepareExport` | refused attempts audited (`export_denied`); successful ones audited with filters and row count before the first byte; CSV formula-safe; `nosniff`, `no-store` |
| GET /api/files/[...key] | session + `canReadStoredFile` (proofs: may view the contact; imports: `import.run`; other folders: nobody) | 404 for anything not allowed; key cleaned (finding 13); headers (finding 12) |
| GET /contacts/new/check | session + `contacts.create` | Quick Add duplicate check: returns the existing contact's name and owner even when the caller cannot open it (spec "The duplicate check runs while typing … shows the existing contact and its owner") |
| GET /import/[batchId]/invalid-rows * | session + `import.run`; refused attempts audited | CSV formula-safe (finding 10) |

### Pages

Every page under `src/app/(app)` is inside the layout that calls `requireUser()`, and each page re-checks:
`contacts/[id]` (+ `edit`, `log`, `rate`, `payment`) use `canViewContact` / the screen loaders and 404 otherwise;
`contacts`, `payments`, `today`, `organisations/[id]` scope lists with `contactScope` (organisation people outside
the viewer's scope are shown without details); `payments/[purchaseId]` checks the contact; `dashboard` needs
`dashboard.view`, `dashboard/calibration` also `settings.manage`; `duplicates` needs `contacts.merge`; `import*`
need `import.run`; every `settings/*` page is `requireUser(["admin"])`; `notifications` and `account` show the
user's own rows only. `(auth)/login` and `(auth)/setup` are public (setup only with zero users).

## Injection and XSS

- SQL: every query goes through Drizzle with bound parameters. The `sql.raw` uses are all constant strings
  (column lists, case expressions, table aliases checked against `^[a-z_][a-z0-9_]*$`); `sql.identifier` only
  takes names from a fixed list (merge). LIKE searches escape `%` and `_`.
- XSS: no `dangerouslySetInnerHTML` anywhere; React escapes everything else. Email HTML (`src/emails/render.ts`)
  escapes every value and only allows `http(s)` links. Links built from data are internal paths, `tel:` /
  `https://wa.me/` from normalised numbers, or `/api/files/` proof URLs written by the server.
- CSV: finding 10.

## Data hygiene (spec)

- Exports are admin-only and logged (both outcomes), see the routes table.
- Marketing consent is stored with its date (`contacts.consent`, `consent_at`), set by capture, profile edits,
  imports and merges, and included in the contacts export.
- Import files (thousands of people's raw rows) are served to admins only.

## Secrets

- `.env.example` holds only placeholders and dev values (`dev-cron-secret`, `change-me-now`, empty API keys); the
  seed refuses the example admin password against a remote database (finding 17).
- No secret is logged: emails without Resend log recipient and subject only; webhook and cron failures log
  messages, not headers or tokens; the health check no longer returns DB errors.
- Nothing secret reaches the browser except, by design, the webhook URLs with their token on the admin-only
  Settings > Integrations page (masked on screen, full value only behind the copy button) so the admin can paste
  them into TagMango / Libromi / Pabbly. No `NEXT_PUBLIC_*` variables exist; the Supabase service key is used
  server-side only and the browser gets per-file signed URLs.

## Remains, and why

| Item | Why it stays |
| --- | --- |
| CSP allows `'unsafe-inline'` scripts | The App Router streams its RSC payload in inline scripts. A nonce-based CSP needs middleware to mint a nonce per request and every page to be dynamic; worth doing later, but React already escapes all output and there is no `dangerouslySetInnerHTML`. |
| Webhook secret can travel in `?token=` | TagMango and Pabbly can only call a URL; query strings can end up in access logs. The header and Bearer forms are accepted and documented as preferred; rotate a secret if logs leak. No HMAC signatures: the senders do not offer them. |
| Per-email lockout can be used to lock someone out | Needs 20 failures from several IPs within 15 minutes and lifts by itself; a lower per email + IP limit catches ordinary guessing first. |
| Sessions last 30 days with no idle timeout | Phone-first app used all day by salespeople; revocation (deactivate, reset, sign out others) covers lost devices. |
| Cookie name has no `__Host-` prefix | Changing it signs everyone out and the middleware reads it by name; `Secure` + `Path=/` + no `Domain` already give the same scope in production. |
| Server action body limit is 25 MB for every action | Needed for import uploads in local mode; every action is behind a session, and on Vercel the platform caps request bodies at about 4.5 MB anyway. |
| Quick Add duplicate check reveals an existing contact's name and owner to any salesperson typing the number | Required by the spec to stop ownership clashes. |
| Clients can be identified only by the IP the platform reports | `x-real-ip` / `x-forwarded-for` are set by Vercel; when self-hosting behind another proxy, make sure it overwrites them. |

# Domain services API

Reference for the services in `src/lib/contacts`, `src/lib/money`, `src/lib/metrics` and `src/lib/alerts`. Screens and pipes call these; they never re-implement domain rules.

Every service takes an optional `tx: Tx = db` as its last argument and runs inside a savepoint. `Actor = { id: string; role: Role }`, and a `SessionUser` can be passed as one. For money, `actor: null` means the system (webhooks, imports, cron).

**`contacts/identity.ts`**
- `lookupByPhone(e164, tx?) → { contact, matchedBy: "phone" | "alt_phone" } | null`
- `lookupByEmail(rawEmail, tx?) → { contact, matchedBy: "email" | "alt_email" } | null`
- `findContactByPhone(e164, tx?) → Contact | null`
- `findContactByEmail(email, tx?) → Contact | null`
- `findSameNameSameCity(name, city, tx?, excludeId?) → Contact[]`
- `matchContact({ phone?, email?, name?, city?, dialCode?, defaultCountry? }, tx?) → MatchResult`
- `flagPossibleDuplicates(contactId, otherIds, reason, tx?) → string[]`
- `checkQuickAddDuplicate(rawPhone, user, { dialCode?, defaultCountry?, tx? }?) → QuickAddDuplicate`

**`contacts/capture.ts`**
- `captureEnquiry(input: CaptureInput, tx?) → CaptureResult`
  - `CaptureResult.before` is the matched contact as it was before the touch (read under lock), null for a new contact.
  - Hot lead / new lead alerts never go to `createdById` (the person who typed the lead in), managers included. `skipAlerts` turns every alert off (imports, and completed TagMango orders: a checkout buyer is a customer, not a lead).
- Also exports `InvalidPhoneError` and `DEFAULT_FIRST_DOOR_BY_CHANNEL`.

**`contacts/assignment.ts`**
- `pickAutoOwner(phoneCountry, tx?) → string | null`
- `setOwner(contactId, toUserId | null, { reason, changedById, moveTasks?, now? }, tx?) → { changed, fromUserId, toUserId }`
- `reassignContacts(ids, toUserId | null, actor, reason, tx?) → number`
- `handoverAllContacts(fromUserId, toUserId, actor, tx?) → number`
- `releaseStaleLeads(now, tx?, { limit? }?) → string[]` (open leads only: never customers, Lost or Dormant contacts)
- `requestTransfer(contactId, requester, reason, toUserId?, tx?) → { created, taskIds }`
- `resolveTransferRequest(taskId, "approve" | "decline", actor, tx?) → { moved }`
- `ownershipHistory(contactId, tx?)`
- Also exports `teamForCountry`.

**`contacts/rows.ts`**
- `selectContacts(where: SQL, tx, { orderBy?, limit?, forUpdate? }?) → Contact[]`: whole-contact reads with a precompiled select list (identical rows to `select().from(contacts)`, about 1 ms less CPU each). Used by `getContact`, the identity lookups and the money services.

**`contacts/unrated.ts`**
- `unratedCondition(table = "contacts") → SQL`: THE definition of "Unrated" (no ratings row from sales, self or import, and none of the four scales set). Used by the Contacts filter (`?unrated=1`), the export and the dashboard's data-health tile. Label: `UNRATED_LABEL` ("Unrated (no rating at all)").

**`contacts/queries.ts`** (read models for the screens; highlights)
- `listAssignableUsers(tx?)` (active sales, then managers, then admins; never support) and `assigneeOptions(tx?)` (the same as picker options, "Kiran (Sales, Kerala)"); `countPoolContacts(viewer, tx?)` (the Contacts list's Pool chip).
- `getContactReferrals(contactId, viewer?, tx?)`, `getOrganisationPeople(viewer, orgId, tx?)`, `getOrganisationPurchases(orgId, viewer?, tx?)`: contacts the viewer may not open come back as `HIDDEN_CONTACT_LABEL` ("Another salesperson's contact") with `hidden: true` and their LTV kept (no name, phone or owner).

**`contacts/organisations.ts`** (highlights)
- `linkContactToOrganisation(contactId, orgId | null, actor, tx?) → { changed }`: from the organisation's page; linking makes the person a Business contact, unlinking makes them Individual again (through `updateContactProfile`, so rights, audit and recompute are the same).

**`contacts/lifecycle.ts`**
- `setManualStage(contactId, "qualified" | "lost", { lostReason? }, actor, tx?) → Contact`
- `reopenContact(contactId, actor, tx?) → Contact`

**`contacts/merge.ts`**
- `mergeContacts(winnerId, loserId, actor, reason?, tx?) → mergeId`
- `undoMerge(mergeId, actor, tx?) → void`
- `dismissDuplicateReview(reviewId, actor, tx?) → void`
- `listOpenDuplicateReviews(tx?, { limit? }?) → OpenDuplicateReview[]`
- `mergeHistory(contactId, tx?)`

**`contacts/profile.ts`**
- `updateContactProfile(contactId, patch: ProfilePatch, actor, tx?) → Contact`
- `applyRating(contactId, RatingInput, "sales" | "self" | "import", actorId | null, tx?, { recompute? }?) → { ratingId, applied, skipped }`

**`contacts/interactions.ts`**
- `logInteraction(contactId, { type, outcome?, summary?, direction?, nextFollowUpAt?, occurredAt?, externalRef? }, actor | null, tx?) → interactionId`

**Contacts pure files** (no server-only imports, safe in client components)
- `follow-up.ts`: `followUpPresets(now, tz)`, `localTimeInDays(now, tz, days, hour?, minute?)`, `FOLLOW_UP_PRESETS`
- `rules.ts`: `assignReason(typed, fromOwnerId, toUserId)` (the ownership-log reason when a manager leaves it empty), `assigneeLabel`, `autoAssignHint` (Quick Add's Assign to hint, including "no salespeople yet"), `SYSTEM_ONLY_CHANNELS`, `isManualChannel` (Quick Add never offers "import" or "tagmango_checkout"), `UNRATED_LABEL`, `decideFirstDoor`, `listKeyFor`, `countryCode`, `isUuid`, `cleanText`, `ratingValueError`, `sanitizeRatings`, `ratingMayOverwrite`, `addUnique`, `laterOf`, `earlierOf`, `excerpt`, `followUpReason`, `orderedPair`, `teamForCountry`, `RATED_FIELDS`
- `errors.ts`: `ContactError` (with `code` and `field`), `InvalidPhoneError`, `ContactValidationError`, `ContactForbiddenError`, `ContactNotFoundError`, `ContactMergedError`, `ContactConflictError`

**`money/purchases.ts`** (all re-exported from `money/index.ts`, which is server-only)
- `recordPurchase(input: RecordPurchaseInput, actor | null, tx?) → { purchaseId, paymentIds, status }`
- `refreshPurchaseStatus(purchaseId, tx?) → PurchaseStatus`
- `recordInstalmentPayment(paymentId, { reference, mode, proofUrl?, paidAt?, amount?, verify? }, actor | null, tx?) → PaymentResult`
- `addPayment(purchaseId, { amount, currency?, reference, mode, proofUrl?, paidAt?, verify? }, actor | null, tx?) → PaymentResult`
- `verifyPayment(paymentId, actor, tx?) → PaymentResult`
- `rejectPayment(paymentId, actor, reason, tx?) → PaymentResult & { rescheduledPaymentId }`
- `recordRefund(purchaseId, { amount, reason, currency?, reference?, refundedAt?, mode? }, actor | null, tx?) → PaymentResult`
- `cancelPurchase(purchaseId, actor | null, reason, tx?) → PurchaseStatus`
- `getContactPurchases(contactId, tx?) → ContactPurchase[]`
- `listPaymentsQueue("unverified" | "due" | "overdue", tx?, now?, { ownerId?, withinDays?, olderThanDays?, limit? }?) → PaymentsQueueRow[]`

**`money/credit.ts`**
- `computeSalesCredit(contactId, purchasedAt, tx?, known?: { ownerId }) → { creditedUserId, assisted, interactionId? }`
- `adjustCredit(purchaseId, userId | null, actor, tx?) → void`

**`money/fx-server.ts`**
- `getFxRate(currency, at, tx?) → number`

**Money pure files** (client-safe)
- `fx.ts`: `rateFromTable(rates, currency, at, tz?)`, `toInr`, `roundMoney`, `roundRate`, `monthKeyOf`, `monthKeyLabel` ("2026-10" → "Oct 2026"), `normalizeCurrency`, `currenciesWithRates`, `BASE_CURRENCY`
- `rules.ts`: `purchaseTotals`, `derivePurchaseStatus`, `ltvInr`, `planInstalments`, `normalizeReference`, `referenceLabel`, `paymentReferenceRequired`, `canMarkVerified`, `positiveAmount`, `notInFuture`, `checkoutResolution`, `withinCreditWindow`, `refundInrValue`
- `errors.ts`: `MoneyError`, `DuplicateReferenceError`, `ValidationError`, `UnknownCurrencyError`, `PermissionError`, `NotFoundError`, `isMoneyError`

**`metrics/recompute.ts`** (server)
- `recomputeContact(contactId, tx?, { now? }?) → void`
- `recomputeContacts(ids, tx?, { now?, ctx?, skipLocked? }?) → number`
- `recomputeReferrerChain(contactId, tx?, { now? }?) → void`
- `recomputeAll({ now?, batchSize?, onProgress? }?) → number`
- `loadMetricsContext(tx?, now?) → MetricsContext`
- `inrConverter(currency, at)`

**Other metrics server files**
- `repeat.ts`: `buildCohorts(tx?, now?) → CohortTable`
- `facts.ts`: `computeMoneyFacts`, `computeReferralFacts` and `computeActivityFacts`, each `(id, tx?)` and each with a `…Bulk(ids, tx?)` form

**Metrics pure files** (client-safe, e.g. for the Rate screen preview)
- `scoring.ts`: `scoreContact(input, cfg, { locations, gccCountries }, now) → { fit, readiness, value, edaptScore, grade, … }`, plus `computeFit`, `computeReadiness`, `computeValue`, `computeEdapt`, `gradeFor`, `gutPoints`, `classifyLocation`, `normalizeCountry`
- `stage.ts`: `computeAutoStage(facts, now, dormantDays)`
- `nbo.ts`: `nextBestOffer(facts, rules, ctx)`, `ruleMatches`, `matchesCondition`, `regionOf`, `cheapestOnRung`, `cheapestInFamily`, `offerCandidates`. Price order: `rule.price` → `rule.productId` product → the active product named `rule.productName` (case-insensitive) → the cheapest active product in `rule.family` → the cheapest active product on the rung above. The product named by steps 2-4 is kept as `productId` even when `rule.price` sets the price.
- `ladder.ts`: `offerRung({ productId, text }, { products, families, rules })`, `ladderPosition({ currentRung, rungs, families, bought, offerRung })` → `{ current, next, nextFromOffer, alsoBought }`: the contact page's ladder card (the next rung jumps to the offer's rung when it sits higher, e.g. delegation alumni → The AI Office; side groups bought show as "Also bought").
- `repeat-core.ts`: `computeRepeatMetrics(facts, { cohorts, thresholds }, now)`, `cohortKey`, `median`, `summarizeCohorts`
- `compute.ts`: `computeCalculatedColumns(contact, facts, ctx, now)`

**Shared**
- `src/lib/utils.ts`: `isUuid(value)` (new)
- Feedback: `toast(message, tone?)` from `src/components/ui/toast.tsx` (client; the `<Toaster>` sits in the signed-in layout) and `flash(message)` from `src/lib/flash.ts` (server action that redirects: the message rides the `edapt_flash` cookie to the next page). `ActionForm` toasts every success message itself.
- `src/lib/settings/index.ts`: `getSetting`, `getSettings`, `setSetting`, `labelFor`, `activeItems`, and `withSettingsSnapshot(fn)`: inside it each setting is read once and reused (bulk jobs such as an import chunk).
- `src/lib/auth/account.ts` (the signed-in person's own account, /account): `changeOwnPassword(userId, { current, next, confirm }, keepSessionId, tx?) → { sessionsEnded }` (current password required, `MIN_PASSWORD_LENGTH` = 10, signs out every other session), `setOwnTimezone(userId, tz, tx?) → changed`, `signOutOtherSessions(userId, keepSessionId, tx?) → number`, `listOwnSessions(userId, currentSessionId, now?, tx?)`, `describeUserAgent(ua)`, `AccountError` (a password change also voids open reset links). `src/lib/auth/session.ts` adds `currentSessionId()`.
- `src/lib/auth/password-reset.ts` ("Forgot password?", /forgot and /reset): `emailResetAvailable(env?)` (RESEND_API_KEY and APP_URL both set; links are never built from the Host header), `appBaseUrl(env?)`, `requestPasswordReset(email, ip, now?, tx?) → { sent, reason? }` (same answer whether or not the email has an account; `RESET_LIMITS` 3 links per person and 10 requests per IP an hour; a failed send keeps no link), `checkResetToken(token, now?, tx?)`, `resetPasswordWithToken(token, { next, confirm }, now?, tx?)` (single use, `RESET_TTL_MINUTES` = 60, voids the person's other links, ends their sessions, audited), `voidResetLinks(userId, now?, tx?)` (also on an admin reset), `prunePasswordResets(now)` (nightly). Table `password_resets` stores only the token's sha256.
- `src/lib/admin/onboarding.ts` (the admin's "Getting started" checklist on Today and Settings): `getOnboardingFacts(tx?)`, `getOnboarding(tx?) → { items, done, total, complete }`, `onboardingDismissed(userId)`, `setOnboardingDismissed(userId, dismissed)` (`users.onboarding_dismissed_at`). The items come from the data by the PURE `buildChecklist(facts)` in `src/lib/admin/checklist.ts` (status line: `checklistSummary(items)`): teammates, an audited product edit, saved teams/assignment (or a salesperson in every team that gets leads), a webhook delivery, a committed import, saved currency rates. `src/lib/admin/invite.ts`: `inviteMessage(...)`, `whatsappShareLink(message, e164?)` (the message shown with a temporary password). Team management lives at `/team` (admins manage; managers read); `/settings/users/*` redirect there.
- `src/lib/auth/login.ts`: `authenticate(email, password, ip, now?) → { ok, userId } | { ok: false, error }` (lockout checked before the password, one bcrypt comparison even for an unknown email, same message for unknown email and wrong password, weaker hashes upgraded), `createFirstAdmin({ name, email, password })` (race-safe under an advisory lock), `setupOpen()`. `src/lib/auth/login-limit.ts`: `checkLoginAllowed(email, ip, now?)`, `recordLoginAttempt(email, ip, success, now?)`, `clientIp(headers)`, `LOGIN_LIMITS` (5 failures per email + IP, 20 per email, 50 per IP in 15 minutes; table `login_attempts`), `pruneLoginAttempts(now)` and `pruneExpiredSessions(now)` (nightly). `src/lib/auth/redirect.ts`: `safeNextPath(raw, fallback)` (same-site paths only). `src/lib/secrets.ts`: `isAuthorizedCron`, `isAuthorizedWebhook` (constant-time; fail closed in production when the secret is unset). `src/lib/file-types.ts`: `sniffFileType(bytes)` (proofs are stored under their real type). `src/lib/security-headers.ts`: `securityHeaders(opts)` used by next.config.ts. See docs/SECURITY.md.
- `src/lib/storage.ts`: `saveFile`, `readStoredFile`, `readStoredBytes`, `canReadStoredFile(user, key, tx?)` (proofs: only people who can view the contact of a payment/purchase whose proof_url is that file; imports: `import.run`; any other folder: nobody — `/api/files` answers 404), `cleanStoredKey`, `storedKeyFolder`, `storedFileHeaders(key, contentType)` (nosniff, sandbox CSP, inline only for pictures), `storedFileName`, `fileUrlForKey`, `newStorageKey`, `isNewStorageKey`, `directUploadAvailable()`, `createSignedUpload(folder, fileName) → { key, uploadUrl } | null` (Supabase signed upload URL for browser-direct uploads), `PROOF_FOLDER`, `IMPORT_FOLDER`.
- `src/lib/webhooks/retention.ts`: `pruneWebhookEvents(now, tx?, { days?, batchSize?, maxBatches? }?) → { deleted, before }` (nightly: events older than 180 days processed without an error; failed, skipped and in-flight events are kept).
- `src/lib/import/batches.ts`: `createImportBatch({ fileName, fileType, source } & ({ bytes } | { storedKey }), actor)`, `prepareImportUpload({ fileName, size }, actor) → { key, uploadUrl } | null`.
- `src/lib/import/commit.ts`: `startCommit`, `runCommitChunk(batchId, actor, { limit?, timeBudgetMs? })` commits in short transactions of `COMMIT_ROWS_PER_TRANSACTION` rows (Postgres slows down past 64 subtransactions in one transaction), recomputing the touched contacts once per transaction. `scripts/bench-import.ts` measures it (2,000-row TagMango file: 20 rows/s before, 38 rows/s after on the build machine).

**`alerts/`** (spec "Alerts and the Today queue"; all re-exported from `alerts/index.ts`, server-only)
- `core.ts`: `createTask(task, tx?) → id | null`, `createTasks(list, tx?) → ids`, `notify(n | n[], tx?) → count`, `managerIds(tx?)`, `adminIds(tx?)`, `completeTask(taskId, userId, "done" | "dismissed"?, tx?)`, `closeContactTasks(contactId, types, userId, tx?)`; types `NewTask`, `NewNotification`. Tasks dedupe on `dedupe_key`, notifications on `dedupe_key:<userId>`.
- `rules.ts` (each `(now, tx?)`, idempotent): `abandonedCheckouts → { … }`, `untouchedLeads`, `releaseStaleLeads → { released }` (wraps the contacts service), `followUpsDue → { notified }`, `closeRepurchasedTasks → { closed }`, `dueForNextRung → { created }`, `atRisk → { created }`, `instalmentsDue → { dueTasks, overdueTasks, notified }`, `unverifiedPayments → { payments, notified }`, `vipGoneQuiet → { contacts, notified }`; constants `CHECKOUT_CHANNEL`, `PRIORITY_HIGH`, `ABANDONED_LOOKBACK_DAYS`.
- `digest.ts`: `buildDailyDigest(user, now, tx?, { since? }?)`, `dailyDigestKey(userId, now, tz)`, `sendDailyDigests(now, tx?) → SendResult`, `buildWeeklySummary(now, tx?) → WeeklySummary` (every figure the dashboard also shows comes from the `src/lib/dashboard/metrics.ts` function for that week: revenueByFamily, newCustomers, leadsAndConversionByChannel, assistedVsSelfServe, beyondUmerShare, atRiskPool, dataHealth, abandonedCheckoutsRecovered, referralLeaderboard), `sendWeeklySummary(now, tx?)`.
- `mailer.ts`: `sendPendingNotificationEmails(now, tx?)` (alerts flagged `email`, at most `PENDING_EMAIL_MAX_AGE_HOURS` = 48 old).
- `jobs.ts`: `runFrequentJobs(now?)`, `runNightlyJobs(now?)` (recompute, closeRepurchasedTasks, dueForNextRung, atRisk, vipGoneQuiet, pruneWebhookEvents), `runWeeklyJobs(now?)`, `runAllAlerts(now?, tx?)` ("Run alerts now"), `summarizeRun(result)`; types `JobReport`, `RunAllAlertsResult`.
- `schedule.ts` (pure): `localDateKey`, `monthKey`, `quarterKey`, `digestSendTime`, `isDigestDue`, `weekWindow`, `wholeDaysBetween`, `DEFAULT_TIME_ZONE`, `validTimeZone`.
- `shared.ts`: `umerRecipients(tx?)` (every admin plus settings `digest.weeklyRecipients`), markers (`claimMarker`, `updateMarker`, `releaseMarker`, `existingMarkers`, `lastMarkerAt`) and small helpers.
- Today helpers in `src/lib/today/`: `desk.ts` `paymentsDesk(user, now, tx?) → PaymentsDesk | null` (unverified payments, their INR, how many waited `thresholds.unverifiedPaymentDays`, overdue instalments; null for people who cannot verify; the daily digest and the "Waiting on you" strip on Today both use it). `inbox.ts`: `getNotification(userId, id)` also returns the `purchaseId` of a money alert (from its dedupe key), and `notificationHref(n)` opens money alerts (`unverified_payment`, `instalment_due`) on that purchase, other alerts on their contact.
- `actions.ts`: `runAlertsNowAction()` (Settings > Alerts).

**Beyond the spec** (docs/CRM_GAP_ANALYSIS.md)
- `tasks/service.ts`: `createManualTask({ title, notes?, dueAt, assigneeId?, contactId? }, actor, tx?) → id` (type `task`; only managers/admins assign to others; the assignee must be able to see the contact; notifies the assignee), `updateTask(id, patch, actor, tx?) → changed` (a follow-up: reschedule only), `setTaskStatus(id, "done" | "open" | "cancel", actor, opts?, tx?)` (cancel: manual tasks only), `listTasks(viewer, "mine" | "overdue" | "upcoming" | "team" | "done", opts?)`, `taskCounts`, `agendaTasks(viewer, from, to)`, `contactOpenTasks`, `getTaskForEdit`, `taskAssigneeOptions`. Pure: `tasks/rules.ts` (`resolveDue`, `cleanTitle`, `canChangeTask`, `bucketOf`, `agendaWindow`, `dueChips`, `todayDefaultTime`, `TaskError`), `tasks/view.ts` (`dueLabel`, `toTaskRowView`).
- `contacts/notes.ts`: `addNote(contactId, text, actor, { pin? }, tx?)` (through `logInteraction`, type note), `setPinned(noteId, pinned, actor, tx?)` (one pinned note per contact, audited), `getPinnedNote`, `recentNotes`. A note never answers a follow-up and never makes a lead Contacted.
- `contacts/privacy.ts`: `eraseContact(contactId, actor, reason, opts?, tx?) → { erasedIds }` (admin, `contacts.erase`; refuses while a payment is unverified or scheduled), `setConsent(contactId, consent | null, actor, tx?)`, `erasedPhone`, `isErasedPhone`, `ERASED_NAME`. `contactScope` hides erased contacts.
- `pipeline/board.ts`: `getBoard(viewer, { owner?, grade?, firstDoor? }, opts?) → BoardColumn[]`; pure `pipeline/rules.ts`: `moveIntent(from, to, purchaseCount)`, `allowedTargets`.
- `search/global.ts`: `globalSearch(viewer, q, { kinds?, limit? }?) → SearchHit[]` (served by `GET /api/search`).
- `activity/feed.ts`: `getActivityFeed(viewer, { kinds?, userId?, before?, limit? }?) → { items, nextBefore }` (managers and admins).
- `templates/whatsapp.ts` (pure): `fillTemplate`, `templatesFor`, `validateTemplates`, `unknownPlaceholders`; setting `templates.whatsapp`.

## Known gaps
- **`reassignContacts` loops contact by contact**, so it is slow for thousands. `handoverAllContacts` is already set-based.
- **Duplicate reviews after a merge.** Reviews between the loser and a third contact stay "open" in the table; `countPossibleDuplicates()` and the Duplicates screen leave them out.
- **Hot-lead check vs unverified payments.** The check uses `purchaseCount === 0`, which counts only verified purchases. So a lead whose only payment is an unverified bank transfer can still trigger a hot-lead alert. That is consistent with the spec's "unverified never counts".
- **Money gaps:**
  - `addPayment`'s over-collection check ignores future scheduled instalments.
  - Payments in a different currency from the purchase are compared at the purchase's rate.
  - `currency.enabled` is not enforced.
  - The payments queue stops at 500 rows by default.
  - Contact-level visibility checks (`canViewContact` / `canEditContact`) are left to the server actions.
- **Metrics gaps:**
  - Cohorts key on the exact purchase count (as the spec defines them), so heavy repeat buyers usually fall back to the company-wide rate.
- **Readiness "recent interest"** counts enquiries, purchases and real conversations (inbound, or a call/WhatsApp/meeting/email that reached the person); notes, support issues and unanswered calls do not.
- **At-risk tasks** are not raised for Dormant customers (they stay in the dashboard's at-risk pool).
- **Settings saved before `productName` / `family` existed** keep their old rules: the new defaults only apply where `nbo.rules` was never saved. Add the product name or family in Settings → Next best offer, then recalculate.
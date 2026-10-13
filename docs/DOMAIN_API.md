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
- Also exports `InvalidPhoneError` and `DEFAULT_FIRST_DOOR_BY_CHANNEL`.

**`contacts/assignment.ts`**
- `pickAutoOwner(phoneCountry, tx?) → string | null`
- `setOwner(contactId, toUserId | null, { reason, changedById, moveTasks?, now? }, tx?) → { changed, fromUserId, toUserId }`
- `reassignContacts(ids, toUserId | null, actor, reason, tx?) → number`
- `handoverAllContacts(fromUserId, toUserId, actor, tx?) → number`
- `releaseStaleLeads(now, tx?) → string[]`
- `requestTransfer(contactId, requester, reason, toUserId?, tx?) → { created, taskIds }`
- `resolveTransferRequest(taskId, "approve" | "decline", actor, tx?) → { moved }`
- `ownershipHistory(contactId, tx?)`
- Also exports `teamForCountry`.

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
- `rules.ts`: `decideFirstDoor`, `listKeyFor`, `countryCode`, `isUuid`, `cleanText`, `ratingValueError`, `sanitizeRatings`, `ratingMayOverwrite`, `addUnique`, `laterOf`, `earlierOf`, `excerpt`, `followUpReason`, `orderedPair`, `teamForCountry`, `RATED_FIELDS`
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
- `computeSalesCredit(contactId, purchasedAt, tx?) → { creditedUserId, assisted, interactionId? }`
- `adjustCredit(purchaseId, userId | null, actor, tx?) → void`

**`money/fx-server.ts`**
- `getFxRate(currency, at, tx?) → number`

**Money pure files** (client-safe)
- `fx.ts`: `rateFromTable(rates, currency, at, tz?)`, `toInr`, `roundMoney`, `roundRate`, `monthKeyOf`, `normalizeCurrency`, `currenciesWithRates`, `BASE_CURRENCY`
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
- `nbo.ts`: `nextBestOffer(facts, rules, ctx)`, `ruleMatches`, `matchesCondition`, `regionOf`, `cheapestOnRung`
- `repeat-core.ts`: `computeRepeatMetrics(facts, { cohorts, thresholds }, now)`, `cohortKey`, `median`, `summarizeCohorts`
- `compute.ts`: `computeCalculatedColumns(contact, facts, ctx, now)`

**Shared**
- `src/lib/utils.ts`: `isUuid(value)` (new)
- `src/lib/alerts/core.ts`: `createTask`, `notify`, `managerIds`, `adminIds`, `completeTask`, `closeContactTasks`

## Known gaps
- **No index on `notifications.contact_id`.** Each merge and undo scans the whole notifications table. The fix is one additive index in `src/db/schema.ts`; I left it alone so I wouldn't collide with engineers editing the schema in parallel.
- **`reassignContacts` loops contact by contact**, so it is slow for thousands. `handoverAllContacts` is already set-based.
- **Duplicate-review count after a merge.** Reviews between the loser and a third contact drop out of the list but stay "open", so a "possible duplicates" count would overcount.
- **A manager who enters a grade A lead also gets the hot-lead alert** about their own entry.
- **Hot-lead check vs unverified payments.** The check uses `purchaseCount === 0`, which counts only verified purchases. So a lead whose only payment is an unverified bank transfer can still trigger a hot-lead alert. That is consistent with the spec's "unverified never counts".
- **Money gaps:**
  - `addPayment`'s over-collection check ignores future scheduled instalments.
  - Payments in a different currency from the purchase are compared at the purchase's rate.
  - `currency.enabled` is not enforced.
  - The payments queue stops at 500 rows by default.
  - Contact-level visibility checks (`canViewContact` / `canEditContact`) are left to the server actions.
- **Metrics gaps:**
  - The "cheapest product on the rung above" fallback can price an offer oddly (delegation alumni at a ₹699 workshop). Setting `productId` or `price` on those rules fixes it.
  - Purchases imported as paid with no payment rows add 0 to LTV.
  - Cohorts key on the exact purchase count, so heavy repeat buyers always fall back to the company-wide rate.
  - Notes count as "recent interest", although the spec says "enquiry, chat or purchase".
- **Not built yet:** the alerts module (abandoned checkout, untouched lead, instalment due, unverified payment, at risk, digests). Money already closes those tasks when `payload.paymentId` is set or the dedupe key contains the payment id.
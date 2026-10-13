import "server-only";
/**
 * Purchases, payments, instalments (EMI), refunds and verification.
 *
 * Rules (docs/SPEC.md "Purchases, payments and LTV"):
 * - LTV counts cash actually received, in INR, net of refunds. Only `verified` payment rows count; unverified
 *   bank/UPI claims, scheduled instalments and rejected rows never do. LTV itself is written by recomputeContact.
 * - Every purchase and payment stores amount, currency, fx_rate and amount_inr at entry (rate of the payment month),
 *   so editing a rate in Settings never changes past rows.
 * - A reference (TagMango order id / UTR / refund id) is recorded once: duplicates throw DuplicateReferenceError.
 * - TagMango and imported orders are verified by default; manual payments start unverified until a manager verifies.
 *
 * `actor` null means the system (webhooks, imports, cron). Every function takes an optional `tx` and runs in its
 * own transaction (a savepoint inside the caller's), so a rejected call never leaves partial rows behind.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, max, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type Tx } from "@/db";
import {
  contacts,
  organisations,
  PAYMENT_MODES,
  payments,
  products,
  PURCHASE_SOURCES,
  purchases,
  users,
  type Payment,
  type PaymentMode,
  type PaymentStatus,
  type Purchase,
  type PurchaseSource,
  type PurchaseStatus,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth/permissions";
import { getSetting, getSettings, type CurrencyConfig } from "@/lib/settings";
import { DAY_MS, formatMoney, isUuid } from "@/lib/utils";
import { assertCreditableUser, computeSalesCredit } from "./credit";
import { NotFoundError, PermissionError, ValidationError } from "./errors";
import { BASE_CURRENCY, currenciesWithRates, normalizeCurrency, rateFromTable, roundMoney, toInr } from "./fx";
import {
  asDuplicateReferenceError,
  assertActorCan,
  assertCan,
  assertReferenceFree,
  closePaymentTasks,
  inTx,
  loadPayment,
  lockPurchase,
  onVerifiedMoney,
  paymentMoneyRows,
  recomputeWithReferrer,
  resolveContact,
  trimSchedule,
} from "./internal";
import {
  canMarkVerified,
  derivePurchaseStatus,
  inPurchaseCurrency,
  MONEY_EPSILON,
  normalizeReference,
  notInFuture,
  paymentReferenceRequired,
  planInstalments,
  positiveAmount,
  purchaseTotals,
  referenceLabel,
  refundInrValue,
  storableInr,
  validDate,
  type Actor,
  type PurchaseTotals,
} from "./rules";

export type { Actor } from "./rules";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecordPurchaseInput = {
  contactId: string;
  productId?: string | null;
  productName?: string | null;
  family?: string | null;
  listPrice?: number | null;
  discount?: number | null;
  /** final agreed amount in `currency` */
  amount: number;
  currency: string;
  purchasedAt?: Date;
  mode: PaymentMode;
  /** TagMango order id or UTR */
  reference?: string | null;
  organisationId?: string | null;
  proofUrl?: string | null;
  notes?: string | null;
  campaign?: string | null;
  source: PurchaseSource;
  rawPayload?: unknown;
  importBatchId?: string | null;
  /**
   * Bulk imports only: skip the recompute of the contact and its referrer because the caller recomputes every
   * affected contact once at the end (recomputeContacts).
   */
  skipRecompute?: boolean;
  /** EMI schedule; the instalments must add up to `amount` */
  instalments?: { amount: number; dueAt: Date }[];
  /**
   * Money received now. Omitted: the full amount was paid now (no instalments) / nothing paid yet (instalments).
   * null: nothing paid yet. With instalments, this pays the FIRST instalment and must match its amount.
   */
  paidNow?: { amount: number; reference?: string | null; proofUrl?: string | null; paidAt?: Date; mode?: PaymentMode } | null;
  /** default: true for source tagmango/import, false for manual. Only the system or a manager/admin can verify. */
  verified?: boolean;
  /** explicit credit override (null = self-serve); honoured only when the actor can adjust credit */
  creditedUserId?: string | null;
};

export type RecordPurchaseResult = {
  purchaseId: string;
  /** payment rows created, in instalment order */
  paymentIds: string[];
  status: PurchaseStatus;
};

export type PaymentResult = {
  paymentId: string;
  status: PaymentStatus;
  purchaseStatus: PurchaseStatus;
};

export type InstalmentPaymentInput = {
  reference: string | null;
  proofUrl?: string | null;
  paidAt?: Date;
  mode: PaymentMode;
  /** defaults to the scheduled amount */
  amount?: number;
  /** verify immediately; only the system or a manager/admin */
  verify?: boolean;
};

export type AddPaymentInput = {
  amount: number;
  /** defaults to the purchase currency */
  currency?: string;
  reference: string | null;
  mode: PaymentMode;
  proofUrl?: string | null;
  paidAt?: Date;
  /** verify immediately; only the system or a manager/admin */
  verify?: boolean;
};

export type RefundInput = {
  /** positive */
  amount: number;
  /** defaults to the purchase currency */
  currency?: string;
  reason: string;
  reference?: string | null;
  refundedAt?: Date;
  mode?: PaymentMode | null;
};

export type ContactPurchase = Purchase & {
  payments: Payment[];
  creditedUserName: string | null;
  totals: PurchaseTotals;
};

export type PaymentsQueueFilter = "unverified" | "due" | "overdue";

export type PaymentsQueueRow = {
  paymentId: string;
  purchaseId: string;
  contactId: string;
  contactName: string;
  contactPhone: string;
  ownerId: string | null;
  ownerName: string | null;
  productName: string;
  family: string;
  purchaseAmount: number;
  purchaseCurrency: string;
  purchaseStatus: PurchaseStatus;
  hasInstalments: boolean;
  seq: number;
  amount: number;
  currency: string;
  amountInr: number;
  dueAt: Date | null;
  paidAt: Date | null;
  mode: PaymentMode | null;
  reference: string | null;
  proofUrl: string | null;
  status: PaymentStatus;
  recordedById: string | null;
  recordedByName: string | null;
  createdAt: Date;
  /** unverified: whole days waiting; due: whole days until due (0 = today); overdue: whole days overdue */
  days: number;
};

// ---------------------------------------------------------------------------
// Record a purchase
// ---------------------------------------------------------------------------

/**
 * Record a purchase with its payment(s). See RecordPurchaseInput for the options.
 * - Product: `productId` gives name, family and list price; otherwise productName + family (a ladder family) are required.
 * - fx_rate/amount_inr from Settings > Currency at the purchase month; each payment at its own paid (or due) date.
 * - No instalments: one payment row for the money paid now (verified or unverified), or none when paidNow is null.
 * - Instalments: one row per instalment (status scheduled, with due date); paidNow pays the first one.
 * - Bank transfer / UPI need a UTR, TagMango an order id (imports exempt). Duplicates -> DuplicateReferenceError.
 * - Sales credit: the explicit override when the actor can adjust credit, otherwise computeSalesCredit.
 * - Afterwards: status, audit, recompute (contact + referrer), new-advocate task and checkout recovery when
 *   verified money arrived.
 */
export async function recordPurchase(
  input: RecordPurchaseInput,
  actor: Actor | null,
  tx: Tx = db,
): Promise<RecordPurchaseResult> {
  try {
    return await inTx(tx, (t) => recordPurchaseTx(input, actor, t));
  } catch (e) {
    throw (await asDuplicateReferenceError(e, referenceLabel(input.mode, input.source), tx)) ?? e;
  }
}

async function recordPurchaseTx(input: RecordPurchaseInput, actor: Actor | null, t: Tx): Promise<RecordPurchaseResult> {
  assertCan(actor, "payments.record", "You can't record payments.");
  const now = new Date();
  if (!PURCHASE_SOURCES.includes(input.source)) throw new ValidationError("Unknown purchase source.", "source");
  assertMode(input.mode);
  const contact = await resolveContact(input.contactId, t);
  if (!contact) throw new NotFoundError("Contact");

  const purchasedAt = input.purchasedAt ? validDate(input.purchasedAt, "purchasedAt", "purchase date") : now;
  const amount = positiveAmount(input.amount);
  const currency = normalizeCurrency(input.currency) || BASE_CURRENCY;
  const cfg = await getSettings(["currency", "ladder.families"], t);
  const rates = cfg.currency.rates;
  const fxRate = rateFromTable(rates, currency, purchasedAt);
  const amountInr = inrOf(amount, fxRate);

  // Product: from the catalogue, or typed in with a ladder family.
  let productId: string | null = null;
  let productName: string;
  let family: string;
  let listPrice: number | null;
  if (input.productId) {
    const [prod] = isUuid(input.productId)
      ? await t.select().from(products).where(eq(products.id, input.productId)).limit(1)
      : [];
    if (!prod) throw new NotFoundError("Product");
    productId = prod.id;
    productName = input.productName?.trim() || prod.name;
    family = prod.family;
    listPrice =
      input.listPrice != null
        ? nonNegative(input.listPrice, "listPrice", "list price")
        : catalogueListPrice(prod.listPrice, prod.currency, currency, purchasedAt, rates);
  } else {
    const name = input.productName?.trim();
    if (!name) throw new ValidationError("Pick a product or type the product name.", "productName");
    const fam = input.family?.trim();
    if (!fam) throw new ValidationError("Pick a product family.", "family");
    if (!cfg["ladder.families"].some((f) => f.key === fam)) {
      throw new ValidationError(`"${fam}" is not a product family in Settings.`, "family");
    }
    productName = name;
    family = fam;
    listPrice = input.listPrice != null ? nonNegative(input.listPrice, "listPrice", "list price") : null;
  }
  const discount =
    input.discount != null
      ? nonNegative(input.discount, "discount", "discount")
      : listPrice != null && listPrice > amount
        ? roundMoney(listPrice - amount)
        : 0;

  if (input.organisationId) {
    const [org] = isUuid(input.organisationId)
      ? await t.select({ id: organisations.id }).from(organisations).where(eq(organisations.id, input.organisationId)).limit(1)
      : [];
    if (!org) throw new NotFoundError("Organisation");
  }

  // What is paid now, and the schedule.
  const hasInstalments = (input.instalments?.length ?? 0) > 0;
  const plan = hasInstalments ? planInstalments(input.instalments!, amount) : [];
  const paidNow = input.paidNow === undefined ? (hasInstalments ? null : { amount }) : input.paidNow;
  const payMode = paidNow?.mode ?? input.mode;
  assertMode(payMode);
  const paidAt = paidNow?.paidAt ? validDate(paidNow.paidAt, "paidAt", "payment date") : purchasedAt;
  let paidAmount = 0;
  if (paidNow) {
    // money cannot have arrived in the future (when it is paid now, the purchase date is the payment date)
    notInFuture(paidAt, now, paidNow.paidAt ? "paidAt" : "purchasedAt", "payment date");
    paidAmount = positiveAmount(paidNow.amount, "paidAmount", "the amount paid");
    if (hasInstalments && Math.abs(paidAmount - plan[0].amount) > MONEY_EPSILON) {
      throw new ValidationError(
        `The first payment should match the first instalment (${formatMoney(plan[0].amount, currency)}).`,
        "paidAmount",
      );
    }
    if (paidAmount > amount + MONEY_EPSILON) {
      throw new ValidationError("The amount paid can't be more than the purchase amount.", "paidAmount");
    }
  }

  // References
  const purchaseLabel = referenceLabel(input.mode, input.source);
  const ownRef = normalizeReference(input.reference, input.mode);
  if (input.source === "tagmango" && !ownRef) throw new ValidationError("The TagMango order id is missing.", "reference");
  const payRef = paidNow ? normalizeReference(paidNow.reference ?? input.reference, payMode) : null;
  if (paidNow && paymentReferenceRequired(payMode, input.source) && !payRef) {
    throw new ValidationError(
      payMode === "tagmango" ? "Enter the TagMango order id." : "Enter the UTR (transaction reference) for this payment.",
      "reference",
    );
  }
  const purchaseRef = ownRef ?? (hasInstalments ? null : payRef);
  const actorId = actor?.id ?? null;
  await assertReferenceFree(purchaseRef, purchaseLabel, t, { actorId });
  if (payRef && payRef !== purchaseRef) await assertReferenceFree(payRef, referenceLabel(payMode, input.source), t, { actorId });

  // Verification: TagMango/import verified by default; only the system or a manager may verify.
  let verified = input.verified ?? input.source !== "manual";
  if (verified && !canMarkVerified(actor)) {
    if (input.verified === true) {
      throw new PermissionError("payments.verify", "Only a manager can mark a payment as verified.");
    }
    verified = false;
  }

  // Sales credit
  let creditedUserId: string | null;
  let assisted: boolean;
  let creditAdjustedById: string | null = null;
  if (input.creditedUserId !== undefined && actor && can(actor, "credit.adjust")) {
    if (input.creditedUserId) await assertCreditableUser(input.creditedUserId, t);
    creditedUserId = input.creditedUserId;
    assisted = creditedUserId !== null;
    creditAdjustedById = actor.id;
  } else {
    ({ creditedUserId, assisted } = await computeSalesCredit(contact.id, purchasedAt, t, { ownerId: contact.ownerId }));
  }

  // Payment rows (built first: the purchase is saved with the status they give it; purchaseId is set on insert)
  const paidStatus: PaymentStatus = verified ? "verified" : "unverified";
  const paidRow = (seq: number, dueAt: Date | null): typeof payments.$inferInsert => {
    const rate = rateFromTable(rates, currency, paidAt);
    return {
      purchaseId: "",
      contactId: contact.id,
      kind: "payment",
      seq,
      amount: paidAmount,
      currency,
      fxRate: rate,
      amountInr: inrOf(paidAmount, rate),
      dueAt,
      paidAt,
      mode: payMode,
      reference: payRef,
      status: paidStatus,
      verifiedById: verified ? (actor?.id ?? null) : null,
      verifiedAt: verified ? now : null,
      proofUrl: paidNow?.proofUrl ?? input.proofUrl ?? null,
      createdById: actor?.id ?? null,
    };
  };
  const values: (typeof payments.$inferInsert)[] = [];
  if (!hasInstalments) {
    if (paidNow) values.push(paidRow(1, null));
  } else {
    plan.forEach((inst, i) => {
      if (i === 0 && paidNow) {
        values.push(paidRow(inst.seq, inst.dueAt));
        return;
      }
      const rate = rateFromTable(rates, currency, inst.dueAt);
      values.push({
        purchaseId: "",
        contactId: contact.id,
        kind: "payment",
        seq: inst.seq,
        amount: inst.amount,
        currency,
        fxRate: rate,
        amountInr: inrOf(inst.amount, rate),
        dueAt: inst.dueAt,
        mode: input.mode,
        status: "scheduled",
        createdById: actor?.id ?? null,
      });
    });
  }
  // the status follows from these rows (what refreshPurchaseStatus would read back)
  const status = derivePurchaseStatus(
    { amount, currency, fxRate, status: "pending" },
    values.map((v) => ({ kind: v.kind ?? "payment", status: v.status ?? "scheduled", amount: Number(v.amount), currency: v.currency ?? currency, amountInr: Number(v.amountInr) })),
  );

  const [row] = await t
    .insert(purchases)
    .values({
      contactId: contact.id,
      organisationId: input.organisationId ?? null,
      productId,
      productName,
      family,
      listPrice,
      discount,
      amount,
      currency,
      fxRate,
      amountInr,
      purchasedAt,
      mode: input.mode,
      reference: purchaseRef,
      status,
      creditedUserId,
      assisted,
      creditAdjustedById,
      source: input.source,
      hasInstalments,
      proofUrl: input.proofUrl ?? null,
      notes: input.notes?.trim() || null,
      campaign: input.campaign ?? null,
      rawPayload: input.rawPayload ?? null,
      importBatchId: input.importBatchId ?? null,
      createdById: actor?.id ?? null,
    })
    .returning({ id: purchases.id });
  const purchaseId = row.id;

  const inserted = values.length
    ? await t
        .insert(payments)
        .values(values.map((v) => ({ ...v, purchaseId })))
        .returning({ id: payments.id, seq: payments.seq, status: payments.status })
    : [];
  inserted.sort((a, b) => a.seq - b.seq);

  await audit(
    {
      table: "purchases",
      rowId: purchaseId,
      action: "insert",
      newValue: {
        contactId: contact.id,
        productName,
        family,
        amount,
        currency,
        fxRate,
        mode: input.mode,
        reference: purchaseRef,
        source: input.source,
        instalments: plan.length,
        paidNow: paidNow ? paidAmount : 0,
        verified: paidNow ? verified : null,
        creditedUserId,
      },
      userId: actor?.id ?? null,
    },
    t,
  );

  const verifiedIds = inserted.filter((r) => r.status === "verified").map((r) => r.id);
  if (verifiedIds.length) {
    await onVerifiedMoney(
      {
        contactId: contact.id,
        paymentIds: verifiedIds,
        purchaseId,
        paidAt,
        actorId: actor?.id ?? null,
        newAdvocate: input.source !== "import",
        // payments created just now: no alert task can name them yet
        newPayments: true,
      },
      t,
    );
  }
  if (!input.skipRecompute) await recomputeWithReferrer(contact.id, t);
  return { purchaseId, paymentIds: inserted.map((r) => r.id), status };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Recalculate and save a purchase's status from its payments (see derivePurchaseStatus): pending, partial, paid,
 * refunded; cancelled stays cancelled. Compared in the purchase's own currency. Returns the status.
 */
export async function refreshPurchaseStatus(purchaseId: string, tx: Tx = db): Promise<PurchaseStatus> {
  const [p] = await tx.select().from(purchases).where(eq(purchases.id, purchaseId)).limit(1);
  if (!p) throw new NotFoundError("Purchase");
  const rows = await paymentMoneyRows(purchaseId, tx);
  const next = derivePurchaseStatus(p, rows);
  if (next !== p.status) {
    await tx.update(purchases).set({ status: next, updatedAt: new Date() }).where(eq(purchases.id, purchaseId));
  }
  return next;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * Pay a scheduled instalment: it becomes `unverified` (with paid date, mode, reference, proof and the fx of the
 * paid date), or `verified` when `verify` is true and the actor is the system or a manager/admin.
 * Bank/UPI need a UTR. Cannot exceed what is left to collect on the purchase; the paid date cannot be in the future.
 * Paying less leaves the balance scheduled on the same due date; paying more takes the excess off the last
 * instalments (see trimSchedule), so the schedule always adds up to what is still owed.
 */
export async function recordInstalmentPayment(
  paymentId: string,
  input: InstalmentPaymentInput,
  actor: Actor | null,
  tx: Tx = db,
): Promise<PaymentResult> {
  try {
    return await inTx(tx, (t) => recordInstalmentPaymentTx(paymentId, input, actor, t));
  } catch (e) {
    throw (await asDuplicateReferenceError(e, referenceLabel(input.mode), tx)) ?? e;
  }
}

async function recordInstalmentPaymentTx(
  paymentId: string,
  input: InstalmentPaymentInput,
  actor: Actor | null,
  t: Tx,
): Promise<PaymentResult> {
  assertCan(actor, "payments.record", "You can't record payments.");
  const now = new Date();
  const first = await loadPayment(paymentId, t);
  const purchase = await lockPurchase(first.purchaseId, t);
  const pay = await loadPayment(paymentId, t);
  if (pay.kind !== "payment") throw new ValidationError("This is a refund, not an instalment.");
  // cancelling or fully refunding rejects the remaining instalments, so say why rather than "already paid"
  if (purchase.status === "cancelled") throw new ValidationError("This purchase was cancelled.");
  if (purchase.status === "refunded") throw new ValidationError("This purchase was refunded.");
  if (pay.status !== "scheduled") throw new ValidationError("This instalment has already been paid.");
  assertMode(input.mode);
  const paidAt = input.paidAt ? notInFuture(validDate(input.paidAt, "paidAt", "payment date"), now, "paidAt", "payment date") : now;
  const amount = input.amount != null ? positiveAmount(input.amount) : Number(pay.amount);

  const totals = purchaseTotals(purchase, await paymentMoneyRows(purchase.id, t));
  const amountInPurchase = inPurchaseCurrency({ amount, currency: pay.currency, amountInr: toInr(amount, Number(pay.fxRate)) }, purchase);
  if (amountInPurchase > totals.collectable + MONEY_EPSILON) {
    throw new ValidationError(`Only ${formatMoney(totals.collectable, purchase.currency)} is left to collect on this purchase.`, "amount");
  }

  const reference = normalizeReference(input.reference, input.mode);
  if (paymentReferenceRequired(input.mode, "manual") && !reference) {
    throw new ValidationError(input.mode === "tagmango" ? "Enter the TagMango order id." : "Enter the UTR for this payment.", "reference");
  }
  await assertReferenceFree(reference, referenceLabel(input.mode), t, {
    ownPurchaseId: purchase.id,
    excludePaymentId: pay.id,
    actorId: actor?.id ?? null,
  });

  const verified = input.verify === true;
  if (verified && !canMarkVerified(actor)) {
    throw new PermissionError("payments.verify", "Only a manager can mark a payment as verified.");
  }
  const { rates } = await getSetting("currency", t);
  const rate = rateFromTable(rates, pay.currency, paidAt);
  const status: PaymentStatus = verified ? "verified" : "unverified";
  await t
    .update(payments)
    .set({
      amount,
      fxRate: rate,
      amountInr: inrOf(amount, rate),
      paidAt,
      mode: input.mode,
      reference,
      proofUrl: input.proofUrl ?? null,
      status,
      verifiedById: verified ? (actor?.id ?? null) : null,
      verifiedAt: verified ? now : null,
      updatedAt: now,
    })
    .where(eq(payments.id, pay.id));
  await audit(
    {
      table: "payments",
      rowId: pay.id,
      action: verified ? "verify" : "update",
      field: "status",
      oldValue: pay.status,
      newValue: { status, amount, reference, paidAt: paidAt.toISOString() },
      userId: actor?.id ?? null,
    },
    t,
  );
  await closePaymentTasks(pay.contactId, [pay.id], ["instalment_due"], actor?.id ?? null, t);
  const scheduledAmount = Number(pay.amount);
  if (amount < scheduledAmount - MONEY_EPSILON) {
    // Underpaid: the balance of this instalment stays on the schedule (same number and due date) and is chased.
    const balance = roundMoney(scheduledAmount - amount);
    const dueRate = rateFromTable(rates, pay.currency, pay.dueAt ?? paidAt);
    await t.insert(payments).values({
      purchaseId: purchase.id,
      contactId: pay.contactId,
      kind: "payment",
      seq: pay.seq,
      amount: balance,
      currency: pay.currency,
      fxRate: dueRate,
      amountInr: inrOf(balance, dueRate),
      dueAt: pay.dueAt ?? paidAt,
      mode: pay.mode,
      status: "scheduled",
      createdById: actor?.id ?? null,
    });
  } else if (amount > scheduledAmount + MONEY_EPSILON) {
    // Overpaid: the excess comes off the last instalments.
    await trimSchedule(purchase, actor?.id ?? null, t);
  }
  const purchaseStatus = await refreshPurchaseStatus(purchase.id, t);
  if (verified) {
    await onVerifiedMoney({ contactId: pay.contactId, paymentIds: [pay.id], purchaseId: purchase.id, paidAt, actorId: actor?.id ?? null }, t);
  }
  await recomputeWithReferrer(pay.contactId, t);
  return { paymentId: pay.id, status, purchaseStatus };
}

/**
 * An extra part payment that is not in the instalment schedule (e.g. the balance of a part-paid purchase, or a
 * customer paying ahead). Unverified unless `verify` is set by the system or a manager/admin. Cannot exceed what is
 * left to collect (amount - verified - unverified); the paid date cannot be in the future. On an EMI purchase the
 * instalments it covers come off the end of the schedule. Not allowed on cancelled or refunded purchases.
 */
export async function addPayment(
  purchaseId: string,
  input: AddPaymentInput,
  actor: Actor | null,
  tx: Tx = db,
): Promise<PaymentResult> {
  try {
    return await inTx(tx, (t) => addPaymentTx(purchaseId, input, actor, t));
  } catch (e) {
    throw (await asDuplicateReferenceError(e, referenceLabel(input.mode), tx)) ?? e;
  }
}

async function addPaymentTx(purchaseId: string, input: AddPaymentInput, actor: Actor | null, t: Tx): Promise<PaymentResult> {
  assertCan(actor, "payments.record", "You can't record payments.");
  const now = new Date();
  const purchase = await lockPurchase(purchaseId, t);
  if (purchase.status === "cancelled") throw new ValidationError("This purchase was cancelled.");
  if (purchase.status === "refunded") throw new ValidationError("This purchase was refunded.");
  assertMode(input.mode);
  const paidAt = input.paidAt ? notInFuture(validDate(input.paidAt, "paidAt", "payment date"), now, "paidAt", "payment date") : now;
  const amount = positiveAmount(input.amount);
  const currency = normalizeCurrency(input.currency) || purchase.currency;
  const { rates } = await getSetting("currency", t);
  const rate = rateFromTable(rates, currency, paidAt);
  const amountInr = inrOf(amount, rate);

  const rows = await paymentMoneyRows(purchase.id, t);
  const totals = purchaseTotals(purchase, rows);
  if (inPurchaseCurrency({ amount, currency, amountInr }, purchase) > totals.collectable + MONEY_EPSILON) {
    throw new ValidationError(`Only ${formatMoney(totals.collectable, purchase.currency)} is left to collect on this purchase.`, "amount");
  }

  const reference = normalizeReference(input.reference, input.mode);
  if (paymentReferenceRequired(input.mode, "manual") && !reference) {
    throw new ValidationError(input.mode === "tagmango" ? "Enter the TagMango order id." : "Enter the UTR for this payment.", "reference");
  }
  await assertReferenceFree(reference, referenceLabel(input.mode), t, { ownPurchaseId: purchase.id, actorId: actor?.id ?? null });

  const verified = input.verify === true;
  if (verified && !canMarkVerified(actor)) {
    throw new PermissionError("payments.verify", "Only a manager can mark a payment as verified.");
  }
  const [seqRow] = await t
    .select({ maxSeq: max(payments.seq) })
    .from(payments)
    .where(and(eq(payments.purchaseId, purchase.id), eq(payments.kind, "payment")));
  const status: PaymentStatus = verified ? "verified" : "unverified";
  const [ins] = await t
    .insert(payments)
    .values({
      purchaseId: purchase.id,
      contactId: purchase.contactId,
      kind: "payment",
      seq: (seqRow?.maxSeq ?? 0) + 1,
      amount,
      currency,
      fxRate: rate,
      amountInr,
      paidAt,
      mode: input.mode,
      reference,
      status,
      verifiedById: verified ? (actor?.id ?? null) : null,
      verifiedAt: verified ? now : null,
      proofUrl: input.proofUrl ?? null,
      createdById: actor?.id ?? null,
    })
    .returning({ id: payments.id });
  await audit(
    {
      table: "payments",
      rowId: ins.id,
      action: "insert",
      newValue: { purchaseId: purchase.id, amount, currency, reference, mode: input.mode, status },
      userId: actor?.id ?? null,
    },
    t,
  );
  // paying ahead: the instalments this money already covers are no longer chased
  await trimSchedule(purchase, actor?.id ?? null, t);
  const purchaseStatus = await refreshPurchaseStatus(purchase.id, t);
  if (verified) {
    await onVerifiedMoney({ contactId: purchase.contactId, paymentIds: [ins.id], purchaseId: purchase.id, paidAt, actorId: actor?.id ?? null }, t);
  }
  await recomputeWithReferrer(purchase.contactId, t);
  return { paymentId: ins.id, status, purchaseStatus };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Manager/admin confirms the money arrived: status verified, verified_by, verified_at; audit "verify";
 * purchase status; recompute (contact + referrer); new-advocate task and checkout recovery when it is the money
 * that matters. Verifying an already verified payment is a no-op. A rejected payment can be verified (the manager
 * changed their mind); an instalment that was re-opened by the rejection is then dropped again.
 */
export async function verifyPayment(paymentId: string, actor: Actor, tx: Tx = db): Promise<PaymentResult> {
  assertActorCan(actor, "payments.verify", "Only a manager can verify payments.");
  return inTx(tx, async (t): Promise<PaymentResult> => {
    const now = new Date();
    const first = await loadPayment(paymentId, t);
    const purchase = await lockPurchase(first.purchaseId, t);
    const pay = await loadPayment(paymentId, t);
    if (pay.status === "verified") return { paymentId, status: "verified", purchaseStatus: purchase.status };
    if (pay.kind !== "payment") throw new ValidationError("Refunds are recorded as verified.");
    if (pay.status === "scheduled") throw new ValidationError("This instalment hasn't been paid yet.");
    if (purchase.status === "cancelled") throw new ValidationError("This purchase was cancelled.");

    if (pay.status === "rejected") {
      const totals = purchaseTotals(purchase, await paymentMoneyRows(purchase.id, t));
      if (inPurchaseCurrency(pay, purchase) > totals.collectable + MONEY_EPSILON) {
        throw new ValidationError("Verifying this would collect more than the purchase amount.");
      }
    }

    await t
      .update(payments)
      .set({ status: "verified", verifiedById: actor.id, verifiedAt: now, updatedAt: now })
      .where(eq(payments.id, pay.id));
    if (pay.status === "rejected") {
      // The rejection re-opened this money on the schedule; the claim now stands, so take it off again
      // (the re-opened row for this instalment number first).
      await trimSchedule(purchase, actor.id, t, { preferSeq: pay.seq });
    }
    await audit(
      { table: "payments", rowId: pay.id, action: "verify", field: "status", oldValue: pay.status, newValue: "verified", userId: actor.id },
      t,
    );
    const purchaseStatus = await refreshPurchaseStatus(purchase.id, t);
    await onVerifiedMoney(
      { contactId: pay.contactId, paymentIds: [pay.id], purchaseId: purchase.id, paidAt: pay.paidAt ?? now, actorId: actor.id },
      t,
    );
    await recomputeWithReferrer(pay.contactId, t);
    return { paymentId: pay.id, status: "verified" as const, purchaseStatus };
  });
}

/**
 * Manager/admin rejects a claimed payment (wrong UTR, money not in the account): status rejected with the reason.
 * Verified payments cannot be rejected (record a refund). When the rejected payment was an instalment, or any
 * claim on an EMI purchase, the money still owed is re-opened as a new scheduled row (same number; the instalment's
 * due date, else the claimed paid date) so it is still chased — never on a cancelled or fully refunded purchase.
 */
export async function rejectPayment(
  paymentId: string,
  actor: Actor,
  reason: string,
  tx: Tx = db,
): Promise<PaymentResult & { rescheduledPaymentId: string | null }> {
  assertActorCan(actor, "payments.verify", "Only a manager can reject payments.");
  const why = reason?.trim();
  if (!why) throw new ValidationError("Say why the payment is rejected.", "reason");
  return inTx(tx, async (t): Promise<PaymentResult & { rescheduledPaymentId: string | null }> => {
    const now = new Date();
    const first = await loadPayment(paymentId, t);
    const purchase = await lockPurchase(first.purchaseId, t);
    const pay = await loadPayment(paymentId, t);
    if (pay.kind !== "payment") throw new ValidationError("Refunds can't be rejected.");
    if (pay.status === "rejected") return { paymentId, status: "rejected", purchaseStatus: purchase.status, rescheduledPaymentId: null };
    if (pay.status === "verified") throw new ValidationError("This payment is already verified. Record a refund instead.");
    if (pay.status === "scheduled") throw new ValidationError("This instalment hasn't been paid yet.");

    await t.update(payments).set({ status: "rejected", reason: why, updatedAt: now }).where(eq(payments.id, pay.id));

    let rescheduledPaymentId: string | null = null;
    // An instalment, or a pay-ahead claim on an EMI purchase (which shortened the schedule), goes back on the
    // schedule so the money is still chased.
    // A cancelled or fully refunded purchase is never chased again.
    if ((pay.dueAt || purchase.hasInstalments) && purchase.status !== "cancelled" && purchase.status !== "refunded") {
      const rows = await paymentMoneyRows(purchase.id, t);
      const committed = rows
        .filter((r) => r.kind === "payment" && r.status !== "rejected")
        .reduce((s, r) => s + inPurchaseCurrency(r, purchase), 0);
      const remaining = roundMoney(Number(purchase.amount) - committed);
      if (remaining > MONEY_EPSILON) {
        const reopenAmount = Math.min(roundMoney(inPurchaseCurrency(pay, purchase)), remaining);
        const dueAt = pay.dueAt ?? pay.paidAt ?? now;
        const { rates } = await getSetting("currency", t);
        const rate = rateFromTable(rates, purchase.currency, dueAt);
        const [ins] = await t
          .insert(payments)
          .values({
            purchaseId: purchase.id,
            contactId: pay.contactId,
            kind: "payment",
            seq: pay.seq,
            amount: reopenAmount,
            currency: purchase.currency,
            fxRate: rate,
            amountInr: toInr(reopenAmount, rate),
            dueAt,
            mode: pay.mode,
            status: "scheduled",
            createdById: actor.id,
          })
          .returning({ id: payments.id });
        rescheduledPaymentId = ins.id;
      }
    }
    await audit(
      { table: "payments", rowId: pay.id, action: "update", field: "status", oldValue: pay.status, newValue: { status: "rejected", reason: why }, userId: actor.id },
      t,
    );
    await closePaymentTasks(pay.contactId, [pay.id], ["unverified_payment"], actor.id, t);
    const purchaseStatus = await refreshPurchaseStatus(purchase.id, t);
    await recomputeWithReferrer(pay.contactId, t);
    return { paymentId: pay.id, status: "rejected" as const, purchaseStatus, rescheduledPaymentId };
  });
}

// ---------------------------------------------------------------------------
// Refunds and cancellation
// ---------------------------------------------------------------------------

/**
 * Record a refund (manager/admin, or the system for TagMango refunds): a `refund` row, always verified, amount
 * positive. It cannot exceed the verified money net of earlier refunds. In the purchase currency the INR value is
 * taken at the rate the money came in at, so a full refund nets the purchase to zero; LTV drops by that INR value.
 * A full refund also rejects the instalments still scheduled, so they are no longer chased.
 */
export async function recordRefund(
  purchaseId: string,
  input: RefundInput,
  actor: Actor | null,
  tx: Tx = db,
): Promise<PaymentResult> {
  assertCan(actor, "payments.refund", "Only a manager can record refunds.");
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("Say why the money is refunded.", "reason");
  try {
    return await inTx(tx, async (t): Promise<PaymentResult> => {
      const now = new Date();
      const purchase = await lockPurchase(purchaseId, t);
      if (purchase.status === "cancelled") throw new ValidationError("This purchase was cancelled.");
      const amount = positiveAmount(input.amount, "amount", "the refund amount");
      const currency = normalizeCurrency(input.currency) || purchase.currency;
      const refundedAt = input.refundedAt
        ? notInFuture(validDate(input.refundedAt, "refundedAt", "refund date"), now, "refundedAt", "refund date")
        : now;
      if (input.mode) assertMode(input.mode);

      const rows = await paymentMoneyRows(purchase.id, t);
      const totals = purchaseTotals(purchase, rows);
      if (totals.net <= MONEY_EPSILON) {
        throw new ValidationError("No verified money has been received on this purchase, so there is nothing to refund.", "amount");
      }
      let fxRate: number;
      let amountInr: number;
      let amountInPurchase: number;
      if (currency === normalizeCurrency(purchase.currency)) {
        amountInPurchase = amount;
        ({ amountInr, fxRate } = refundInrValue(amount, totals));
      } else {
        const { rates } = await getSetting("currency", t);
        fxRate = rateFromTable(rates, currency, refundedAt);
        amountInr = Math.min(toInr(amount, fxRate), totals.netInr);
        amountInPurchase = inPurchaseCurrency({ amount, currency, amountInr: toInr(amount, fxRate) }, purchase);
      }
      if (amountInPurchase > totals.net + MONEY_EPSILON) {
        throw new ValidationError(
          `You can refund at most ${formatMoney(totals.net, purchase.currency)} on this purchase.`,
          "amount",
        );
      }

      const reference = normalizeReference(input.reference, input.mode ?? null);
      await assertReferenceFree(reference, "refund reference", t, { ownPurchaseId: purchase.id, actorId: actor?.id ?? null });
      const refundSeq = rows.filter((r) => r.kind === "refund").length + 1;
      const [ins] = await t
        .insert(payments)
        .values({
          purchaseId: purchase.id,
          contactId: purchase.contactId,
          kind: "refund",
          seq: refundSeq,
          amount,
          currency,
          fxRate,
          amountInr,
          paidAt: refundedAt,
          mode: input.mode ?? purchase.mode,
          reference,
          status: "verified",
          verifiedById: actor?.id ?? null,
          verifiedAt: now,
          reason,
          createdById: actor?.id ?? null,
        })
        .returning({ id: payments.id });
      await audit(
        {
          table: "payments",
          rowId: ins.id,
          action: "insert",
          field: "refund",
          newValue: { purchaseId: purchase.id, amount, currency, amountInr, reason, reference },
          userId: actor?.id ?? null,
        },
        t,
      );
      const purchaseStatus = await refreshPurchaseStatus(purchase.id, t);
      if (purchaseStatus === "refunded") {
        // Fully refunded: stop chasing the instalments that were still to come.
        const scheduled = rows.filter((r) => r.kind === "payment" && r.status === "scheduled").map((r) => r.id);
        if (scheduled.length) {
          await t
            .update(payments)
            .set({ status: "rejected", reason: `Purchase refunded: ${reason}`, updatedAt: now })
            .where(inArray(payments.id, scheduled));
          await closePaymentTasks(purchase.contactId, scheduled, ["instalment_due"], actor?.id ?? null, t);
        }
      }
      await recomputeWithReferrer(purchase.contactId, t);
      return { paymentId: ins.id, status: "verified" as const, purchaseStatus };
    });
  } catch (e) {
    throw (await asDuplicateReferenceError(e, "refund reference", tx)) ?? e;
  }
}

/**
 * Void a purchase recorded by mistake or abandoned before any money arrived. Only when no verified payment exists
 * (otherwise record a refund). Scheduled instalments and unverified claims become rejected with the reason;
 * the purchase becomes cancelled. Cancelling twice is a no-op. Its references (UTR / order id) stay on the rows
 * but are released (audited) as soon as the same reference is recorded again, e.g. on the right contact.
 */
export async function cancelPurchase(purchaseId: string, actor: Actor | null, reason: string, tx: Tx = db): Promise<PurchaseStatus> {
  assertCan(actor, "payments.record", "You can't change purchases.");
  const why = reason?.trim();
  if (!why) throw new ValidationError("Say why the purchase is cancelled.", "reason");
  return inTx(tx, async (t): Promise<PurchaseStatus> => {
    const now = new Date();
    const purchase = await lockPurchase(purchaseId, t);
    if (purchase.status === "cancelled") return "cancelled" as const;
    const rows = await paymentMoneyRows(purchase.id, t);
    if (rows.some((r) => r.kind === "payment" && r.status === "verified")) {
      throw new ValidationError("This purchase has verified payments. Record a refund instead.");
    }
    const open = rows.filter((r) => r.kind === "payment" && (r.status === "scheduled" || r.status === "unverified"));
    if (open.length) {
      await t
        .update(payments)
        .set({ status: "rejected", reason: `Purchase cancelled: ${why}`, updatedAt: now })
        .where(inArray(payments.id, open.map((r) => r.id)));
    }
    await t
      .update(purchases)
      .set({
        status: "cancelled",
        notes: sql`case when ${purchases.notes} is null or ${purchases.notes} = '' then ${`Cancelled: ${why}`} else ${purchases.notes} || ${`\nCancelled: ${why}`} end`,
        updatedAt: now,
      })
      .where(eq(purchases.id, purchase.id));
    await audit(
      {
        table: "purchases",
        rowId: purchase.id,
        action: "update",
        field: "status",
        oldValue: purchase.status,
        newValue: { status: "cancelled", reason: why },
        userId: actor?.id ?? null,
      },
      t,
    );
    await closePaymentTasks(purchase.contactId, open.map((r) => r.id), ["instalment_due", "unverified_payment"], actor?.id ?? null, t);
    await recomputeWithReferrer(purchase.contactId, t);
    return "cancelled" as const;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * A contact's purchases, newest first, each with its payments (instalments by number, then refunds), the credited
 * salesperson's name and money totals. For the contact page; the caller checks visibility.
 */
export async function getContactPurchases(contactId: string, tx: Tx = db): Promise<ContactPurchase[]> {
  if (!isUuid(contactId)) return [];
  const rows = await tx
    .select({ purchase: purchases, creditedUserName: users.name })
    .from(purchases)
    .leftJoin(users, eq(users.id, purchases.creditedUserId))
    .where(eq(purchases.contactId, contactId))
    .orderBy(desc(purchases.purchasedAt), desc(purchases.createdAt));
  if (!rows.length) return [];
  const pays = await tx
    .select()
    .from(payments)
    .where(inArray(payments.purchaseId, rows.map((r) => r.purchase.id)))
    .orderBy(
      asc(payments.kind),
      asc(payments.seq),
      asc(sql`coalesce(${payments.paidAt}, ${payments.dueAt}, ${payments.createdAt})`),
      asc(payments.createdAt),
    );
  const byPurchase = new Map<string, Payment[]>();
  for (const p of pays) {
    const list = byPurchase.get(p.purchaseId) ?? [];
    list.push(p);
    byPurchase.set(p.purchaseId, list);
  }
  return rows.map(({ purchase, creditedUserName }) => {
    const list = byPurchase.get(purchase.id) ?? [];
    return { ...purchase, payments: list, creditedUserName: creditedUserName ?? null, totals: purchaseTotals(purchase, list) };
  });
}

/**
 * The manager's payments screen (and the alert scans):
 * - "unverified": claimed payments waiting for verification, oldest first (`olderThanDays` keeps only those waiting
 *   at least that long — the Unverified payment alert uses thresholds.unverifiedPaymentDays);
 * - "due": scheduled instalments due from now to now + `withinDays` (default thresholds.instalmentDueDays), soonest first;
 * - "overdue": scheduled instalments past their due date, most overdue first.
 * Cancelled purchases and merged contacts are excluded. `ownerId` narrows to one owner's contacts (null = the pool).
 */
export async function listPaymentsQueue(
  filter: PaymentsQueueFilter,
  tx: Tx = db,
  now: Date = new Date(),
  opts: { ownerId?: string | null; withinDays?: number; olderThanDays?: number; limit?: number } = {},
): Promise<PaymentsQueueRow[]> {
  const owner = alias(users, "queue_owner");
  const recorder = alias(users, "queue_recorder");
  const where: SQL[] = [
    eq(payments.kind, "payment"),
    ne(purchases.status, "cancelled"),
    isNull(contacts.mergedIntoId),
  ];
  const waitingSince = sql<Date>`coalesce(${payments.paidAt}, ${payments.createdAt})`;
  let order: SQL[];
  if (filter === "unverified") {
    where.push(eq(payments.status, "unverified"));
    if (opts.olderThanDays != null) {
      const cutoff = new Date(now.getTime() - opts.olderThanDays * DAY_MS);
      where.push(sql`${waitingSince} <= ${cutoff.toISOString()}::timestamptz`);
    }
    order = [asc(waitingSince), asc(payments.createdAt)];
  } else if (filter === "due") {
    const days = opts.withinDays ?? (await getSetting("thresholds", tx)).instalmentDueDays;
    where.push(eq(payments.status, "scheduled"), gte(payments.dueAt, now), lte(payments.dueAt, new Date(now.getTime() + days * DAY_MS)));
    order = [asc(payments.dueAt), asc(payments.seq)];
  } else if (filter === "overdue") {
    where.push(eq(payments.status, "scheduled"), lt(payments.dueAt, now));
    order = [asc(payments.dueAt), asc(payments.seq)];
  } else {
    throw new ValidationError("Unknown payments filter.");
  }
  if (opts.ownerId !== undefined) where.push(opts.ownerId === null ? isNull(contacts.ownerId) : eq(contacts.ownerId, opts.ownerId));

  const rows = await tx
    .select({
      paymentId: payments.id,
      purchaseId: purchases.id,
      contactId: contacts.id,
      contactName: contacts.name,
      contactPhone: contacts.phoneE164,
      ownerId: contacts.ownerId,
      ownerName: owner.name,
      productName: purchases.productName,
      family: purchases.family,
      purchaseAmount: purchases.amount,
      purchaseCurrency: purchases.currency,
      purchaseStatus: purchases.status,
      hasInstalments: purchases.hasInstalments,
      seq: payments.seq,
      amount: payments.amount,
      currency: payments.currency,
      amountInr: payments.amountInr,
      dueAt: payments.dueAt,
      paidAt: payments.paidAt,
      mode: payments.mode,
      reference: payments.reference,
      proofUrl: payments.proofUrl,
      status: payments.status,
      recordedById: payments.createdById,
      recordedByName: recorder.name,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .innerJoin(purchases, eq(purchases.id, payments.purchaseId))
    .innerJoin(contacts, eq(contacts.id, payments.contactId))
    .leftJoin(owner, eq(owner.id, contacts.ownerId))
    .leftJoin(recorder, eq(recorder.id, payments.createdById))
    .where(and(...where))
    .orderBy(...order)
    .limit(opts.limit ?? 500);

  return rows.map((r) => {
    let days: number;
    if (filter === "unverified") days = Math.floor((now.getTime() - (r.paidAt ?? r.createdAt).getTime()) / DAY_MS);
    else if (filter === "due") days = Math.floor((r.dueAt!.getTime() - now.getTime()) / DAY_MS);
    else days = Math.floor((now.getTime() - r.dueAt!.getTime()) / DAY_MS);
    return { ...r, days: Math.max(0, days) };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** INR value at `rate`, rounded, and small enough for the books (a ValidationError otherwise). */
function inrOf(amount: number, rate: number): number {
  return storableInr(toInr(amount, rate));
}

function assertMode(mode: PaymentMode): void {
  if (!PAYMENT_MODES.includes(mode)) throw new ValidationError("Pick a payment mode.", "mode");
}

function nonNegative(n: unknown, field: string, what: string): number {
  const v = typeof n === "number" ? n : Number.NaN;
  if (!Number.isFinite(v) || v < 0) throw new ValidationError(`Enter a valid ${what}.`, field);
  return roundMoney(v);
}

/** The catalogue list price in the purchase currency (null when unknown or not convertible). */
function catalogueListPrice(
  price: number,
  priceCurrency: string,
  currency: string,
  at: Date,
  rates: CurrencyConfig["rates"],
): number | null {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null;
  const from = normalizeCurrency(priceCurrency);
  if (from === currency) return roundMoney(p);
  // List price is informational: when the catalogue currency has no rate, it is simply left blank.
  const known = currenciesWithRates({ rates });
  if (!known.includes(from) || !known.includes(currency)) return null;
  return roundMoney((p * rateFromTable(rates, from, at)) / rateFromTable(rates, currency, at));
}

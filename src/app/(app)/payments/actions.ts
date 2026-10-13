"use server";
import { revalidatePath } from "next/cache";
import { PAYMENT_MODES, type PaymentMode } from "@/db/schema";
import { bool, fail, num, ok, str, type ActionResult } from "@/lib/action";
import { can, canEditContact, canViewContact } from "@/lib/auth/permissions";
import { requireUser, type SessionUser } from "@/lib/auth/session";
import {
  addPayment,
  adjustCredit,
  cancelPurchase,
  recordInstalmentPayment,
  recordRefund,
  rejectPayment,
  verifyPayment,
} from "@/lib/money";
import { BASE_CURRENCY, normalizeCurrency } from "@/lib/money/fx";
import { getSetting } from "@/lib/settings";
import { validTimeZone } from "@/lib/today/time";
import { isUuid } from "@/lib/utils";
import { referenceRequired } from "@/components/payments/rules";
import { failFields, moneyDateFromInput, moneyFailureFor, readProof, storeProof } from "./_lib/forms";
import { getPaymentContext, getPurchaseContext, type MoneyRowContext } from "./_lib/queries";

const MAX_REASON = 500;

function revalidateMoney(ctx: MoneyRowContext) {
  revalidatePath("/payments");
  revalidatePath(`/payments/${ctx.purchaseId}`);
  revalidatePath(`/contacts/${ctx.contactId}`);
}

/** The row's contact must be one the user can see; recording money also needs edit rights on the contact. */
function allowed(user: SessionUser, ctx: MoneyRowContext | null, edit: boolean): ctx is MoneyRowContext {
  if (!ctx || !canViewContact(user, ctx)) return false;
  return !edit || canEditContact(user, ctx);
}

/** Money received: mode, reference (UTR required for bank/UPI), paid date, proof and the manager's verify tick. */
async function readReceipt(user: SessionUser, fd: FormData) {
  const errors: Record<string, string> = {};
  const modeRaw = str(fd, "mode");
  const mode = PAYMENT_MODES.includes(modeRaw as PaymentMode) ? (modeRaw as PaymentMode) : null;
  if (!mode) errors.mode = "Pick how they paid.";
  const reference = str(fd, "reference");
  if (mode && referenceRequired(mode) && !reference) {
    errors.reference = mode === "tagmango" ? "Enter the TagMango order id." : "Enter the UTR for this payment.";
  }
  if (reference && reference.length > 100) errors.reference = "That reference is too long.";
  const now = new Date();
  const paidAt = moneyDateFromInput(str(fd, "paidDate"), validTimeZone(user.timezone), now);
  if (!paidAt) errors.paidDate = "Enter the date the money came in.";
  const verify = bool(fd, "verify");
  if (verify && !can(user, "payments.verify")) errors.verify = "Only a manager can mark a payment as verified.";
  const proof = readProof(fd);
  if (proof.error) errors.proof = proof.error;
  return { errors, mode, reference, paidAt, verify, proof: proof.file };
}

const RECEIPT_FIELDS: Record<string, string> = { paidAt: "paidDate", paidAmount: "amount" };

// ---------------------------------------------------------------------------
// Verification (manager / admin)
// ---------------------------------------------------------------------------

export async function verifyPaymentAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "payments.verify")) return fail("Only a manager can verify payments.");
  const paymentId = str(fd, "paymentId") ?? "";
  const ctx = await getPaymentContext(paymentId);
  if (!allowed(user, ctx, false)) return fail("This payment is not available to you.");
  try {
    await verifyPayment(paymentId, user);
  } catch (e) {
    return moneyFailureFor(user, e);
  }
  revalidateMoney(ctx);
  return ok(undefined, "Verified. It now counts toward LTV.");
}

export async function rejectPaymentAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "payments.verify")) return fail("Only a manager can reject payments.");
  const paymentId = str(fd, "paymentId") ?? "";
  const reason = str(fd, "reason");
  if (!reason) return failFields({ reason: "Say why it is rejected, e.g. the UTR is not in the bank statement." });
  if (reason.length > MAX_REASON) return failFields({ reason: `Keep the reason under ${MAX_REASON} characters.` });
  const ctx = await getPaymentContext(paymentId);
  if (!allowed(user, ctx, false)) return fail("This payment is not available to you.");
  let rescheduled = false;
  try {
    const r = await rejectPayment(paymentId, user, reason);
    rescheduled = !!r.rescheduledPaymentId;
  } catch (e) {
    return moneyFailureFor(user, e);
  }
  revalidateMoney(ctx);
  return ok(undefined, rescheduled ? "Rejected. The amount is back on the schedule to collect." : "Rejected.");
}

// ---------------------------------------------------------------------------
// Money in: instalments and part payments
// ---------------------------------------------------------------------------

/** Pay a scheduled instalment (reference + proof). Unverified unless a manager ticks "verified". */
export async function recordInstalmentAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "payments.record")) return fail("You can't record payments.");
  const paymentId = str(fd, "paymentId") ?? "";
  const ctx = await getPaymentContext(paymentId);
  if (!allowed(user, ctx, true)) return fail("Only the owner or a manager can record payments for this contact.");
  const r = await readReceipt(user, fd);
  const amount = num(fd, "amount");
  if (amount !== null && !(amount > 0)) r.errors.amount = "Enter the amount received.";
  if (Object.keys(r.errors).length) return failFields(r.errors);
  try {
    const proofUrl = r.proof ? await storeProof(r.proof) : null;
    await recordInstalmentPayment(
      paymentId,
      { mode: r.mode!, reference: r.reference, paidAt: r.paidAt!, proofUrl, verify: r.verify, ...(amount !== null ? { amount } : {}) },
      user,
    );
  } catch (e) {
    return moneyFailureFor(user, e, RECEIPT_FIELDS);
  }
  revalidateMoney(ctx);
  return ok(undefined, r.verify ? "Payment recorded and verified." : "Payment recorded. A manager will verify it.");
}

/** An extra part payment outside the schedule (or the balance of a part-paid purchase). */
export async function addPaymentAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "payments.record")) return fail("You can't record payments.");
  const purchaseId = str(fd, "purchaseId") ?? "";
  const ctx = await getPurchaseContext(purchaseId);
  if (!allowed(user, ctx, true)) return fail("Only the owner or a manager can record payments for this contact.");
  const r = await readReceipt(user, fd);
  const amount = num(fd, "amount");
  if (amount === null || !(amount > 0)) r.errors.amount = "Enter the amount received.";
  const currencyRaw = str(fd, "currency");
  let currency: string | undefined;
  if (currencyRaw) {
    const enabled = (await getSetting("currency")).enabled.map(normalizeCurrency);
    currency = normalizeCurrency(currencyRaw);
    // the base currency and the purchase's own currency are always fine (the sheet offers both)
    const currencyOk = currency === BASE_CURRENCY || currency === normalizeCurrency(ctx.purchaseCurrency) || enabled.includes(currency);
    if (!currencyOk) r.errors.currency = `${currency} is not switched on in Settings > Currency.`;
  }
  if (Object.keys(r.errors).length) return failFields(r.errors);
  try {
    const proofUrl = r.proof ? await storeProof(r.proof) : null;
    await addPayment(
      purchaseId,
      { amount: amount!, currency, mode: r.mode!, reference: r.reference, paidAt: r.paidAt!, proofUrl, verify: r.verify },
      user,
    );
  } catch (e) {
    return moneyFailureFor(user, e, RECEIPT_FIELDS);
  }
  revalidateMoney(ctx);
  return ok(undefined, r.verify ? "Payment recorded and verified." : "Payment recorded. A manager will verify it.");
}

// ---------------------------------------------------------------------------
// Refunds, cancellation, credit
// ---------------------------------------------------------------------------

/** Manager / admin: money given back. Cannot exceed what was received (verified, net of refunds). */
export async function recordRefundAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "payments.refund")) return fail("Only a manager can record refunds.");
  const purchaseId = str(fd, "purchaseId") ?? "";
  const ctx = await getPurchaseContext(purchaseId);
  if (!allowed(user, ctx, false)) return fail("This purchase is not available to you.");
  const errors: Record<string, string> = {};
  const amount = num(fd, "amount");
  if (amount === null || !(amount > 0)) errors.amount = "Enter the amount refunded.";
  const reason = str(fd, "reason");
  if (!reason) errors.reason = "Say why the money was refunded.";
  else if (reason.length > MAX_REASON) errors.reason = `Keep the reason under ${MAX_REASON} characters.`;
  const reference = str(fd, "reference");
  if (reference && reference.length > 100) errors.reference = "That reference is too long.";
  const refundedAt = moneyDateFromInput(str(fd, "refundDate"), validTimeZone(user.timezone), new Date());
  if (!refundedAt) errors.refundDate = "Enter the refund date.";
  if (Object.keys(errors).length) return failFields(errors);
  try {
    await recordRefund(purchaseId, { amount: amount!, reason: reason!, reference, refundedAt: refundedAt! }, user);
  } catch (e) {
    return moneyFailureFor(user, e, { refundedAt: "refundDate" });
  }
  revalidateMoney(ctx);
  return ok(undefined, "Refund recorded. LTV has dropped by the refunded amount.");
}

/** Void a purchase recorded by mistake, before any money is verified. */
export async function cancelPurchaseAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "payments.record")) return fail("You can't change purchases.");
  const purchaseId = str(fd, "purchaseId") ?? "";
  const ctx = await getPurchaseContext(purchaseId);
  if (!allowed(user, ctx, true)) return fail("Only the owner or a manager can cancel this purchase.");
  const reason = str(fd, "reason");
  if (!reason) return failFields({ reason: "Say why it is cancelled, e.g. recorded on the wrong contact." });
  if (reason.length > MAX_REASON) return failFields({ reason: `Keep the reason under ${MAX_REASON} characters.` });
  try {
    await cancelPurchase(purchaseId, user, reason);
  } catch (e) {
    return moneyFailureFor(user, e);
  }
  revalidateMoney(ctx);
  return ok(undefined, "Purchase cancelled. Its references are free to use again.");
}

/** Manager / admin: who gets the sales credit ("self" = self-serve). */
export async function adjustCreditAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "credit.adjust")) return fail("Only a manager can change sales credit.");
  const purchaseId = str(fd, "purchaseId") ?? "";
  const ctx = await getPurchaseContext(purchaseId);
  if (!allowed(user, ctx, false)) return fail("This purchase is not available to you.");
  const choice = str(fd, "creditedUserId");
  if (!choice) return failFields({ creditedUserId: "Pick a salesperson, or self-serve." });
  if (choice !== "self" && !isUuid(choice)) return failFields({ creditedUserId: "Pick a salesperson from the list." });
  try {
    await adjustCredit(purchaseId, choice === "self" ? null : choice, user);
  } catch (e) {
    return moneyFailureFor(user, e);
  }
  revalidateMoney(ctx);
  return ok(undefined, "Sales credit updated.");
}

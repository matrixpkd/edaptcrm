/**
 * Pure money rules: references, instalment plans, purchase totals and status, LTV, sales-credit window,
 * abandoned-checkout resolution and refund valuation. No database access, no "server-only":
 * unit tested directly and safe for client components (e.g. the Record payment form).
 */
import type {
  PaymentKind,
  PaymentMode,
  PaymentStatus,
  PurchaseSource,
  PurchaseStatus,
  Role,
} from "@/db/schema";
import { can } from "@/lib/auth/permissions";
import { DAY_MS } from "@/lib/utils";
import { ValidationError } from "./errors";
import { normalizeCurrency, roundMoney, roundRate } from "./fx";

/** Who is acting. `null` everywhere in the money services means "the system" (webhooks, imports, cron). */
export type Actor = { id: string; role: Role };

/** Half a paisa: amounts closer than this are equal. */
export const MONEY_EPSILON = 0.005;

// ---------------------------------------------------------------------------
// References (TagMango order id, UTR, refund id)
// ---------------------------------------------------------------------------

/**
 * Trim and drop every whitespace character; empty -> null. Bank and UPI references (UTRs) are also upper-cased,
 * because people type them by hand. TagMango order ids are kept as sent.
 */
export function normalizeReference(ref: string | null | undefined, mode?: PaymentMode | null): string | null {
  if (ref === null || ref === undefined) return null;
  const s = String(ref).replace(/\s+/g, "");
  if (!s) return null;
  return mode === "bank_transfer" || mode === "upi_qr" ? s.toUpperCase() : s;
}

/** What to call a reference in messages: "TagMango order", "UTR" or "reference". */
export function referenceLabel(mode?: PaymentMode | null, source?: PurchaseSource | null): string {
  if (mode === "tagmango" || source === "tagmango") return "TagMango order";
  if (mode === "bank_transfer" || mode === "upi_qr") return "UTR";
  return "reference";
}

/**
 * Must a payment made now carry a reference? Bank transfer and UPI need the UTR, TagMango needs the order id.
 * Imported history is exempt (old sheets often have no UTR). Cash and other never need one.
 */
export function paymentReferenceRequired(mode: PaymentMode, source: PurchaseSource): boolean {
  if (source === "import") return false;
  return mode === "bank_transfer" || mode === "upi_qr" || mode === "tagmango";
}

/** May this actor mark money verified directly? The system (null) and managers/admins may. */
export function canMarkVerified(actor: Actor | null): boolean {
  return actor === null || can(actor, "payments.verify");
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/** Money columns are numeric(14,2): anything at or above this cannot be stored. */
export const MAX_STORABLE_AMOUNT = 1e12;

/** A positive amount rounded to 2 decimals, or a ValidationError naming the field. */
export function positiveAmount(n: unknown, field = "amount", what = "an amount"): number {
  const v = typeof n === "number" ? n : Number.NaN;
  if (!Number.isFinite(v) || roundMoney(v) <= 0) throw new ValidationError(`Enter ${what} above zero.`, field);
  if (v >= MAX_STORABLE_AMOUNT) throw new ValidationError(`That amount is too large. Check ${what}.`, field);
  return roundMoney(v);
}

/** An INR value that fits the books (a huge foreign amount can overflow once converted). */
export function storableInr(amountInr: number, field = "amount"): number {
  if (!Number.isFinite(amountInr) || Math.abs(amountInr) >= MAX_STORABLE_AMOUNT) {
    throw new ValidationError("That amount is too large once converted to INR. Check the amount and currency.", field);
  }
  return amountInr;
}

export function validDate(d: unknown, field: string, what = "date"): Date {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new ValidationError(`Enter a valid ${what}.`, field);
  return d;
}

/**
 * Money cannot be received (or refunded) in the future. One day of slack absorbs clock skew and a date-only
 * "today" entered from a time zone ahead of UTC.
 */
export function notInFuture(d: Date, now: Date, field: string, what = "date"): Date {
  if (d.getTime() > now.getTime() + DAY_MS) throw new ValidationError(`The ${what} can't be in the future.`, field);
  return d;
}

// ---------------------------------------------------------------------------
// Instalments (EMI)
// ---------------------------------------------------------------------------

export type InstalmentInput = { amount: number; dueAt: Date };
export type PlannedInstalment = { seq: number; amount: number; dueAt: Date };

/**
 * Validate an EMI schedule: every instalment above zero with a valid due date, and the instalments must add up
 * to the purchase amount. Returns them sorted by due date and numbered 1..n.
 */
export function planInstalments(instalments: InstalmentInput[], total: number): PlannedInstalment[] {
  if (!instalments.length) throw new ValidationError("Add at least one instalment.", "instalments");
  const rows = instalments.map((i, idx) => ({
    idx,
    amount: positiveAmount(i?.amount, "instalments", `instalment ${idx + 1}'s amount`),
    dueAt: validDate(i?.dueAt, "instalments", `due date for instalment ${idx + 1}`),
  }));
  const sum = roundMoney(rows.reduce((s, r) => s + r.amount, 0));
  const want = roundMoney(total);
  if (Math.abs(sum - want) > MONEY_EPSILON) {
    throw new ValidationError(`The instalments add up to ${fmt(sum)}, but the amount is ${fmt(want)}.`, "instalments");
  }
  return rows
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.idx - b.idx)
    .map((r, i) => ({ seq: i + 1, amount: r.amount, dueAt: r.dueAt }));
}

// ---------------------------------------------------------------------------
// Totals, status, LTV
// ---------------------------------------------------------------------------

/** The money fields of a payments row. */
export type MoneyRow = {
  kind: PaymentKind;
  status: PaymentStatus;
  amount: number;
  currency: string;
  amountInr: number;
};

/** The money fields of a purchases row. */
export type PurchaseMoney = {
  amount: number;
  currency: string;
  fxRate: number;
  status: PurchaseStatus;
};

/** A payment's amount in its purchase's currency (via INR at the purchase rate when the currencies differ). */
export function inPurchaseCurrency(row: Pick<MoneyRow, "amount" | "currency" | "amountInr">, purchase: Pick<PurchaseMoney, "currency" | "fxRate">): number {
  if (normalizeCurrency(row.currency) === normalizeCurrency(purchase.currency)) return Number(row.amount);
  const rate = Number(purchase.fxRate) || 1;
  return roundMoney(Number(row.amountInr) / rate);
}

export type PurchaseTotals = {
  /** verified payments, in the purchase currency */
  paid: number;
  /** verified refunds, in the purchase currency */
  refunded: number;
  /** paid - refunded */
  net: number;
  /** claimed (UTR/screenshot) but not yet verified */
  unverified: number;
  /** future instalments not yet paid */
  scheduled: number;
  /** amount - paid, never below zero (refunds do not reopen a balance) */
  outstanding: number;
  /** amount - (paid + unverified): what can still be collected without over-charging */
  collectable: number;
  paidInr: number;
  refundedInr: number;
  /** this purchase's contribution to LTV */
  netInr: number;
};

export function purchaseTotals(purchase: Pick<PurchaseMoney, "amount" | "currency" | "fxRate">, rows: MoneyRow[]): PurchaseTotals {
  let paid = 0, refunded = 0, unverified = 0, scheduled = 0, paidInr = 0, refundedInr = 0;
  for (const r of rows) {
    const v = inPurchaseCurrency(r, purchase);
    if (r.kind === "refund") {
      if (r.status === "verified") {
        refunded += v;
        refundedInr += Number(r.amountInr);
      }
      continue;
    }
    if (r.status === "verified") {
      paid += v;
      paidInr += Number(r.amountInr);
    } else if (r.status === "unverified") unverified += v;
    else if (r.status === "scheduled") scheduled += v;
  }
  const amount = Number(purchase.amount);
  paid = roundMoney(paid);
  refunded = roundMoney(refunded);
  unverified = roundMoney(unverified);
  return {
    paid,
    refunded,
    net: roundMoney(paid - refunded),
    unverified,
    scheduled: roundMoney(scheduled),
    outstanding: Math.max(0, roundMoney(amount - paid)),
    collectable: Math.max(0, roundMoney(amount - paid - unverified)),
    paidInr: roundMoney(paidInr),
    refundedInr: roundMoney(refundedInr),
    netInr: roundMoney(paidInr - refundedInr),
  };
}

/**
 * The purchase status implied by its payments:
 * - cancelled stays cancelled;
 * - verified refunds covering every verified payment (and > 0) -> refunded;
 * - nothing verified -> pending; some verified -> partial; verified >= amount -> paid.
 * A partial refund keeps the purchase paid/partial (the refund row shows it); only a full refund flips it.
 * Unverified, scheduled and rejected rows never count.
 */
export function derivePurchaseStatus(purchase: PurchaseMoney, rows: MoneyRow[]): PurchaseStatus {
  if (purchase.status === "cancelled") return "cancelled";
  const t = purchaseTotals(purchase, rows);
  if (t.refunded > MONEY_EPSILON && t.refunded >= t.paid - MONEY_EPSILON) return "refunded";
  if (t.paid <= MONEY_EPSILON) return "pending";
  if (t.paid >= Number(purchase.amount) - MONEY_EPSILON) return "paid";
  return "partial";
}

/** LTV = verified payments (INR) - verified refunds (INR). Unverified, scheduled and rejected rows never count. */
export function ltvInr(rows: Pick<MoneyRow, "kind" | "status" | "amountInr">[]): number {
  let total = 0;
  for (const r of rows) {
    if (r.status !== "verified") continue;
    total += r.kind === "refund" ? -Number(r.amountInr) : Number(r.amountInr);
  }
  return roundMoney(total);
}

/**
 * INR value of a refund made in the purchase's own currency: money goes back at the rate it came in at
 * (the purchase's average verified rate), so a full refund nets this purchase to exactly zero and a later
 * rate change cannot push LTV negative. Requires totals.net > 0.
 */
export function refundInrValue(amount: number, totals: Pick<PurchaseTotals, "net" | "netInr">): { amountInr: number; fxRate: number } {
  const rate = totals.net > 0 ? totals.netInr / totals.net : 1;
  if (amount >= totals.net - MONEY_EPSILON) return { amountInr: roundMoney(totals.netInr), fxRate: roundRate(rate) };
  return { amountInr: Math.min(roundMoney(amount * rate), roundMoney(totals.netInr)), fxRate: roundRate(rate) };
}

// ---------------------------------------------------------------------------
// Sales credit (ownership rule 6)
// ---------------------------------------------------------------------------

/** True when an interaction falls in the `days` before the purchase (inclusive of the purchase moment). */
export function withinCreditWindow(interactionAt: Date, purchasedAt: Date, days: number): boolean {
  const t = interactionAt.getTime();
  const p = purchasedAt.getTime();
  return t <= p && t >= p - days * DAY_MS;
}

// ---------------------------------------------------------------------------
// Abandoned checkouts
// ---------------------------------------------------------------------------

export const CHECKOUT_ENQUIRY_STATUSES = ["checkout_started", "checkout_failed", "abandoned"] as const;

export function isCheckoutStatus(status: string): boolean {
  return (CHECKOUT_ENQUIRY_STATUSES as readonly string[]).includes(status);
}

/**
 * What happens to a checkout enquiry when the contact's verified money arrives (paid at `paidAt`):
 * - "recovered": it was abandoned (status abandoned, an abandoned-checkout alert was open, or the money came
 *   at least `abandonedMinutes` after the checkout started) — counted on the dashboard as a recovery;
 * - "handled": the checkout simply completed within the window — a normal sale, not a recovery;
 * - null: not a checkout enquiry, or it started more than a day after this payment (a separate attempt).
 */
export function checkoutResolution(
  enquiry: { status: string; receivedAt: Date },
  paidAt: Date,
  abandonedMinutes: number,
  abandonedAlertOpen = false,
): "recovered" | "handled" | null {
  if (!isCheckoutStatus(enquiry.status)) return null;
  const gap = paidAt.getTime() - enquiry.receivedAt.getTime();
  if (gap < -DAY_MS) return null;
  if (enquiry.status === "abandoned" || abandonedAlertOpen || gap >= abandonedMinutes * 60_000) return "recovered";
  return "handled";
}

function fmt(n: number): string {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

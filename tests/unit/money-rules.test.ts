import { describe, expect, it } from "vitest";
import { DuplicateReferenceError, isMoneyError, PermissionError, ValidationError } from "@/lib/money/errors";
import {
  canMarkVerified,
  checkoutResolution,
  derivePurchaseStatus,
  inPurchaseCurrency,
  ltvInr,
  normalizeReference,
  paymentReferenceRequired,
  planInstalments,
  positiveAmount,
  purchaseTotals,
  referenceLabel,
  refundInrValue,
  withinCreditWindow,
  type MoneyRow,
  type PurchaseMoney,
} from "@/lib/money/rules";

const DAY = 24 * 3600 * 1000;
const inr = (over: Partial<PurchaseMoney> = {}): PurchaseMoney => ({ amount: 10000, currency: "INR", fxRate: 1, status: "pending", ...over });
const pay = (amount: number, status: MoneyRow["status"], over: Partial<MoneyRow> = {}): MoneyRow => ({
  kind: "payment",
  status,
  amount,
  currency: "INR",
  amountInr: amount,
  ...over,
});
const refund = (amount: number, over: Partial<MoneyRow> = {}): MoneyRow => pay(amount, "verified", { kind: "refund", ...over });

describe("references", () => {
  it("strips whitespace and upper-cases UTRs only", () => {
    expect(normalizeReference("  sbin 1234 5678 ", "bank_transfer")).toBe("SBIN12345678");
    expect(normalizeReference("utr9x", "upi_qr")).toBe("UTR9X");
    expect(normalizeReference(" 64f0ab12cd ", "tagmango")).toBe("64f0ab12cd");
    expect(normalizeReference("abc", "cash")).toBe("abc");
    expect(normalizeReference("   ", "upi_qr")).toBeNull();
    expect(normalizeReference(null)).toBeNull();
    expect(normalizeReference(undefined)).toBeNull();
  });

  it("labels", () => {
    expect(referenceLabel("tagmango")).toBe("TagMango order");
    expect(referenceLabel("cash", "tagmango")).toBe("TagMango order");
    expect(referenceLabel("bank_transfer")).toBe("UTR");
    expect(referenceLabel("upi_qr", "manual")).toBe("UTR");
    expect(referenceLabel("cash")).toBe("reference");
  });

  it("bank, UPI and TagMango payments need a reference; cash, other and imports don't", () => {
    expect(paymentReferenceRequired("bank_transfer", "manual")).toBe(true);
    expect(paymentReferenceRequired("upi_qr", "manual")).toBe(true);
    expect(paymentReferenceRequired("tagmango", "tagmango")).toBe(true);
    expect(paymentReferenceRequired("cash", "manual")).toBe(false);
    expect(paymentReferenceRequired("other", "manual")).toBe(false);
    expect(paymentReferenceRequired("bank_transfer", "import")).toBe(false);
  });
});

describe("canMarkVerified", () => {
  it("system, admin and manager may verify; sales and support may not", () => {
    expect(canMarkVerified(null)).toBe(true);
    expect(canMarkVerified({ id: "a", role: "admin" })).toBe(true);
    expect(canMarkVerified({ id: "m", role: "manager" })).toBe(true);
    expect(canMarkVerified({ id: "s", role: "sales" })).toBe(false);
    expect(canMarkVerified({ id: "x", role: "support" })).toBe(false);
  });
});

describe("planInstalments", () => {
  it("sorts by due date and numbers 1..n", () => {
    const plan = planInstalments(
      [
        { amount: 3000, dueAt: new Date("2026-12-01") },
        { amount: 4000, dueAt: new Date("2026-10-01") },
        { amount: 3000, dueAt: new Date("2026-11-01") },
      ],
      10000,
    );
    expect(plan.map((p) => [p.seq, p.amount, p.dueAt.toISOString().slice(0, 10)])).toEqual([
      [1, 4000, "2026-10-01"],
      [2, 3000, "2026-11-01"],
      [3, 3000, "2026-12-01"],
    ]);
  });

  it("accepts paise that add up exactly", () => {
    const plan = planInstalments(
      [
        { amount: 3333.33, dueAt: new Date("2026-10-01") },
        { amount: 3333.33, dueAt: new Date("2026-11-01") },
        { amount: 3333.34, dueAt: new Date("2026-12-01") },
      ],
      10000,
    );
    expect(plan).toHaveLength(3);
  });

  it("rejects a schedule that does not add up", () => {
    expect(() => planInstalments([{ amount: 5000, dueAt: new Date() }, { amount: 4000, dueAt: new Date() }], 10000)).toThrow(
      /add up to 9,000.*10,000/,
    );
    expect(() => planInstalments([{ amount: 6000, dueAt: new Date() }, { amount: 6000, dueAt: new Date() }], 10000)).toThrow(
      ValidationError,
    );
  });

  it("rejects empty, zero, negative or undated instalments", () => {
    expect(() => planInstalments([], 100)).toThrow(ValidationError);
    expect(() => planInstalments([{ amount: 0, dueAt: new Date() }, { amount: 100, dueAt: new Date() }], 100)).toThrow(
      ValidationError,
    );
    expect(() => planInstalments([{ amount: -50, dueAt: new Date() }, { amount: 150, dueAt: new Date() }], 100)).toThrow(
      ValidationError,
    );
    expect(() => planInstalments([{ amount: 100, dueAt: new Date("nope") }], 100)).toThrow(/due date/);
  });
});

describe("positiveAmount", () => {
  it("rounds and rejects zero, negative and non-numbers", () => {
    expect(positiveAmount(10.005)).toBe(10.01);
    expect(() => positiveAmount(0)).toThrow(ValidationError);
    expect(() => positiveAmount(-1)).toThrow(ValidationError);
    expect(() => positiveAmount(0.001)).toThrow(ValidationError);
    expect(() => positiveAmount("100")).toThrow(ValidationError);
    expect(() => positiveAmount(Number.NaN)).toThrow(ValidationError);
  });
});

describe("derivePurchaseStatus", () => {
  it("pending when nothing is verified (unverified, scheduled and rejected never count)", () => {
    expect(derivePurchaseStatus(inr(), [])).toBe("pending");
    expect(derivePurchaseStatus(inr(), [pay(10000, "unverified")])).toBe("pending");
    expect(derivePurchaseStatus(inr(), [pay(5000, "scheduled"), pay(5000, "rejected")])).toBe("pending");
  });

  it("partial, then paid", () => {
    expect(derivePurchaseStatus(inr(), [pay(4000, "verified"), pay(6000, "scheduled")])).toBe("partial");
    expect(derivePurchaseStatus(inr(), [pay(4000, "verified"), pay(6000, "unverified")])).toBe("partial");
    expect(derivePurchaseStatus(inr(), [pay(4000, "verified"), pay(6000, "verified")])).toBe("paid");
    expect(derivePurchaseStatus(inr(), [pay(9999.996, "verified")])).toBe("paid");
  });

  it("refunded only when refunds cover every verified payment; a partial refund keeps the status", () => {
    expect(derivePurchaseStatus(inr(), [pay(10000, "verified"), refund(10000)])).toBe("refunded");
    expect(derivePurchaseStatus(inr(), [pay(10000, "verified"), refund(4000)])).toBe("paid");
    expect(derivePurchaseStatus(inr(), [pay(4000, "verified"), pay(6000, "scheduled"), refund(4000)])).toBe("refunded");
    expect(derivePurchaseStatus(inr(), [pay(4000, "verified"), refund(1000)])).toBe("partial");
  });

  it("cancelled stays cancelled", () => {
    expect(derivePurchaseStatus(inr({ status: "cancelled" }), [pay(10000, "verified")])).toBe("cancelled");
  });

  it("compares in the purchase currency, so an AED purchase is paid even if the INR rate moved", () => {
    const aed = inr({ amount: 1000, currency: "AED", fxRate: 22.7 });
    // paid in AED in a later month at 22.6: INR differs, AED amount matches
    expect(derivePurchaseStatus(aed, [pay(1000, "verified", { currency: "AED", amountInr: 22600 })])).toBe("paid");
    // part of it paid in INR: converted at the purchase rate
    expect(
      derivePurchaseStatus(aed, [
        pay(500, "verified", { currency: "AED", amountInr: 11350 }),
        pay(11350, "verified", { currency: "INR", amountInr: 11350 }),
      ]),
    ).toBe("paid");
  });
});

describe("purchaseTotals / ltvInr", () => {
  it("adds up each bucket", () => {
    const t = purchaseTotals(inr(), [pay(3000, "verified"), pay(2000, "unverified"), pay(5000, "scheduled"), pay(700, "rejected"), refund(1000)]);
    expect(t).toMatchObject({
      paid: 3000,
      refunded: 1000,
      net: 2000,
      unverified: 2000,
      scheduled: 5000,
      outstanding: 7000,
      collectable: 5000,
      paidInr: 3000,
      refundedInr: 1000,
      netInr: 2000,
    });
  });

  it("LTV = verified payments - verified refunds, in INR", () => {
    expect(
      ltvInr([
        pay(22700, "verified"),
        pay(5000, "unverified"),
        pay(3000, "scheduled"),
        pay(800, "rejected"),
        refund(2000),
        { kind: "refund", status: "rejected", amountInr: 999 },
      ]),
    ).toBe(20700);
    expect(ltvInr([])).toBe(0);
  });

  it("inPurchaseCurrency converts foreign payments via INR at the purchase rate", () => {
    expect(inPurchaseCurrency({ amount: 2270, currency: "INR", amountInr: 2270 }, { currency: "AED", fxRate: 22.7 })).toBe(100);
    expect(inPurchaseCurrency({ amount: 100, currency: "aed", amountInr: 2260 }, { currency: "AED", fxRate: 22.7 })).toBe(100);
  });
});

describe("refundInrValue", () => {
  it("a full refund nets the purchase INR to zero, whatever today's rate", () => {
    expect(refundInrValue(1000, { net: 1000, netInr: 22600 })).toEqual({ amountInr: 22600, fxRate: 22.6 });
  });

  it("a part refund uses the rate the money came in at", () => {
    expect(refundInrValue(250, { net: 1000, netInr: 22600 })).toEqual({ amountInr: 5650, fxRate: 22.6 });
  });

  it("INR is 1:1", () => {
    expect(refundInrValue(1500, { net: 5000, netInr: 5000 })).toEqual({ amountInr: 1500, fxRate: 1 });
  });
});

describe("withinCreditWindow", () => {
  const purchasedAt = new Date("2026-10-31T10:00:00Z");
  it("counts interactions in the N days before the purchase, inclusive", () => {
    expect(withinCreditWindow(new Date(purchasedAt.getTime() - 29 * DAY), purchasedAt, 30)).toBe(true);
    expect(withinCreditWindow(new Date(purchasedAt.getTime() - 30 * DAY), purchasedAt, 30)).toBe(true);
    expect(withinCreditWindow(purchasedAt, purchasedAt, 30)).toBe(true);
  });
  it("ignores older interactions and interactions after the purchase", () => {
    expect(withinCreditWindow(new Date(purchasedAt.getTime() - 31 * DAY), purchasedAt, 30)).toBe(false);
    expect(withinCreditWindow(new Date(purchasedAt.getTime() + 60_000), purchasedAt, 30)).toBe(false);
  });
});

describe("checkoutResolution", () => {
  const paidAt = new Date("2026-10-13T12:00:00Z");
  const ago = (min: number) => new Date(paidAt.getTime() - min * 60_000);
  it("a checkout completed within the window is a normal sale (handled)", () => {
    expect(checkoutResolution({ status: "checkout_started", receivedAt: ago(5) }, paidAt, 60)).toBe("handled");
    expect(checkoutResolution({ status: "checkout_failed", receivedAt: ago(2) }, paidAt, 60)).toBe("handled");
  });
  it("money after the abandoned window, an abandoned status or an open alert is a recovery", () => {
    expect(checkoutResolution({ status: "checkout_started", receivedAt: ago(60) }, paidAt, 60)).toBe("recovered");
    expect(checkoutResolution({ status: "checkout_failed", receivedAt: ago(60 * 24 * 3) }, paidAt, 60)).toBe("recovered");
    expect(checkoutResolution({ status: "abandoned", receivedAt: ago(1) }, paidAt, 60)).toBe("recovered");
    expect(checkoutResolution({ status: "checkout_started", receivedAt: ago(5) }, paidAt, 60, true)).toBe("recovered");
  });
  it("ignores non-checkout enquiries and checkouts started well after the payment", () => {
    expect(checkoutResolution({ status: "open", receivedAt: ago(90) }, paidAt, 60)).toBeNull();
    expect(checkoutResolution({ status: "recovered", receivedAt: ago(90) }, paidAt, 60)).toBeNull();
    expect(checkoutResolution({ status: "checkout_started", receivedAt: new Date(paidAt.getTime() + 2 * DAY) }, paidAt, 60)).toBeNull();
    // a date-only payment entered for earlier the same day still resolves the checkout
    expect(checkoutResolution({ status: "checkout_started", receivedAt: new Date(paidAt.getTime() + 3600_000) }, paidAt, 60)).toBe("handled");
  });
});

describe("errors", () => {
  it("carry user-facing messages", () => {
    const dup = new DuplicateReferenceError({ reference: "UTR1", label: "UTR", contactName: "Ravi Kumar" });
    expect(dup.message).toBe("This UTR (UTR1) is already recorded on Ravi Kumar.");
    expect(dup.name).toBe("DuplicateReferenceError");
    expect(isMoneyError(dup)).toBe(true);
    expect(new DuplicateReferenceError({ reference: "X", label: "TagMango order" }).message).toBe(
      "This TagMango order (X) is already recorded.",
    );
    expect(new PermissionError("payments.verify").message).toMatch(/permission/);
    expect(new ValidationError("Bad", "amount").field).toBe("amount");
    expect(isMoneyError(new Error("x"))).toBe(false);
  });
});

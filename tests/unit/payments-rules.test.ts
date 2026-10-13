import { describe, expect, it } from "vitest";
import { describeAudit, type AuditContext } from "@/components/payments/audit";
import {
  addMonthsYmd,
  buildSchedule,
  convertPrice,
  discountFromFinal,
  dueState,
  finalFromDiscount,
  groupProducts,
  isPdf,
  isPreviewableImage,
  isStaleClaim,
  isYmd,
  monthlyDueDates,
  parseAmount,
  proofExtension,
  proofProblem,
  referenceFieldLabel,
  referenceRequired,
  scheduleProblem,
  scheduleTotal,
  sortSchedule,
  splitEvenly,
  unshownFailure,
  waitingDays,
  waitingText,
} from "@/components/payments/rules";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";

describe("payments rules: amounts", () => {
  it("parses typed amounts with commas and spaces", () => {
    expect(parseAmount("24,999")).toBe(24999);
    expect(parseAmount(" 1 500.50 ")).toBe(1500.5);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });

  it("keeps list price, discount and final amount consistent", () => {
    expect(finalFromDiscount(24999, 4999)).toBe(20000);
    expect(finalFromDiscount(999, null)).toBe(999);
    expect(finalFromDiscount(999, 2000)).toBe(0);
    expect(finalFromDiscount(null, 100)).toBeNull();
    expect(discountFromFinal(24999, 20000)).toBe(4999);
    expect(discountFromFinal(999, 1200)).toBe(0);
    expect(discountFromFinal(null, 500)).toBe(0);
  });

  it("converts a catalogue price through INR", () => {
    // ₹24,999 in AED at 22.7 INR per AED
    expect(convertPrice(24999, 1, 22.7)).toBe(1101.28);
    // USD 999 in INR
    expect(convertPrice(999, 83.4, 1)).toBe(83316.6);
    expect(convertPrice(100, 1, 0)).toBe(100);
  });
});

describe("payments rules: instalment schedule", () => {
  it("splits evenly in whole units with the remainder on the first instalment", () => {
    expect(splitEvenly(25000, 3)).toEqual([8334, 8333, 8333]);
    expect(splitEvenly(24999, 3)).toEqual([8333, 8333, 8333]);
    expect(splitEvenly(1000.5, 2)).toEqual([500.5, 500]);
    expect(splitEvenly(2, 3)).toEqual([0.68, 0.66, 0.66]);
    expect(splitEvenly(0, 3)).toEqual([]);
    expect(splitEvenly(100, 0)).toEqual([]);
    for (const [t, n] of [[24999, 7], [150000, 12], [1234.56, 5]] as const) {
      expect(scheduleTotal(splitEvenly(t, n).map((amount) => ({ amount })))).toBe(t);
    }
  });

  it("adds calendar months, clamping the day to the month's length", () => {
    expect(addMonthsYmd("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsYmd("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonthsYmd("2026-11-15", 2)).toBe("2027-01-15");
    expect(addMonthsYmd("2026-03-10", -3)).toBe("2025-12-10");
    expect(addMonthsYmd("nope", 1)).toBeNull();
    expect(monthlyDueDates("2026-01-31", 3)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("builds a schedule and explains what is wrong with one", () => {
    const rows = buildSchedule(25000, 3, "2026-10-13");
    expect(rows).toEqual([
      { dueDate: "2026-10-13", amount: 8334 },
      { dueDate: "2026-11-13", amount: 8333 },
      { dueDate: "2026-12-13", amount: 8333 },
    ]);
    expect(scheduleProblem(rows, 25000)).toBeNull();
    expect(scheduleProblem(rows, 26000)).toBe("The instalments are 1,000 short of the total.");
    expect(scheduleProblem(rows, 24000)).toBe("The instalments are 1,000 more than the total.");
    expect(scheduleProblem(rows.slice(0, 1), 8334)).toMatch(/at least 2/);
    expect(scheduleProblem([{ dueDate: "", amount: 1 }, { dueDate: "2026-11-13", amount: 1 }], 2)).toBe("Pick a due date for instalment 1.");
    expect(scheduleProblem([{ dueDate: "2026-10-13", amount: 1 }, { dueDate: "2026-11-13", amount: Number.NaN }], 2)).toBe(
      "Enter an amount above zero for instalment 2.",
    );
  });

  it("sorts by due date, keeping the entered order for ties", () => {
    const a = { dueDate: "2026-12-01", amount: 1 };
    const b = { dueDate: "2026-10-01", amount: 2 };
    const c = { dueDate: "2026-10-01", amount: 3 };
    expect(sortSchedule([a, b, c])).toEqual([b, c, a]);
  });

  it("checks calendar dates", () => {
    expect(isYmd("2026-02-28")).toBe(true);
    expect(isYmd("2026-02-30")).toBe(false);
    expect(isYmd("13/10/2026")).toBe(false);
  });
});

describe("payments rules: references and proofs", () => {
  it("knows which modes need a reference", () => {
    expect(referenceRequired("bank_transfer")).toBe(true);
    expect(referenceRequired("upi_qr")).toBe(true);
    expect(referenceRequired("tagmango")).toBe(true);
    expect(referenceRequired("cash")).toBe(false);
    expect(referenceRequired(null)).toBe(false);
    expect(referenceFieldLabel("upi_qr")).toMatch(/UTR/);
    expect(referenceFieldLabel("tagmango")).toBe("TagMango order id");
  });

  it("accepts images and PDFs up to 10 MB, never SVG or HTML", () => {
    expect(proofProblem({ size: 1000, type: "image/png", name: "a.png" })).toBeNull();
    expect(proofProblem({ size: 1000, type: "application/pdf", name: "receipt.pdf" })).toBeNull();
    expect(proofProblem({ size: 1000, type: "", name: "IMG_1.HEIC" })).toBeNull();
    expect(proofProblem({ size: 11 * 1024 * 1024, type: "image/jpeg", name: "big.jpg" })).toMatch(/10 MB/);
    expect(proofProblem({ size: 0, type: "image/png", name: "empty.png" })).toMatch(/empty/);
    expect(proofProblem({ size: 10, type: "image/svg+xml", name: "x.svg" })).toMatch(/screenshot/);
    expect(proofProblem({ size: 10, type: "text/html", name: "x.png" })).toMatch(/screenshot/);
    expect(proofExtension({ type: "image/jpeg", name: "photo" })).toBe("jpg");
    expect(proofExtension({ type: "", name: "scan.JPEG" })).toBe("jpg");
    expect(isPreviewableImage("/api/files/proofs/2026-10/x-shot.png")).toBe(true);
    expect(isPreviewableImage("/api/files/proofs/2026-10/x.heic")).toBe(false);
    expect(isPdf("/api/files/proofs/x.pdf")).toBe(true);
  });
});

describe("payments rules: product picker", () => {
  it("groups active products by ladder family in rung order, side groups last", () => {
    const families = DEFAULT_SETTINGS["ladder.families"];
    const p = (name: string, family: string, listPrice: number) => ({ id: name, name, family, rung: null, listPrice, currency: "INR" });
    const groups = groupProducts(
      [p("School AI program", "b2b_program", 100000), p("AI Workshop", "workshop", 999), p("Entry", "workshop", 699), p("AAM", "applied_ai_mastery", 24999), p("Mystery", "retired_family", 5)],
      families,
    );
    expect(groups.map((g) => g.label)).toEqual([
      "Rung 1 · Workshops",
      "Rung 2 · Applied AI Mastery",
      "B2B and constituency · B2B programs",
      "Other · retired_family",
    ]);
    expect(groups[0].products.map((x) => x.name)).toEqual(["Entry", "AI Workshop"]);
  });
});

describe("payments rules: desk labels", () => {
  const tz = "Asia/Kolkata";
  // 13 Oct 2026, 10:00 IST
  const now = new Date("2026-10-13T04:30:00Z");
  const endOfDay = (ymd: string) => new Date(`${ymd}T23:59:00+05:30`);

  it("labels due dates in local calendar days", () => {
    expect(dueState(endOfDay("2026-10-13"), now, tz)).toEqual({ text: "Due today", overdue: false, tone: "warning" });
    expect(dueState(endOfDay("2026-10-14"), now, tz).text).toBe("Due tomorrow");
    expect(dueState(endOfDay("2026-10-16"), now, tz)).toMatchObject({ text: "Due in 3 days", tone: "neutral" });
    expect(dueState(endOfDay("2026-10-12"), now, tz)).toEqual({ text: "1 day overdue", overdue: true, tone: "danger" });
    expect(dueState(endOfDay("2026-10-08"), now, tz).text).toBe("5 days overdue");
    // a re-opened claim due earlier today is overdue but still "today"
    expect(dueState(new Date("2026-10-13T08:00:00+05:30"), now, tz)).toMatchObject({ overdue: true, tone: "danger" });
  });

  it("counts waiting days and flags claims past the alert threshold", () => {
    const since = new Date(now.getTime() - 2 * 86400000);
    expect(waitingDays(since, now)).toBe(2);
    expect(waitingText(0)).toBe("Today");
    expect(waitingText(1)).toBe("1 day");
    expect(isStaleClaim(since, now, 2)).toBe(true);
    expect(isStaleClaim(new Date(since.getTime() + 1000), now, 2)).toBe(false);
  });
});

describe("payments audit lines", () => {
  const ctx: AuditContext = {
    currency: "INR",
    hasInstalments: true,
    payments: new Map([
      ["p1", { seq: 1, kind: "payment" }],
      ["r1", { seq: 1, kind: "refund" }],
    ]),
    names: new Map([["u1", "Shafi"]]),
  };
  const line = (over: Partial<Parameters<typeof describeAudit>[0]>) => ({
    tableName: "payments",
    rowId: "p1",
    action: "update",
    field: null,
    oldValue: null,
    newValue: null,
    ...over,
  });

  it("describes the money events in plain words", () => {
    expect(
      describeAudit(
        line({ tableName: "purchases", rowId: "x", action: "insert", newValue: { amount: 24999, currency: "INR", mode: "upi_qr", reference: "UTR1", instalments: 3, paidNow: 8333, verified: false } }),
        ctx,
      ),
    ).toEqual({ title: "Purchase recorded", detail: "₹24,999 · UPI QR · ref UTR1 · 3 instalments · ₹8,333 paid now, unverified" });
    expect(describeAudit(line({ action: "verify", field: "status", oldValue: "unverified", newValue: "verified" }), ctx)).toEqual({
      title: "Instalment 1 verified",
      detail: undefined,
    });
    expect(describeAudit(line({ field: "status", oldValue: "unverified", newValue: { status: "rejected", reason: "Not in bank" } }), ctx)).toEqual({
      title: "Instalment 1 rejected",
      detail: "Not in bank",
    });
    expect(describeAudit(line({ rowId: "r1", action: "insert", field: "refund", newValue: { amount: 500, currency: "INR", reason: "Duplicate" } }), ctx)).toEqual({
      title: "Refund recorded",
      detail: "₹500 · Duplicate",
    });
    expect(describeAudit(line({ tableName: "purchases", field: "creditedUserId", oldValue: null, newValue: "u1" }), ctx)).toEqual({
      title: "Sales credit changed",
      detail: "Self-serve → Shafi",
    });
    expect(describeAudit(line({ tableName: "purchases", field: "assisted" }), ctx)).toBeNull();
    expect(describeAudit(line({ tableName: "purchases", field: "status", newValue: { status: "cancelled", reason: "Wrong contact" } }), ctx)).toEqual({
      title: "Purchase cancelled",
      detail: "Wrong contact",
    });
    expect(describeAudit(line({ field: "reference", oldValue: "UTR9", newValue: null }), ctx)?.title).toBe("Reference released");
  });
});

describe("payments rules: form errors", () => {
  it("shows the headline only when an error would otherwise be lost", () => {
    expect(unshownFailure(null, ["amount"])).toBeNull();
    expect(unshownFailure({ ok: true, message: "Saved" }, ["amount"])).toBeNull();
    const plain = { ok: false as const, error: "This purchase was cancelled." };
    expect(unshownFailure(plain, ["amount"])).toBe(plain);
    const onField = { ok: false as const, error: "Too much", fieldErrors: { amount: "Too much" } };
    expect(unshownFailure(onField, ["amount", "reference"])).toBeNull();
    const elsewhere = { ok: false as const, error: "No INR rate is set for AED.", fieldErrors: { currency: "No INR rate is set for AED." } };
    expect(unshownFailure(elsewhere, ["amount", "reference"])).toBe(elsewhere);
  });
});

import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/money/errors";
import { MAX_STORABLE_AMOUNT, notInFuture, positiveAmount, storableInr } from "@/lib/money/rules";

const DAY = 86400_000;

describe("amounts that fit the books (numeric(14,2))", () => {
  it("positiveAmount refuses amounts the column cannot hold, with a friendly message", () => {
    expect(positiveAmount(999_999_999_999.98)).toBe(999_999_999_999.98);
    expect(() => positiveAmount(MAX_STORABLE_AMOUNT)).toThrow(ValidationError);
    expect(() => positiveAmount(1e15)).toThrow(/too large/);
    expect(() => positiveAmount(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
  });

  it("storableInr refuses a converted value that would overflow", () => {
    expect(storableInr(2_270_000)).toBe(2_270_000);
    expect(() => storableInr(2.27e12)).toThrow(/converted to INR/);
    expect(() => storableInr(Number.NaN)).toThrow(ValidationError);
  });
});

describe("notInFuture", () => {
  const now = new Date("2026-10-13T06:00:00Z");
  it("accepts the past, now and up to a day ahead (date-only 'today' from a zone ahead of UTC)", () => {
    expect(notInFuture(new Date("2026-01-01T00:00:00Z"), now, "paidAt")).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(() => notInFuture(now, now, "paidAt")).not.toThrow();
    expect(() => notInFuture(new Date(now.getTime() + DAY), now, "paidAt")).not.toThrow();
  });

  it("refuses a date more than a day ahead, naming the field", () => {
    try {
      notInFuture(new Date(now.getTime() + DAY + 1), now, "refundedAt", "refund date");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).field).toBe("refundedAt");
      expect((e as Error).message).toBe("The refund date can't be in the future.");
    }
  });
});

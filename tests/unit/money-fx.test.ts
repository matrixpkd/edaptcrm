import { describe, expect, it } from "vitest";
import { UnknownCurrencyError } from "@/lib/money/errors";
import { currenciesWithRates, monthKeyLabel, monthKeyOf, normalizeCurrency, rateFromTable, roundMoney, toInr } from "@/lib/money/fx";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";

const rates = {
  AED: { "2026-01": 22.6, "2026-10": 22.7 },
  USD: { "2026-01": 83.2, "2026-10": 83.4 },
};

describe("rateFromTable", () => {
  it("INR is always 1, whatever the table says", () => {
    expect(rateFromTable(rates, "INR", new Date("2026-05-01T00:00:00Z"))).toBe(1);
    expect(rateFromTable({}, "inr", new Date("2020-01-01T00:00:00Z"))).toBe(1);
  });

  it("uses the latest month at or before the payment month", () => {
    expect(rateFromTable(rates, "AED", new Date("2026-01-15T06:00:00Z"))).toBe(22.6);
    expect(rateFromTable(rates, "AED", new Date("2026-09-30T06:00:00Z"))).toBe(22.6);
    expect(rateFromTable(rates, "AED", new Date("2026-10-01T06:00:00Z"))).toBe(22.7);
    expect(rateFromTable(rates, "AED", new Date("2027-03-01T06:00:00Z"))).toBe(22.7);
    expect(rateFromTable(rates, "USD", new Date("2026-10-20T06:00:00Z"))).toBe(83.4);
  });

  it("falls back to the earliest month when every rate is later than the payment", () => {
    expect(rateFromTable(rates, "AED", new Date("2025-06-01T06:00:00Z"))).toBe(22.6);
  });

  it("counts the month in India time (a payment just after midnight IST on 1 Oct is October)", () => {
    // 2026-09-30T19:00Z = 2026-10-01 00:30 IST
    expect(rateFromTable(rates, "AED", new Date("2026-09-30T19:00:00Z"))).toBe(22.7);
    // 2026-09-30T18:00Z = 2026-09-30 23:30 IST
    expect(rateFromTable(rates, "AED", new Date("2026-09-30T18:00:00Z"))).toBe(22.6);
    // the same instant in UTC books
    expect(rateFromTable(rates, "AED", new Date("2026-09-30T19:00:00Z"), "UTC")).toBe(22.6);
  });

  it("is case- and space-insensitive on the currency code", () => {
    expect(rateFromTable(rates, " aed ", new Date("2026-10-02T00:00:00Z"))).toBe(22.7);
    expect(rateFromTable({ aed: { "2026-10": 22.7 } }, "AED", new Date("2026-10-02T00:00:00Z"))).toBe(22.7);
  });

  it("works for any currency added in Settings without code changes", () => {
    const withSar = { ...rates, SAR: { "2026-06": 22.2 } };
    expect(rateFromTable(withSar, "SAR", new Date("2026-08-01T00:00:00Z"))).toBe(22.2);
  });

  it("throws UnknownCurrencyError for a currency with no usable rate", () => {
    expect(() => rateFromTable(rates, "EUR", new Date())).toThrow(UnknownCurrencyError);
    expect(() => rateFromTable(rates, "", new Date())).toThrow(UnknownCurrencyError);
    expect(() => rateFromTable({ EUR: {} }, "EUR", new Date())).toThrow(UnknownCurrencyError);
    expect(() => rateFromTable({ EUR: { "2026-10": 0 } }, "EUR", new Date())).toThrow(UnknownCurrencyError);
    expect(() => rateFromTable({ EUR: { "Oct 2026": 90 } }, "EUR", new Date())).toThrow(UnknownCurrencyError);
    try {
      rateFromTable(rates, "EUR", new Date());
    } catch (e) {
      expect((e as UnknownCurrencyError).currency).toBe("EUR");
      expect((e as Error).message).toMatch(/Settings/);
    }
  });

  it("ignores invalid months and rates but keeps the valid ones", () => {
    const messy = { AED: { "2026-13": 99, "2026-02": -1, junk: 5, "2026-03": 22.65 } };
    expect(rateFromTable(messy, "AED", new Date("2026-08-01T00:00:00Z"))).toBe(22.65);
  });

  it("reads the spec defaults", () => {
    const r = DEFAULT_SETTINGS.currency.rates;
    expect(rateFromTable(r, "AED", new Date("2026-10-13T00:00:00Z"))).toBe(22.7);
    expect(rateFromTable(r, "USD", new Date("2026-03-01T00:00:00Z"))).toBe(83.2);
  });
});

describe("toInr / roundMoney", () => {
  it("rounds to 2 decimals", () => {
    expect(toInr(1000, 22.7)).toBe(22700);
    expect(toInr(99.99, 83.4)).toBe(8339.17);
    expect(toInr(1, 22.655)).toBe(22.66);
    expect(toInr(500, 1)).toBe(500);
  });

  it("does not drift on half-paisa values", () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(2.675)).toBe(2.68);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(-1.005)).toBe(-1.01);
    expect(roundMoney(0)).toBe(0);
    expect(Object.is(roundMoney(-0.001), 0)).toBe(true);
  });

  it("rejects non-finite amounts", () => {
    expect(() => roundMoney(Number.NaN)).toThrow();
    expect(() => roundMoney(Infinity)).toThrow();
  });
});

describe("monthKeyLabel", () => {
  it("shows a month key the way people read it, and leaves anything else alone", () => {
    expect(monthKeyLabel("2026-10")).toBe("Oct 2026");
    expect(monthKeyLabel("2027-01")).toBe("Jan 2027");
    expect(monthKeyLabel("2026-13")).toBe("2026-13");
    expect(monthKeyLabel("")).toBe("");
  });
});

describe("helpers", () => {
  it("monthKeyOf", () => {
    expect(monthKeyOf(new Date("2026-10-13T10:00:00Z"))).toBe("2026-10");
    expect(monthKeyOf(new Date("2026-12-31T20:00:00Z"))).toBe("2027-01");
    expect(monthKeyOf(new Date("2026-12-31T20:00:00Z"), "UTC")).toBe("2026-12");
    expect(() => monthKeyOf(new Date("nope"))).toThrow();
  });

  it("normalizeCurrency", () => {
    expect(normalizeCurrency(" aed")).toBe("AED");
    expect(normalizeCurrency(null)).toBe("");
  });

  it("currenciesWithRates lists INR first, then currencies with a usable rate", () => {
    expect(currenciesWithRates({ rates: { ...rates, EUR: {}, inr: { "2026-01": 1 } } })).toEqual(["INR", "AED", "USD"]);
  });
});

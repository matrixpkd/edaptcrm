import { describe, expect, it } from "vitest";
import { normalizePhone } from "@/lib/phone";

describe("normalizePhone", () => {
  it.each([
    ["98765 43210", undefined, "+919876543210"],
    ["050 123 4567", undefined, "+971501234567"],
    ["+971 50 123 4567", undefined, "+971501234567"],
    ["919876543210", undefined, "+919876543210"],
    ["9876543210", "91", "+919876543210"],
    ["501234567", "+971", "+971501234567"],
    ["0091 98765 43210", undefined, "+919876543210"],
  ])("%s (dial %s) -> %s", (raw, dial, expected) => {
    expect(normalizePhone(raw, { dialCode: dial })?.e164).toBe(expected);
  });

  it("rejects garbage", () => {
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

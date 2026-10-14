import { describe, expect, it } from "vitest";
import { errorCode } from "@/lib/error-code";

describe("health errorCode", () => {
  it("finds a SQLSTATE or errno on the error or its causes, and nothing else", () => {
    expect(errorCode(Object.assign(new Error("Tenant or user not found"), { code: "XX000" }))).toBe("XX000");
    expect(errorCode(new Error("wrapped", { cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }) }))).toBe("ENOTFOUND");
    expect(errorCode(Object.assign(new Error("x"), { code: "postgres://user:pw@host" }))).toBeNull();
    expect(errorCode(new Error("no code"))).toBeNull();
    expect(errorCode(null)).toBeNull();
  });
});

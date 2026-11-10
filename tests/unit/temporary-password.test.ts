import { describe, expect, it } from "vitest";
import {
  CHOOSE_PASSWORD_PATH,
  TEMP_PASSWORD_DAYS,
  TEMP_PASSWORD_EXPIRED,
  temporaryPasswordExpiry,
  temporaryPasswordState,
} from "@/lib/auth/temporary-password";

const NOW = new Date("2026-11-10T06:30:00Z");
const DAY = 24 * 3600 * 1000;

describe("temporary passwords", () => {
  it("work for 7 days from when the admin issues them", () => {
    expect(TEMP_PASSWORD_DAYS).toBe(7);
    expect(temporaryPasswordExpiry(NOW).toISOString()).toBe("2026-11-17T06:30:00.000Z");
    // the input is not changed
    expect(NOW.toISOString()).toBe("2026-11-10T06:30:00.000Z");
  });

  it("no expiry means the person chose their own; then temporary until the expiry, expired from that moment", () => {
    const until = temporaryPasswordExpiry(NOW);
    expect(temporaryPasswordState(null, NOW)).toBe("own");
    expect(temporaryPasswordState(undefined, NOW)).toBe("own");
    expect(temporaryPasswordState(until, NOW)).toBe("temporary");
    expect(temporaryPasswordState(until, new Date(until.getTime() - 1))).toBe("temporary");
    expect(temporaryPasswordState(until, until)).toBe("expired");
    expect(temporaryPasswordState(until, new Date(until.getTime() + DAY))).toBe("expired");
  });

  it("the refusal is plain and says what to do; the screen has its own path", () => {
    expect(TEMP_PASSWORD_EXPIRED).toBe("This temporary password has expired. Ask an admin to reset it.");
    expect(CHOOSE_PASSWORD_PATH).toBe("/choose-password");
  });
});

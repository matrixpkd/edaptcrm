import { describe, expect, it } from "vitest";
import { FOLLOW_UP_PRESETS, followUpPresets, localTimeInDays } from "@/lib/contacts/follow-up";

describe("followUpPresets", () => {
  it("gives 10:00 India time tomorrow, in 3 days and in 1 week", () => {
    // 13 Oct 2026, 15:00 IST
    const now = new Date("2026-10-13T09:30:00Z");
    const p = followUpPresets(now, "Asia/Kolkata");
    expect(p.tomorrow.toISOString()).toBe("2026-10-14T04:30:00.000Z");
    expect(p.in3Days.toISOString()).toBe("2026-10-16T04:30:00.000Z");
    expect(p.in1Week.toISOString()).toBe("2026-10-20T04:30:00.000Z");
  });

  it("uses the user's local calendar day, not UTC's", () => {
    // 20:00 UTC on the 13th is already 01:30 on the 14th in India: tomorrow is the 15th
    const now = new Date("2026-10-13T20:00:00Z");
    expect(followUpPresets(now, "Asia/Kolkata").tomorrow.toISOString()).toBe("2026-10-15T04:30:00.000Z");
    // ...while 19:59 UTC is still 23:59 on the 13th in Dubai: tomorrow there is the 14th
    const dubai = followUpPresets(new Date("2026-10-13T19:59:00Z"), "Asia/Dubai");
    expect(dubai.tomorrow.toISOString()).toBe("2026-10-14T06:00:00.000Z");
  });

  it("handles daylight saving zones", () => {
    // New York leaves DST on 1 Nov 2026: 10:00 EST is 15:00 UTC
    const now = new Date("2026-10-31T16:00:00Z");
    expect(localTimeInDays(now, "America/New_York", 1).toISOString()).toBe("2026-11-01T15:00:00.000Z");
  });

  it("falls back to India time for an unknown zone", () => {
    const now = new Date("2026-10-13T09:30:00Z");
    expect(followUpPresets(now, "Mars/Olympus").tomorrow.toISOString()).toBe("2026-10-14T04:30:00.000Z");
  });

  it("lists the three chips", () => {
    expect(FOLLOW_UP_PRESETS.map((p) => p.days)).toEqual([1, 3, 7]);
  });
});

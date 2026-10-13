import { beforeEach, describe, expect, it } from "vitest";
import { getSetting, setSetting } from "@/lib/settings";
import { makeUser, resetDb } from "../support/db";

describe("settings", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns defaults and saved overrides", async () => {
    const t = await getSetting("thresholds");
    expect(t.leadReleaseDays).toBe(7);
    const admin = await makeUser({ role: "admin" });
    await setSetting("thresholds", { ...t, leadReleaseDays: 5 }, admin.id);
    expect((await getSetting("thresholds")).leadReleaseDays).toBe(5);
    expect((await getSetting("thresholds")).todayCap).toBe(40);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, contacts } from "@/db/schema";
import { captureEnquiry } from "@/lib/contacts/capture";
import { ContactForbiddenError, ContactValidationError } from "@/lib/contacts/errors";
import { reopenContact, setManualStage } from "@/lib/contacts/lifecycle";
import { setSetting } from "@/lib/settings";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";
import { makeUser, resetDb } from "../support/db";

let seq = 0;
const inPhone = () => `98470${String(50000 + seq++).padStart(5, "0")}`;

async function lead(ownerId: string | null) {
  return (
    await captureEnquiry({ phone: inPhone(), channel: "phone_call", ownerId, skipAssignment: true, skipAlerts: true })
  ).contact;
}

describe("contacts lifecycle", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("sets Qualified by hand, with an audit row and a fresh stage date", async () => {
    const s = await makeUser({ role: "sales" });
    const c = await lead(s.id);
    const before = c.stageChangedAt;
    const r = await setManualStage(c.id, "qualified", {}, s);
    expect(r.stage).toBe("qualified");
    expect(r.lostReason).toBeNull();
    expect(r.stageChangedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    const a = await db.select().from(auditLog).where(and(eq(auditLog.rowId, c.id), eq(auditLog.field, "stage")));
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ oldValue: "new", newValue: "qualified", userId: s.id });
  });

  it("Lost needs a reason from the settings list", async () => {
    const s = await makeUser({ role: "sales" });
    const c = await lead(s.id);
    await expect(setManualStage(c.id, "lost", {}, s)).rejects.toBeInstanceOf(ContactValidationError);
    await expect(setManualStage(c.id, "lost", { lostReason: "aliens" }, s)).rejects.toThrow(/from the list/);
    const r = await setManualStage(c.id, "lost", { lostReason: "price" }, s);
    expect(r).toMatchObject({ stage: "lost", lostReason: "price" });
    // switched-off reasons cannot be chosen any more
    await setSetting(
      "lists.lostReasons",
      DEFAULT_SETTINGS["lists.lostReasons"].map((x) => (x.key === "timing" ? { ...x, active: false } : x)),
      null,
    );
    await expect(setManualStage(c.id, "lost", { lostReason: "timing" }, s)).rejects.toBeInstanceOf(ContactValidationError);
    // Qualified clears the lost reason
    const q = await setManualStage(c.id, "qualified", { lostReason: "price" }, s);
    expect(q).toMatchObject({ stage: "qualified", lostReason: null });
  });

  it("only Qualified and Lost are manual", async () => {
    const m = await makeUser({ role: "manager" });
    const c = await lead(null);
    for (const stage of ["new", "contacted", "first_purchase", "repeat", "advocate", "dormant"]) {
      await expect(setManualStage(c.id, stage as "qualified", {}, m)).rejects.toThrow(/Only Qualified and Lost/);
    }
  });

  it("support cannot set stages; sales only on their own contacts and the pool", async () => {
    const s1 = await makeUser({ role: "sales" });
    const s2 = await makeUser({ role: "sales" });
    const support = await makeUser({ role: "support" });
    const m = await makeUser({ role: "manager" });
    const c = await lead(s1.id);
    await expect(setManualStage(c.id, "qualified", {}, support)).rejects.toBeInstanceOf(ContactForbiddenError);
    await expect(setManualStage(c.id, "qualified", {}, s2)).rejects.toBeInstanceOf(ContactForbiddenError);
    expect((await setManualStage(c.id, "qualified", {}, m)).stage).toBe("qualified");
    const pool = await lead(null);
    expect((await setManualStage(pool.id, "lost", { lostReason: "wrong_number" }, s2)).stage).toBe("lost");
  });

  it("customers are past Qualified, but can be Lost", async () => {
    const s = await makeUser({ role: "sales" });
    const c = await lead(s.id);
    await db.update(contacts).set({ purchaseCount: 1, stage: "first_purchase" }).where(eq(contacts.id, c.id));
    await expect(setManualStage(c.id, "qualified", {}, s)).rejects.toThrow(/past Qualified/);
    expect((await setManualStage(c.id, "lost", { lostReason: "bought_elsewhere" }, s)).stage).toBe("lost");
  });

  it("setting the same stage again is a no-op", async () => {
    const s = await makeUser({ role: "sales" });
    const c = await lead(s.id);
    await setManualStage(c.id, "lost", { lostReason: "price" }, s);
    await setManualStage(c.id, "lost", { lostReason: "price" }, s);
    const a = await db.select().from(auditLog).where(and(eq(auditLog.rowId, c.id), eq(auditLog.field, "stage")));
    expect(a).toHaveLength(1);
  });

  describe("reopen", () => {
    it("clears Lost back to the automatic stage, for the owner or a manager", async () => {
      const s1 = await makeUser({ role: "sales" });
      const s2 = await makeUser({ role: "sales" });
      const m = await makeUser({ role: "manager" });
      const support = await makeUser({ role: "support" });
      const c = await lead(s1.id);
      await expect(reopenContact(c.id, s1)).rejects.toThrow(/Only a Lost contact/);
      await setManualStage(c.id, "lost", { lostReason: "timing" }, s1);
      await expect(reopenContact(c.id, s2)).rejects.toBeInstanceOf(ContactForbiddenError);
      await expect(reopenContact(c.id, support)).rejects.toBeInstanceOf(ContactForbiddenError);
      const r = await reopenContact(c.id, s1);
      expect(r).toMatchObject({ stage: "new", lostReason: null });
      await setManualStage(c.id, "lost", { lostReason: "timing" }, s1);
      expect((await reopenContact(c.id, m)).stage).toBe("new");
    });

    it("a salesperson cannot reopen a Lost contact in the pool (not theirs)", async () => {
      const s = await makeUser({ role: "sales" });
      const c = await lead(null);
      await setManualStage(c.id, "lost", { lostReason: "price" }, s);
      await expect(reopenContact(c.id, s)).rejects.toBeInstanceOf(ContactForbiddenError);
    });
  });
});

/**
 * Every money change must call recomputeContact for the contact and, when it was referred, for the referrer.
 * recomputeContact is replaced by a spy here so this file does not depend on the metrics module.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { recomputeContact } = vi.hoisted(() => ({ recomputeContact: vi.fn(async (id: string) => void id) }));
vi.mock("@/lib/metrics/recompute", () => ({ recomputeContact }));

import { db } from "@/db";
import { contacts, type NewContact } from "@/db/schema";
import { adjustCredit } from "@/lib/money/credit";
import {
  addPayment,
  cancelPurchase,
  recordInstalmentPayment,
  recordPurchase,
  recordRefund,
  rejectPayment,
  verifyPayment,
} from "@/lib/money/purchases";
import { makeUser, resetDb } from "../support/db";

let phoneN = 0;
async function makeContact(over: Partial<NewContact> = {}) {
  phoneN += 1;
  const [c] = await db
    .insert(contacts)
    .values({ phoneE164: `+9193000${String(phoneN).padStart(5, "0")}`, name: `Contact ${phoneN}`, firstDoor: "referral", ...over })
    .returning();
  return c;
}
const recomputed = () => recomputeContact.mock.calls.map((c) => (c as unknown[])[0]);

describe("money: recompute after every change", () => {
  beforeEach(async () => {
    await resetDb();
    recomputeContact.mockClear();
  });

  it("recomputes the contact and its referrer on record, pay, verify, reject, refund, cancel and credit changes", async () => {
    const manager = await makeUser({ role: "manager" });
    const referrer = await makeContact();
    const c = await makeContact({ referredById: referrer.id });
    const solo = await makeContact();

    const r = await recordPurchase(
      {
        contactId: c.id,
        productName: "AAM",
        family: "applied_ai_mastery",
        amount: 2000,
        currency: "INR",
        mode: "upi_qr",
        source: "manual",
        instalments: [
          { amount: 1000, dueAt: new Date("2026-10-01") },
          { amount: 1000, dueAt: new Date("2026-11-01") },
        ],
        paidNow: { amount: 1000, reference: "RC-1" },
      },
      manager,
    );
    expect(recomputed()).toEqual([c.id, referrer.id]);

    const steps: [string, () => Promise<unknown>][] = [
      ["verify", () => verifyPayment(r.paymentIds[0], manager)],
      ["instalment", () => recordInstalmentPayment(r.paymentIds[1], { mode: "upi_qr", reference: "RC-2" }, manager)],
      ["reject", () => rejectPayment(r.paymentIds[1], manager, "bounced")],
      ["refund", () => recordRefund(r.purchaseId, { amount: 100, reason: "goodwill" }, manager)],
      ["credit", () => adjustCredit(r.purchaseId, manager.id, manager)],
    ];
    for (const [, step] of steps) {
      recomputeContact.mockClear();
      await step();
      expect(recomputed()).toEqual([c.id, referrer.id]);
    }

    recomputeContact.mockClear();
    const p2 = await recordPurchase(
      { contactId: solo.id, productName: "W", family: "workshop", amount: 500, currency: "INR", mode: "cash", source: "manual", paidNow: null },
      manager,
    );
    expect(recomputed()).toEqual([solo.id]);
    recomputeContact.mockClear();
    await addPayment(p2.purchaseId, { amount: 100, mode: "cash", reference: null }, manager);
    expect(recomputed()).toEqual([solo.id]);
    recomputeContact.mockClear();
    await cancelPurchase(p2.purchaseId, manager, "duplicate entry");
    expect(recomputed()).toEqual([solo.id]);
  });

  it("does not recompute when the call is rejected", async () => {
    const sales = await makeUser({ role: "sales" });
    const c = await makeContact();
    await expect(
      recordPurchase({ contactId: c.id, productName: "W", family: "workshop", amount: 0, currency: "INR", mode: "cash", source: "manual" }, sales),
    ).rejects.toThrow();
    expect(recomputeContact).not.toHaveBeenCalled();
  });
});

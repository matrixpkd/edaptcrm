/** Readiness "recent interest" counts an enquiry, a chat or a purchase — not notes or unanswered calls. */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, enquiries } from "@/db/schema";
import { captureEnquiry } from "@/lib/contacts/capture";
import { logInteraction } from "@/lib/contacts/interactions";
import { recomputeContact } from "@/lib/metrics/recompute";
import { makeUser, resetDb } from "../support/db";

const DAY = 24 * 3600 * 1000;

describe("recent interest", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function oldLead() {
    const sales = await makeUser({ role: "sales" });
    const { contact } = await captureEnquiry({
      phone: "98470 11111",
      name: "Old Lead",
      channel: "phone_call",
      firstDoor: "youtube",
      ownerId: sales.id,
      skipAlerts: true,
    });
    // the enquiry happened 200 days ago
    await db.update(enquiries).set({ receivedAt: new Date(Date.now() - 200 * DAY) }).where(eq(enquiries.contactId, contact.id));
    await recomputeContact(contact.id);
    return { sales, contactId: contact.id };
  }

  async function readiness(id: string) {
    const [c] = await db.select({ readiness: contacts.readiness }).from(contacts).where(eq(contacts.id, id));
    return c.readiness!;
  }

  it("a note or an unanswered call does not raise readiness", async () => {
    const { sales, contactId } = await oldLead();
    const before = await readiness(contactId);
    await logInteraction(contactId, { type: "note", summary: "internal note" }, sales);
    await logInteraction(contactId, { type: "call", outcome: "no_answer" }, sales);
    expect(await readiness(contactId)).toBe(before);
  });

  it("a connected call or an inbound WhatsApp counts as a chat this week (+30)", async () => {
    const { sales, contactId } = await oldLead();
    const before = await readiness(contactId);
    await logInteraction(contactId, { type: "call", outcome: "connected" }, sales);
    expect(await readiness(contactId)).toBe(before + 30);
  });
});

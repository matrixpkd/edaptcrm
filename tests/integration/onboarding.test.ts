import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { importBatches, products, webhookEvents } from "@/db/schema";
import { getOnboarding, getOnboardingFacts, onboardingDismissed, setOnboardingDismissed } from "@/lib/admin/onboarding";
import { updateProduct } from "@/lib/admin/products";
import { saveSettingAudited } from "@/lib/admin/settings";
import { createUser, listUsers } from "@/lib/admin/users";
import { getSetting } from "@/lib/settings";
import { makeUser, resetDb } from "../support/db";

describe("getting started checklist facts", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("an empty CRM (one admin, starter products) has everything to do; each step ticks off from the data", async () => {
    const admin = await makeUser({ role: "admin" });
    // the seed inserts the starter products directly, without an audit row
    const [p] = await db.insert(products).values({ name: "AI Workshop", family: "workshop", rung: 1, listPrice: 999, currency: "INR" }).returning();

    let o = await getOnboarding();
    expect(o).toMatchObject({ done: 0, total: 6, complete: false });
    expect(await getOnboardingFacts()).toMatchObject({
      teammates: 0,
      salesByTeam: {},
      leadTeams: ["kerala", "dubai"],
      assignmentSaved: false,
      productsEdited: false,
      webhookSources: [],
      importsCommitted: 0,
      currencySaved: false,
      foreignCurrencies: ["AED", "USD"],
    });

    // add the team: a Kerala and a Dubai salesperson (assignment done too: both lead teams have someone)
    await createUser({ name: "Asha", email: "asha@edapt.in", role: "sales", team: "kerala", timezone: null, phone: null }, admin);
    await createUser({ name: "Fatima", email: "fatima@edapt.in", role: "sales", team: "dubai", timezone: null, phone: null }, admin);
    await createUser({ name: "Sana", email: "sana@edapt.in", role: "support", team: null, timezone: null, phone: null }, admin);
    // deactivated people do not count
    await makeUser({ role: "sales", team: "kerala", active: false });
    expect(await getOnboardingFacts()).toMatchObject({ teammates: 3, salesByTeam: { kerala: 1, dubai: 1 } });

    await updateProduct(p.id, { name: "AI Workshop", family: "workshop", listPrice: 1499, currency: "INR", active: true, externalIds: [], description: null }, admin);
    const currency = await getSetting("currency");
    await saveSettingAudited("currency", { ...currency, rates: { ...currency.rates, AED: { ...currency.rates.AED, "2026-11": 23.1 } } }, admin);
    await db.insert(webhookEvents).values({ source: "tagmango", eventKey: "tagmango:order:1:completed", payload: {} });
    await db.insert(importBatches).values({ fileName: "old.csv", source: "other", uploadedById: admin.id, status: "committed" });

    o = await getOnboarding();
    expect(o.items.filter((i) => !i.done).map((i) => i.key)).toEqual([]);
    expect(o).toMatchObject({ done: 6, complete: true });
  });

  it("an admin can hide the checklist on Today and bring it back", async () => {
    const admin = await makeUser({ role: "admin" });
    expect(await onboardingDismissed(admin.id)).toBe(false);
    await setOnboardingDismissed(admin.id, true);
    expect(await onboardingDismissed(admin.id)).toBe(true);
    await setOnboardingDismissed(admin.id, false);
    expect(await onboardingDismissed(admin.id)).toBe(false);
  });
});

describe("team list", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("lists every member, active first, with contacts owned and open tasks", async () => {
    const admin = await makeUser({ role: "admin", name: "Umer" });
    const { user, tempPassword } = await createUser({ name: "Zed", email: "Zed@Edapt.in", role: "manager", team: "kerala", timezone: null, phone: "98470 12345" }, admin);
    expect(user.email).toBe("zed@edapt.in");
    expect(user.phone).toBe("+919847012345");
    expect(tempPassword).toMatch(/^[\w]{4}-[\w]{4}-[\w]{4}-[\w]{4}$/);
    await makeUser({ role: "sales", name: "Old", active: false });
    const rows = await listUsers();
    expect(rows.map((r) => [r.name, r.active, r.contactCount, r.openTaskCount])).toEqual([
      ["Umer", true, 0, 0],
      ["Zed", true, 0, 0],
      ["Old", false, 0, 0],
    ]);
  });
});

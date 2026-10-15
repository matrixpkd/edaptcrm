import { describe, expect, it } from "vitest";
import { buildChecklist, checklistSummary, type OnboardingFacts } from "@/lib/admin/checklist";
import { inviteMessage, whatsappShareLink } from "@/lib/admin/invite";

const EMPTY: OnboardingFacts = {
  teammates: 0,
  salesByTeam: {},
  leadTeams: ["kerala", "dubai"],
  teamLabels: { kerala: "Kerala", dubai: "Dubai" },
  assignmentSaved: false,
  productsEdited: false,
  webhookSources: [],
  importsCommitted: 0,
  currencySaved: false,
  foreignCurrencies: ["AED", "USD"],
};

const byKey = (f: OnboardingFacts) => Object.fromEntries(buildChecklist(f).map((i) => [i.key, i]));

describe("getting started checklist", () => {
  it("a brand-new CRM (one admin, starter products) has every step to do, in the order an owner sets up", () => {
    const items = buildChecklist(EMPTY);
    expect(items.map((i) => i.key)).toEqual(["team", "prices", "assignment", "integrations", "import", "currency"]);
    expect(items.every((i) => !i.done)).toBe(true);
    expect(items.map((i) => i.href)).toEqual([
      "/team/new",
      "/settings/products",
      "/settings/teams-assignment",
      "/settings/integrations",
      "/import",
      "/settings/currency",
    ]);
    expect(byKey(EMPTY).assignment.detail).toContain("Kerala and Dubai have no salesperson");
    expect(byKey(EMPTY).currency.detail).toContain("AED and USD");
  });

  it("each step ticks itself off from the data", () => {
    const f: OnboardingFacts = {
      ...EMPTY,
      teammates: 3,
      salesByTeam: { kerala: 2, dubai: 1 },
      productsEdited: true,
      webhookSources: ["tagmango", "pabbly_meta", "tagmango"],
      importsCommitted: 1,
      currencySaved: true,
    };
    const k = byKey(f);
    expect(Object.values(k).every((i) => i.done)).toBe(true);
    expect(k.team.detail).toBe("3 teammates, 3 salespeople.");
    expect(k.integrations.detail).toBe("Receiving from TagMango orders, Meta lead forms via Pabbly.");
    expect(k.import.detail).toBe("1 import done.");
  });

  it("teams and assignment: done once saved, or once every team that gets leads has a salesperson", () => {
    expect(byKey({ ...EMPTY, salesByTeam: { kerala: 1 } }).assignment).toMatchObject({ done: false, detail: expect.stringContaining("Dubai has no salesperson") });
    expect(byKey({ ...EMPTY, salesByTeam: { kerala: 1, dubai: 1 } }).assignment.done).toBe(true);
    expect(byKey({ ...EMPTY, assignmentSaved: true }).assignment.done).toBe(true);
  });

  it("the status line keeps product names capitalised", () => {
    const f: OnboardingFacts = { ...EMPTY, teammates: 3, salesByTeam: { kerala: 2, dubai: 1 }, productsEdited: true };
    expect(checklistSummary(buildChecklist(f))).toBe("3 of 6 done. Next: connect TagMango, Libromi and Pabbly.");
    expect(checklistSummary(buildChecklist(EMPTY))).toBe("0 of 6 done. Next: add your team.");
    expect(checklistSummary([{ title: "Add your team", done: true }])).toBe("1 of 1 done. All set.");
  });

  it("currency needs no step when only INR is offered", () => {
    expect(byKey({ ...EMPTY, foreignCurrencies: [] }).currency.done).toBe(true);
  });
});

describe("invite message", () => {
  it("says where to sign in, with which email and temporary password, and to change it", () => {
    const m = inviteMessage({ name: "Asha Nair", email: "asha@edapt.in", password: "Kp7m-Xq2r-Tn9w-Hb4c", loginUrl: "https://crm.edapt.in/login" });
    expect(m).toContain("Hi Asha, your Edapt CRM account is ready.");
    expect(m).toContain("https://crm.edapt.in/login");
    expect(m).toContain("asha@edapt.in");
    expect(m).toContain("Kp7m-Xq2r-Tn9w-Hb4c");
    expect(m).toContain("choose your own password");
    expect(inviteMessage({ name: "Asha", email: "a@b.in", password: "x", loginUrl: "u", reset: true })).toContain("password was reset");
  });

  it("opens WhatsApp to the teammate's number when known", () => {
    expect(whatsappShareLink("hi there", "+919847012345")).toBe("https://wa.me/919847012345?text=hi%20there");
    expect(whatsappShareLink("hi", null)).toBe("https://wa.me/?text=hi");
  });
});

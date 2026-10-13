import { describe, expect, it } from "vitest";
import {
  cheapestInFamily,
  cheapestOnRung,
  matchesCondition,
  nextBestOffer,
  regionOf,
  type NboContext,
  type NboFacts,
  type NboProduct,
} from "@/lib/metrics/nbo";
import { DEFAULT_SETTINGS, type NboCondition, type NboRule } from "@/lib/settings/defaults";

const rules = DEFAULT_SETTINGS["nbo.rules"];
const gcc = DEFAULT_SETTINGS.assignment.gccCountries;

const products: NboProduct[] = [
  { id: "w-claude", name: "Claude Mastery workshop", family: "workshop", rung: 1, listPrice: 999, currency: "INR", active: true },
  { id: "w-teachers", name: "AI for Teachers", family: "workshop", rung: 1, listPrice: 699, currency: "INR", active: true },
  { id: "w-free", name: "Free webinar", family: "workshop", rung: 1, listPrice: 0, currency: "INR", active: true },
  { id: "aam", name: "Applied AI Mastery", family: "applied_ai_mastery", rung: 2, listPrice: 25000, currency: "INR", active: true },
  { id: "aam-dxb", name: "Applied AI Mastery Dubai", family: "applied_ai_mastery", rung: 2, listPrice: 1000, currency: "AED", active: true },
  { id: "aam-old", name: "Applied AI Mastery 2024", family: "applied_ai_mastery", rung: 2, listPrice: 9000, currency: "INR", active: false },
  { id: "office", name: "The AI Office", family: "ai_office", rung: 3, listPrice: 500, currency: "USD", active: true },
  { id: "premium", name: "Premium retreat", family: "premium", rung: 4, listPrice: 300000, currency: "INR", active: false },
  { id: "agents", name: "AI Agents for Business", family: "workshop", rung: 1, listPrice: 4999, currency: "INR", active: true },
  { id: "eur", name: "Euro thing", family: "consulting", rung: 4, listPrice: 100, currency: "EUR", active: true },
];
const RATES: Record<string, number> = { INR: 1, AED: 22.7, USD: 83.4 };
const ctx: NboContext = {
  products,
  toInr: (amount, cur) => (RATES[cur] ? Math.round(amount * RATES[cur] * 100) / 100 : Number.NaN),
  gccCountries: gcc,
};

const lead = (over: Partial<NboFacts> = {}): NboFacts => ({
  purchaseCount: 0,
  families: [],
  currentRung: 0,
  industry: null,
  aiLevel: null,
  fit: 40,
  country: "IN",
  phoneCountry: "IN",
  tags: [],
  firstDoor: "youtube",
  ...over,
});
const workshopBuyer = (over: Partial<NboFacts> = {}) => lead({ purchaseCount: 1, families: ["workshop"], currentRung: 1, ...over });
const nbo = (f: NboFacts, r: NboRule[] = rules) => nextBestOffer(f, r, ctx);

describe("next best offer: the spec table with the default rules", () => {
  it("Free only (YouTube, webinar, MLA program) -> an entry workshop at ₹699", () => {
    for (const door of ["youtube", "workshop_webinar", "mla_program"]) {
      expect(nbo(lead({ firstDoor: door }))).toEqual({ ruleId: "free", offer: "Entry workshop (₹699 to ₹999)", productId: null, priceInr: 699 });
    }
  });

  it("One workshop -> a workshop on a different topic (₹999)", () => {
    expect(nbo(workshopBuyer({ fit: 59 }))).toEqual({ ruleId: "workshop", offer: "A workshop on a different topic", productId: null, priceInr: 999 });
    expect(nbo(workshopBuyer({ fit: null }))?.ruleId).toBe("workshop");
    // two workshops are still workshops only
    expect(nbo(workshopBuyer({ purchaseCount: 2 }))?.ruleId).toBe("workshop");
  });

  it("One workshop and Fit 60 or more -> Applied AI Mastery, priced at the product of that name", () => {
    const o = nbo(workshopBuyer({ fit: 60 }));
    expect(o).toEqual({ ruleId: "workshop_fit", offer: "Applied AI Mastery", productId: "aam", priceInr: 25000 });
    expect(nbo(workshopBuyer({ fit: 95 }))?.ruleId).toBe("workshop_fit");
  });

  it("Business owner with any workshop -> AI Agents for Business", () => {
    const o = nbo(workshopBuyer({ industry: "business_owner", fit: 80 }));
    expect(o).toEqual({ ruleId: "owner", offer: "AI Agents for Business", productId: "agents", priceInr: 4999 });
    expect(nbo(workshopBuyer({ industry: "business_owner", families: ["workshop", "b2b_program"], purchaseCount: 2 }))?.ruleId).toBe("owner");
  });

  it("GCC business owner with a workshop -> AI Agents for Business, then The AI Office", () => {
    expect(nbo(workshopBuyer({ industry: "business_owner", country: "AE", phoneCountry: "AE" }))).toEqual({
      ruleId: "owner_gcc",
      offer: "AI Agents for Business, then The AI Office",
      productId: "agents",
      priceInr: 4999,
    });
    expect(nbo(workshopBuyer({ industry: "business_owner", country: null, phoneCountry: "SA" }))?.ruleId).toBe("owner_gcc");
    expect(nbo(workshopBuyer({ industry: "business_owner", country: "IN", phoneCountry: "AE" }))?.ruleId).toBe("owner");
  });

  it("Applied AI Mastery graduate -> The AI Office or advanced workshops (the cheapest AI Office product)", () => {
    const o = nbo(lead({ purchaseCount: 2, families: ["workshop", "applied_ai_mastery"], currentRung: 2, industry: "business_owner" }));
    expect(o).toEqual({ ruleId: "aam_graduate", offer: "The AI Office or advanced workshops", productId: "office", priceInr: 41700 });
  });

  it("The AI Office member -> renewal and an ask for referrals", () => {
    const o = nbo(lead({ purchaseCount: 3, families: ["workshop", "applied_ai_mastery", "ai_office"], currentRung: 3 }));
    expect(o?.ruleId).toBe("ai_office_member");
    expect(o?.offer).toBe("The AI Office renewal, and ask for referrals");
    // a renewal is priced at The AI Office itself, not at whatever sits on rung 4
    expect(o).toMatchObject({ productId: "office", priceInr: 41700 });
  });

  it("Delegation alumni -> The AI Office and premium programs", () => {
    const o = nbo(lead({ purchaseCount: 1, families: ["delegation"], currentRung: 0, tags: ["Legacy: Delegation"], firstDoor: "delegation" }));
    expect(o?.ruleId).toBe("delegation");
    expect(o?.offer).toBe("The AI Office and premium programs");
    // priced at The AI Office, never at the rung-1 workshop above their "current rung" 0
    expect(o).toMatchObject({ productId: "office", priceInr: 41700 });
    expect(nbo(lead({ tags: ["Legacy: Delegation"], firstDoor: "delegation" }))).toMatchObject({ ruleId: "delegation_tag", productId: "office", priceInr: 41700 });
    // once they joined The AI Office, they are members
    expect(nbo(lead({ purchaseCount: 2, families: ["delegation", "ai_office"], currentRung: 3 }))?.ruleId).toBe("ai_office_member");
  });

  it("AI knowledge level 5 -> a mentor or affiliate invitation, before anything else", () => {
    expect(nbo(lead({ aiLevel: 5 }))).toEqual({ ruleId: "mentor", offer: "Mentor or affiliate invitation", productId: null, priceInr: 0 });
    expect(nbo(workshopBuyer({ aiLevel: 5, industry: "business_owner" }))?.ruleId).toBe("mentor");
    expect(nbo(workshopBuyer({ aiLevel: 4 }))?.ruleId).toBe("workshop");
  });

  it("no rule matches -> null", () => {
    expect(nbo(lead({ purchaseCount: 1, families: ["consulting"], currentRung: 4 }))).toBeNull();
    expect(nbo(lead(), [])).toBeNull();
  });
});

describe("next best offer: rules and pricing", () => {
  const rule = (over: Partial<NboRule>): NboRule => ({ id: "r", label: "r", when: [], offer: "Offer", ...over });

  it("first matching rule wins; inactive rules are skipped; an empty condition list always matches", () => {
    const r = [rule({ id: "off", active: false, price: 1 }), rule({ id: "a", when: [{ type: "no_purchases" }], price: 2 }), rule({ id: "b", price: 3 })];
    expect(nbo(lead(), r)?.ruleId).toBe("a");
    expect(nbo(workshopBuyer(), r)?.ruleId).toBe("b");
  });

  it("rule.price wins (even 0), and keeps the rule's product id", () => {
    expect(nbo(lead(), [rule({ price: 1500, productId: "aam" })])).toMatchObject({ productId: "aam", priceInr: 1500 });
    expect(nbo(lead(), [rule({ price: 0 })])).toMatchObject({ priceInr: 0 });
  });

  it("otherwise the rule's product list price in INR (inactive products still price an explicit offer)", () => {
    expect(nbo(lead(), [rule({ productId: "office" })])).toMatchObject({ productId: "office", priceInr: 41700 });
    expect(nbo(lead(), [rule({ productId: "aam-old", price: null })])).toMatchObject({ productId: "aam-old", priceInr: 9000 });
  });

  it("an unknown product or unpriceable currency falls back to the rung above", () => {
    expect(nbo(lead(), [rule({ productId: "missing" })])).toMatchObject({ productId: "w-teachers", priceInr: 699 });
    expect(nbo(workshopBuyer(), [rule({ productId: "eur" })])).toMatchObject({ productId: "eur", priceInr: 22700 });
  });

  it("then the active product named productName (case-insensitive, the cheapest of several)", () => {
    expect(nbo(lead(), [rule({ productName: "applied ai mastery" })])).toMatchObject({ productId: "aam", priceInr: 25000 });
    // an inactive product of that name does not count
    expect(nbo(lead(), [rule({ productName: "Applied AI Mastery 2024" })])).toMatchObject({ productId: "w-teachers", priceInr: 699 });
    const twins: NboContext = { ...ctx, products: [...products, { ...products[3], id: "aam-cheap", listPrice: 20000 }] };
    expect(nextBestOffer(lead(), [rule({ productName: "Applied AI Mastery" })], twins)).toMatchObject({ productId: "aam-cheap", priceInr: 20000 });
    // productId comes first
    expect(nbo(lead(), [rule({ productId: "office", productName: "Applied AI Mastery" })])).toMatchObject({ productId: "office", priceInr: 41700 });
    // rule.price still wins, and the named product is kept
    expect(nbo(lead(), [rule({ productName: "Applied AI Mastery", price: 100 })])).toMatchObject({ productId: "aam", priceInr: 100 });
  });

  it("then the cheapest active product in the family, then the rung above", () => {
    expect(nbo(lead(), [rule({ family: "applied_ai_mastery" })])).toMatchObject({ productId: "aam-dxb", priceInr: 22700 });
    expect(nbo(lead(), [rule({ productName: "No such thing", family: "ai_office" })])).toMatchObject({ productId: "office", priceInr: 41700 });
    // a family with nothing active and priced falls through to the rung above
    expect(nbo(lead({ currentRung: 1 }), [rule({ family: "premium" })])).toMatchObject({ productId: "aam-dxb", priceInr: 22700 });
    expect(cheapestInFamily("workshop", ctx)?.product.id).toBe("w-teachers");
    expect(cheapestInFamily("premium", ctx)).toBeNull();
  });

  it("otherwise the cheapest active priced product on the rung above; else null", () => {
    expect(nbo(lead({ currentRung: 0 }), [rule({})])).toMatchObject({ productId: "w-teachers", priceInr: 699 });
    expect(nbo(lead({ currentRung: 1 }), [rule({})])).toMatchObject({ productId: "aam-dxb", priceInr: 22700 });
    expect(nbo(lead({ currentRung: 4 }), [rule({})])).toMatchObject({ productId: null, priceInr: null });
    expect(cheapestOnRung(4, ctx)).toBeNull();
    expect(cheapestOnRung(1, ctx)?.product.id).toBe("w-teachers");
  });
});

describe("next best offer: every condition type", () => {
  const m = (c: NboCondition, f: NboFacts) => matchesCondition(c, f, { gccCountries: gcc });

  it("no_purchases", () => {
    expect(m({ type: "no_purchases" }, lead())).toBe(true);
    expect(m({ type: "no_purchases" }, workshopBuyer())).toBe(false);
  });
  it("first_door_in", () => {
    expect(m({ type: "first_door_in", values: ["youtube", "mla_program"] }, lead({ firstDoor: "mla_program" }))).toBe(true);
    expect(m({ type: "first_door_in", values: ["youtube"] }, lead({ firstDoor: "meta_ad" }))).toBe(false);
    expect(m({ type: "first_door_in", values: ["youtube"] }, lead({ firstDoor: null }))).toBe(false);
  });
  it("tag_in (case-insensitive)", () => {
    expect(m({ type: "tag_in", values: ["Legacy: Delegation"] }, lead({ tags: ["VIP", "legacy: delegation"] }))).toBe(true);
    expect(m({ type: "tag_in", values: ["VIP"] }, lead({ tags: [] }))).toBe(false);
  });
  it("industry_in", () => {
    expect(m({ type: "industry_in", values: ["business_owner", "senior_manager"] }, lead({ industry: "senior_manager" }))).toBe(true);
    expect(m({ type: "industry_in", values: ["business_owner"] }, lead({ industry: null }))).toBe(false);
  });
  it("ai_level_gte", () => {
    expect(m({ type: "ai_level_gte", value: 4 }, lead({ aiLevel: 4 }))).toBe(true);
    expect(m({ type: "ai_level_gte", value: 4 }, lead({ aiLevel: 3 }))).toBe(false);
    expect(m({ type: "ai_level_gte", value: 0 }, lead({ aiLevel: null }))).toBe(false);
  });
  it("fit_gte", () => {
    expect(m({ type: "fit_gte", value: 60 }, lead({ fit: 60 }))).toBe(true);
    expect(m({ type: "fit_gte", value: 60 }, lead({ fit: 59 }))).toBe(false);
    expect(m({ type: "fit_gte", value: 0 }, lead({ fit: null }))).toBe(false);
  });
  it("country_in (country, else phone country)", () => {
    expect(m({ type: "country_in", values: ["AE", "QA"] }, lead({ country: "ae" }))).toBe(true);
    expect(m({ type: "country_in", values: ["AE"] }, lead({ country: null, phoneCountry: "AE" }))).toBe(true);
    expect(m({ type: "country_in", values: ["AE"] }, lead({ country: "IN", phoneCountry: "AE" }))).toBe(false);
    expect(m({ type: "country_in", values: ["AE"] }, lead({ country: null, phoneCountry: null }))).toBe(false);
  });
  it("region_is", () => {
    expect(m({ type: "region_is", value: "gcc" }, lead({ country: "OM" }))).toBe(true);
    expect(m({ type: "region_is", value: "india" }, lead({ country: "IN" }))).toBe(true);
    expect(m({ type: "region_is", value: "rest_of_world" }, lead({ country: "US" }))).toBe(true);
    expect(m({ type: "region_is", value: "india" }, lead({ country: null, phoneCountry: null }))).toBe(false);
    expect(regionOf(null, "QA", gcc)).toBe("gcc");
    expect(regionOf(null, null, gcc)).toBeNull();
  });
  it("bought_family / not_bought_family", () => {
    const f = lead({ purchaseCount: 2, families: ["workshop", "delegation"] });
    expect(m({ type: "bought_family", values: ["delegation"] }, f)).toBe(true);
    expect(m({ type: "bought_family", values: ["ai_office"] }, f)).toBe(false);
    expect(m({ type: "not_bought_family", values: ["ai_office"] }, f)).toBe(true);
    expect(m({ type: "not_bought_family", values: ["workshop"] }, f)).toBe(false);
    expect(m({ type: "not_bought_family", values: ["workshop"] }, lead())).toBe(true);
  });
  it("only_families", () => {
    expect(m({ type: "only_families", values: ["workshop"] }, workshopBuyer())).toBe(true);
    expect(m({ type: "only_families", values: ["workshop", "b2b_program"] }, lead({ purchaseCount: 2, families: ["workshop", "b2b_program"] }))).toBe(true);
    expect(m({ type: "only_families", values: ["workshop"] }, lead({ purchaseCount: 2, families: ["workshop", "applied_ai_mastery"] }))).toBe(false);
    expect(m({ type: "only_families", values: ["workshop"] }, lead())).toBe(false);
  });
  it("purchase_count_gte", () => {
    expect(m({ type: "purchase_count_gte", value: 2 }, lead({ purchaseCount: 2 }))).toBe(true);
    expect(m({ type: "purchase_count_gte", value: 2 }, lead({ purchaseCount: 1 }))).toBe(false);
  });
  it("current_rung_gte / current_rung_eq", () => {
    expect(m({ type: "current_rung_gte", value: 2 }, lead({ currentRung: 3 }))).toBe(true);
    expect(m({ type: "current_rung_gte", value: 2 }, lead({ currentRung: 1 }))).toBe(false);
    expect(m({ type: "current_rung_eq", value: 1 }, lead({ currentRung: 1 }))).toBe(true);
    expect(m({ type: "current_rung_eq", value: 1 }, lead({ currentRung: 2 }))).toBe(false);
  });
  it("an unknown condition type never matches", () => {
    expect(m({ type: "made_up" } as unknown as NboCondition, lead())).toBe(false);
  });
});

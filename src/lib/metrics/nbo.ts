/**
 * Next best offer (spec "Repeat purchase and revenue forecast" > "Next best offer"). PURE.
 *
 * Rules come from settings `nbo.rules` and are checked in order: the first active rule whose conditions ALL
 * match wins. The offer's product and price (INR, feeds the 90-day forecast) resolve in this order:
 *   1. rule.price (the product is still named by 2-4 when one of them finds one)
 *   2. the rule's productId product (list price converted to INR)
 *   3. the active product whose name equals rule.productName (case-insensitive)
 *   4. the cheapest active product in rule.family
 *   5. the cheapest active product on the rung above the contact's current rung
 *   else unknown (null). A step whose product cannot be priced (no list price, no rate) passes to the next one.
 */
import type { NboCondition, NboRule } from "@/lib/settings/defaults";
import { normalizeCountry } from "./scoring";

export type NboFacts = {
  /** paid or part-paid purchases */
  purchaseCount: number;
  /** product families bought */
  families: string[];
  /** highest ladder rung bought, 0 = none */
  currentRung: number;
  industry: string | null;
  aiLevel: number | null;
  fit: number | null;
  country: string | null;
  phoneCountry: string | null;
  tags: string[];
  firstDoor: string | null;
};

export type NboProduct = {
  id: string;
  name: string;
  family: string;
  rung: number | null;
  listPrice: number;
  currency: string;
  active: boolean;
};

export type NboContext = {
  products: NboProduct[];
  /** amount in `currency` -> INR; return NaN when the currency has no rate */
  toInr: (amount: number, currency: string) => number;
  /** settings assignment.gccCountries */
  gccCountries: string[];
};

export type NextBestOffer = {
  ruleId: string;
  offer: string;
  productId: string | null;
  priceInr: number | null;
};

/** The product an offer points at: by id, else by exact name, else the cheapest in its family (see the header). */
export type OfferTarget = Pick<NboRule, "productId" | "productName" | "family">;

export type Region = "gcc" | "india" | "rest_of_world";

/** Region from the country (falling back to the phone's country); null when neither is known. */
export function regionOf(country: string | null, phoneCountry: string | null, gccCountries: string[]): Region | null {
  const c = normalizeCountry(country) ?? normalizeCountry(phoneCountry);
  if (!c) return null;
  if (gccCountries.some((g) => normalizeCountry(g) === c)) return "gcc";
  if (c === "IN") return "india";
  return "rest_of_world";
}

const lower = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const inValues = (v: string | null | undefined, values: string[]) => !!lower(v) && values.some((x) => lower(x) === lower(v));

/** True when one condition holds. Unknown condition types never match (a broken rule stays silent). */
export function matchesCondition(c: NboCondition, f: NboFacts, ctx: Pick<NboContext, "gccCountries">): boolean {
  switch (c.type) {
    case "no_purchases":
      return f.purchaseCount === 0;
    case "first_door_in":
      return inValues(f.firstDoor, c.values);
    case "tag_in":
      return f.tags.some((t) => inValues(t, c.values));
    case "industry_in":
      return inValues(f.industry, c.values);
    case "ai_level_gte":
      return f.aiLevel !== null && f.aiLevel >= c.value;
    case "fit_gte":
      return f.fit !== null && f.fit >= c.value;
    case "country_in": {
      const country = normalizeCountry(f.country) ?? normalizeCountry(f.phoneCountry);
      return !!country && c.values.some((v) => normalizeCountry(v) === country);
    }
    case "region_is":
      return regionOf(f.country, f.phoneCountry, ctx.gccCountries) === c.value;
    case "bought_family":
      return f.families.some((fam) => inValues(fam, c.values));
    case "not_bought_family":
      return !f.families.some((fam) => inValues(fam, c.values));
    case "only_families":
      return f.purchaseCount > 0 && f.families.length > 0 && f.families.every((fam) => inValues(fam, c.values));
    case "purchase_count_gte":
      return f.purchaseCount >= c.value;
    case "current_rung_gte":
      return f.currentRung >= c.value;
    case "current_rung_eq":
      return f.currentRung === c.value;
    default:
      return false;
  }
}

/** True when the rule is active and every condition holds (a rule with no conditions always matches). */
export function ruleMatches(rule: NboRule, f: NboFacts, ctx: Pick<NboContext, "gccCountries">): boolean {
  if (rule.active === false) return false;
  return (rule.when ?? []).every((c) => matchesCondition(c, f, ctx));
}

function priceOf(p: NboProduct, ctx: NboContext): number | null {
  const v = ctx.toInr(Number(p.listPrice), p.currency);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Cheapest active, priced product on the given rung (ties: by name). */
export function cheapestOnRung(rung: number, ctx: NboContext): { product: NboProduct; priceInr: number } | null {
  return cheapestWhere((p) => p.rung === rung, ctx);
}

/** Cheapest active, priced product in the given family (ties: by name). */
export function cheapestInFamily(family: string, ctx: NboContext): { product: NboProduct; priceInr: number } | null {
  return cheapestWhere((p) => lower(p.family) === lower(family), ctx);
}

function cheapestWhere(keep: (p: NboProduct) => boolean, ctx: NboContext): { product: NboProduct; priceInr: number } | null {
  let best: { product: NboProduct; priceInr: number } | null = null;
  for (const p of ctx.products) {
    if (!p.active || !keep(p)) continue;
    const price = priceOf(p, ctx);
    if (price === null) continue;
    if (!best || price < best.priceInr || (price === best.priceInr && p.name < best.product.name)) best = { product: p, priceInr: price };
  }
  return best;
}

/**
 * The products a rule names, in resolution order (steps 2-4 of the header), each with its INR price or null when
 * it cannot be priced. An explicit productId is honoured even when the product is inactive.
 */
export function offerCandidates(target: OfferTarget, ctx: NboContext): { product: NboProduct; priceInr: number | null }[] {
  const out: { product: NboProduct; priceInr: number | null }[] = [];
  const byId = target.productId ? ctx.products.find((p) => p.id === target.productId) : undefined;
  if (byId) out.push({ product: byId, priceInr: priceOf(byId, ctx) });
  const name = lower(target.productName);
  if (name) {
    const named = ctx.products.filter((p) => p.active && lower(p.name) === name);
    // several active products with the same name: the cheapest priced one
    const priced = cheapestWhere((p) => named.includes(p), ctx);
    const hit = priced ?? (named[0] ? { product: named[0], priceInr: null } : null);
    if (hit) out.push(hit);
  }
  const family = lower(target.family);
  if (family) {
    const hit = cheapestInFamily(family, ctx);
    if (hit) out.push(hit);
  }
  return out;
}

export function nextBestOffer(facts: NboFacts, rules: NboRule[], ctx: NboContext): NextBestOffer | null {
  const rule = rules.find((r) => ruleMatches(r, facts, ctx));
  if (!rule) return null;
  const out: NextBestOffer = { ruleId: rule.id, offer: rule.offer, productId: null, priceInr: null };

  const candidates = offerCandidates(rule, ctx);
  // the product the rule names is kept even when a later step gives the price
  if (candidates[0]) out.productId = candidates[0].product.id;

  if (rule.price !== null && rule.price !== undefined && Number.isFinite(Number(rule.price)) && Number(rule.price) >= 0) {
    out.priceInr = Number(rule.price);
    return out;
  }
  const priced = candidates.find((c) => c.priceInr !== null);
  if (priced) {
    out.priceInr = priced.priceInr;
    return out;
  }
  const above = cheapestOnRung(facts.currentRung + 1, ctx);
  if (above) {
    out.productId ??= above.product.id;
    out.priceInr = above.priceInr;
  }
  return out;
}

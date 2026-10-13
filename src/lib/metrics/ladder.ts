/**
 * Where a contact stands on the ladder, for the contact page's ladder card. PURE (client-safe).
 *
 * Spec "The big idea": every contact page shows the current rung and the next likely rung, and "the CRM's job is
 * to move them up, and to offer delegation alumni Premium directly". So the next rung agrees with the next best
 * offer: when the offer's product (or family) sits higher than the rung right above, that rung is the next step.
 */
import type { NboRule, ProductFamily, Rung } from "@/lib/settings/defaults";

export type LadderProduct = { id: string; name: string; family: string; rung: number | null; active: boolean };

/**
 * The rung the contact's next best offer points at, or null when it names nothing on the ladder.
 * The rule behind the offer (found by its offer text) decides when it names a product (id or name) or a family,
 * so the card follows the rules in Settings even before the nightly recompute; otherwise the offer's stored product
 * (contacts.next_offer_product_id) does.
 */
export function offerRung(
  offer: { productId: string | null; text: string | null },
  ctx: { products: LadderProduct[]; families: ProductFamily[]; rules: NboRule[] },
): number | null {
  const familyRung = (key: string | null | undefined) => {
    const k = (key ?? "").trim().toLowerCase();
    return k ? (ctx.families.find((f) => f.key.toLowerCase() === k)?.rung ?? null) : null;
  };
  const productRung = (p: LadderProduct | undefined) => (p ? (p.rung ?? familyRung(p.family)) : null);

  const text = offer.text?.trim().toLowerCase();
  const rule = text ? ctx.rules.find((r) => r.active !== false && r.offer.trim().toLowerCase() === text) : undefined;
  if (rule) {
    const byId = rule.productId ? productRung(ctx.products.find((p) => p.id === rule.productId)) : null;
    if (byId !== null) return byId;
    const name = rule.productName?.trim().toLowerCase();
    const byName = name ? productRung(ctx.products.find((p) => p.active && p.name.trim().toLowerCase() === name)) : null;
    if (byName !== null) return byName;
    const byFamily = familyRung(rule.family);
    if (byFamily !== null) return byFamily;
  }
  return offer.productId ? productRung(ctx.products.find((p) => p.id === offer.productId)) : null;
}

export type LadderPosition = {
  current: Rung | null;
  next: Rung | null;
  /** true when the next rung was lifted above the rung right above to match the next best offer */
  nextFromOffer: boolean;
  /** side groups bought (delegation, B2B and constituency programs): shown as "Also bought" */
  alsoBought: ProductFamily[];
};

export function ladderPosition(input: {
  currentRung: number;
  rungs: Rung[];
  families: ProductFamily[];
  /** families bought (contacts.families) */
  bought: string[];
  /** offerRung(...) */
  offerRung: number | null;
}): LadderPosition {
  const ordered = [...input.rungs].sort((a, b) => a.rung - b.rung);
  const current = ordered.find((r) => r.rung === input.currentRung) ?? null;
  const above = ordered.find((r) => r.rung > input.currentRung) ?? null;
  let next = above;
  let nextFromOffer = false;
  if (input.offerRung !== null && above && input.offerRung > above.rung) {
    const target = ordered.find((r) => r.rung >= input.offerRung!) ?? null;
    if (target) {
      next = target;
      nextFromOffer = true;
    }
  }
  const bought = new Set(input.bought.map((b) => b.toLowerCase()));
  const alsoBought = input.families.filter((f) => f.rung == null && bought.has(f.key.toLowerCase()));
  return { current, next, nextFromOffer, alsoBought };
}

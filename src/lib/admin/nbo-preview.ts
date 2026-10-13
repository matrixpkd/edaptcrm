/**
 * The next-best-offer tester on Settings > Next best offer: which rule fires for a contact, computed in the
 * browser with the rules being edited. PURE (uses the same nextBestOffer as the nightly recompute).
 */
import { ruleMatches, nextBestOffer, type NboFacts, type NboProduct, type NextBestOffer } from "@/lib/metrics/nbo";
import { rateFromTable } from "@/lib/money/fx";
import type { CurrencyConfig, NboRule } from "@/lib/settings/defaults";

export type NboPreview = {
  offer: NextBestOffer | null;
  /** index of the winning rule in the list, or -1 */
  winner: number;
  /** for every rule: would it match on its own (switched-off rules never match) */
  matches: boolean[];
};

/** amount in `currency` -> INR at `at`'s month; NaN when the currency has no rate (such products are skipped). */
export function inrAt(currency: CurrencyConfig, at: Date): (amount: number, cur: string) => number {
  return (amount, cur) => {
    try {
      return Math.round(amount * rateFromTable(currency.rates, cur, at) * 100) / 100;
    } catch {
      return Number.NaN;
    }
  };
}

export function previewNbo(
  facts: NboFacts,
  rules: NboRule[],
  ctx: { products: NboProduct[]; currency: CurrencyConfig; gccCountries: string[]; now: Date },
): NboPreview {
  const nctx = { products: ctx.products, toInr: inrAt(ctx.currency, ctx.now), gccCountries: ctx.gccCountries };
  const matches = rules.map((r) => ruleMatches(r, facts, nctx));
  return { offer: nextBestOffer(facts, rules, nctx), winner: matches.indexOf(true), matches };
}

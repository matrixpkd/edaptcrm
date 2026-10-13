import { describe, expect, it } from "vitest";
import { ladderPosition, offerRung, type LadderProduct } from "@/lib/metrics/ladder";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";

const rungs = DEFAULT_SETTINGS["ladder.rungs"];
const families = DEFAULT_SETTINGS["ladder.families"];
const rules = DEFAULT_SETTINGS["nbo.rules"];
const products: LadderProduct[] = [
  { id: "w", name: "Claude Mastery Workshop", family: "workshop", rung: 1, active: true },
  { id: "agents", name: "AI Agents for Business", family: "workshop", rung: 1, active: true },
  { id: "aam", name: "Applied AI Mastery", family: "applied_ai_mastery", rung: 2, active: true },
  { id: "office", name: "The AI Office", family: "ai_office", rung: 3, active: true },
  { id: "norung", name: "Office add-on", family: "ai_office", rung: null, active: true },
];
const ctx = { products, families, rules };

describe("offerRung", () => {
  it("reads the offer's product, falling back to its family's rung", () => {
    expect(offerRung({ productId: "office", text: null }, ctx)).toBe(3);
    expect(offerRung({ productId: "norung", text: null }, ctx)).toBe(3);
  });
  it("the rule behind the offer wins over a stored product from before the rules changed", () => {
    // stored before the delegation rule named The AI Office: the cheapest workshop
    expect(offerRung({ productId: "w", text: "The AI Office and premium programs" }, ctx)).toBe(3);
    // a rule naming nothing: the stored product decides
    expect(offerRung({ productId: "aam", text: "A workshop on a different topic" }, ctx)).toBe(2);
  });
  it("without a product, reads the rule behind the offer text (family, then product name)", () => {
    expect(offerRung({ productId: null, text: "The AI Office and premium programs" }, ctx)).toBe(3);
    expect(offerRung({ productId: null, text: "applied ai mastery" }, ctx)).toBe(2);
    expect(offerRung({ productId: "gone", text: "AI Agents for Business" }, ctx)).toBe(1);
  });
  it("is null when the offer names nothing on the ladder", () => {
    expect(offerRung({ productId: null, text: "Mentor or affiliate invitation" }, ctx)).toBeNull();
    expect(offerRung({ productId: null, text: null }, ctx)).toBeNull();
    expect(offerRung({ productId: null, text: "Something typed by hand" }, ctx)).toBeNull();
  });
});

describe("ladderPosition", () => {
  it("delegation alumni offered The AI Office: the next rung is The AI Office, and the delegation is 'also bought'", () => {
    const p = ladderPosition({ currentRung: 0, rungs, families, bought: ["delegation"], offerRung: 3 });
    expect(p.current).toBeNull();
    expect(p.next?.label).toBe("The AI Office");
    expect(p.nextFromOffer).toBe(true);
    expect(p.alsoBought.map((f) => f.key)).toEqual(["delegation"]);
  });
  it("otherwise the rung right above, even when the offer sits on the current rung or lower", () => {
    expect(ladderPosition({ currentRung: 1, rungs, families, bought: ["workshop"], offerRung: 1 })).toMatchObject({
      current: { rung: 1 },
      next: { rung: 2 },
      nextFromOffer: false,
      alsoBought: [],
    });
    expect(ladderPosition({ currentRung: 1, rungs, families, bought: ["workshop"], offerRung: 2 })).toMatchObject({ next: { rung: 2 }, nextFromOffer: false });
    expect(ladderPosition({ currentRung: 1, rungs, families, bought: ["workshop"], offerRung: null }).next?.rung).toBe(2);
  });
  it("the top rung has no next step; side groups show beside any rung", () => {
    const p = ladderPosition({ currentRung: 4, rungs, families, bought: ["premium", "b2b_program", "constituency_program"], offerRung: 3 });
    expect(p.next).toBeNull();
    expect(p.alsoBought.map((f) => f.key)).toEqual(["b2b_program", "constituency_program"]);
  });
  it("an offer beyond the last rung defined keeps the rung right above", () => {
    expect(ladderPosition({ currentRung: 1, rungs, families, bought: [], offerRung: 9 })).toMatchObject({ next: { rung: 2 }, nextFromOffer: false });
  });
});

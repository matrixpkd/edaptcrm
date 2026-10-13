/**
 * Adversarial review of the metrics module (pure parts): regressions for defects found in review.
 */
import { describe, expect, it } from "vitest";
import { nextBestOffer, type NboContext, type NboFacts } from "@/lib/metrics/nbo";
import { computeAutoStage } from "@/lib/metrics/stage";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";

const rules = DEFAULT_SETTINGS["nbo.rules"];
const ctx: NboContext = {
  products: [
    { id: "w", name: "Workshop", family: "workshop", rung: 1, listPrice: 699, currency: "INR", active: true },
    { id: "office", name: "The AI Office", family: "ai_office", rung: 3, listPrice: 50000, currency: "INR", active: true },
  ],
  toInr: (a, c) => (c === "INR" ? a : Number.NaN),
  gccCountries: DEFAULT_SETTINGS.assignment.gccCountries,
};
const facts = (over: Partial<NboFacts> = {}): NboFacts => ({
  purchaseCount: 0,
  families: [],
  currentRung: 0,
  industry: null,
  aiLevel: null,
  fit: 50,
  country: "IN",
  phoneCountry: "IN",
  tags: [],
  firstDoor: "youtube",
  ...over,
});

describe("review: delegation alumni from the legacy list (tag only, no delegation purchase on file)", () => {
  // Spec "Importing the 50,000 old records": the delegation list (about 400) is imported tagged
  // "Legacy: Delegation"; "they surface first for The AI Office and premium programs".
  it("a contact tagged Legacy: Delegation gets The AI Office and premium programs, not the free-lead workshop", () => {
    const o = nextBestOffer(facts({ tags: ["Legacy: Delegation"], firstDoor: "delegation" }), rules, ctx);
    expect(o?.offer).toBe("The AI Office and premium programs");
  });

  it("the tag rule matches the tag case-insensitively and yields to AI Office membership and the mentor invite", () => {
    expect(nextBestOffer(facts({ tags: ["legacy: delegation"] }), rules, ctx)?.offer).toBe("The AI Office and premium programs");
    expect(
      nextBestOffer(facts({ tags: ["Legacy: Delegation"], purchaseCount: 1, families: ["ai_office"], currentRung: 3 }), rules, ctx)?.ruleId,
    ).toBe("ai_office_member");
    expect(nextBestOffer(facts({ tags: ["Legacy: Delegation"], aiLevel: 5 }), rules, ctx)?.ruleId).toBe("mentor");
  });

  it("an untagged lead still gets the entry workshop", () => {
    expect(nextBestOffer(facts(), rules, ctx)?.ruleId).toBe("free");
  });
});

describe("review: stage boundaries", () => {
  const NOW = new Date("2026-10-13T06:00:00Z");
  it("Lost is pulled back by an enquiry one millisecond after it was set", () => {
    const lostAt = new Date(NOW.getTime() - 1000);
    expect(
      computeAutoStage(
        {
          currentStage: "lost",
          stageChangedAt: lostAt,
          createdAt: lostAt,
          purchaseCount: 0,
          referralCount: 0,
          hasOutboundInteraction: false,
          lastActivityAt: new Date(lostAt.getTime() + 1),
          lastEnquiryOrPaymentAt: new Date(lostAt.getTime() + 1),
        },
        NOW,
        180,
      ),
    ).toBe("new");
  });
});

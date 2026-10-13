import { describe, expect, it } from "vitest";
import { computeAutoStage, type StageFacts } from "@/lib/metrics/stage";

const DAY = 24 * 3600 * 1000;
const NOW = new Date("2026-10-13T06:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const DORMANT = 180;

const facts = (over: Partial<StageFacts> = {}): StageFacts => ({
  currentStage: "new",
  stageChangedAt: ago(10),
  createdAt: ago(10),
  purchaseCount: 0,
  referralCount: 0,
  hasOutboundInteraction: false,
  lastActivityAt: ago(1),
  lastEnquiryOrPaymentAt: ago(1),
  ...over,
});
const stage = (over: Partial<StageFacts> = {}, dormantDays = DORMANT) => computeAutoStage(facts(over), NOW, dormantDays);

describe("auto stage: new and contacted", () => {
  it("a fresh lead with no team interaction is New", () => {
    expect(stage()).toBe("new");
    expect(stage({ lastActivityAt: null, lastEnquiryOrPaymentAt: null, createdAt: ago(0) })).toBe("new");
  });

  it("New -> Contacted once a team member logs an interaction", () => {
    expect(stage({ hasOutboundInteraction: true })).toBe("contacted");
  });

  it("a Contacted contact with no logged interaction left goes back to New", () => {
    expect(stage({ currentStage: "contacted", hasOutboundInteraction: false })).toBe("new");
  });
});

describe("auto stage: qualified is manual", () => {
  it("Qualified stays Qualified for a lead, contacted or not", () => {
    expect(stage({ currentStage: "qualified" })).toBe("qualified");
    expect(stage({ currentStage: "qualified", hasOutboundInteraction: true })).toBe("qualified");
  });

  it("the system never sets Qualified by itself", () => {
    for (const s of ["new", "contacted", "dormant"] as const) expect(stage({ currentStage: s, hasOutboundInteraction: true })).not.toBe("qualified");
  });

  it("a Qualified lead who pays moves to First purchase", () => {
    expect(stage({ currentStage: "qualified", purchaseCount: 1 })).toBe("first_purchase");
  });
});

describe("auto stage: customers", () => {
  it("checkout buyers jump from New straight to First purchase", () => {
    expect(stage({ currentStage: "new", purchaseCount: 1 })).toBe("first_purchase");
    expect(stage({ currentStage: "contacted", purchaseCount: 1, hasOutboundInteraction: true })).toBe("first_purchase");
  });

  it("2 or more purchases -> Repeat", () => {
    expect(stage({ currentStage: "first_purchase", purchaseCount: 2 })).toBe("repeat");
    expect(stage({ currentStage: "new", purchaseCount: 7 })).toBe("repeat");
  });

  it("a customer who brought a paying customer -> Advocate (even with one purchase)", () => {
    expect(stage({ currentStage: "first_purchase", purchaseCount: 1, referralCount: 1 })).toBe("advocate");
    expect(stage({ currentStage: "repeat", purchaseCount: 3, referralCount: 2 })).toBe("advocate");
  });

  it("referrals alone (no purchase of their own) do not make an Advocate", () => {
    expect(stage({ purchaseCount: 0, referralCount: 3 })).toBe("new");
  });

  it("a full refund (no paid purchases left) drops a customer back to the lead stages", () => {
    expect(stage({ currentStage: "first_purchase", purchaseCount: 0, hasOutboundInteraction: true })).toBe("contacted");
    expect(stage({ currentStage: "first_purchase", purchaseCount: 0 })).toBe("new");
  });
});

describe("auto stage: dormant and pull-back", () => {
  it("no activity for more than dormantDays -> Dormant (leads and customers)", () => {
    expect(stage({ lastActivityAt: ago(181) })).toBe("dormant");
    expect(stage({ currentStage: "repeat", purchaseCount: 4, lastActivityAt: ago(400) })).toBe("dormant");
    expect(stage({ currentStage: "advocate", purchaseCount: 2, referralCount: 1, lastActivityAt: ago(200) })).toBe("dormant");
    expect(stage({ currentStage: "qualified", lastActivityAt: ago(181) })).toBe("dormant");
  });

  it("exactly dormantDays is not yet Dormant", () => {
    expect(stage({ lastActivityAt: ago(180) })).toBe("new");
    expect(stage({ lastActivityAt: new Date(ago(180).getTime() - 1000) })).toBe("dormant");
  });

  it("with no activity at all, the creation date counts", () => {
    expect(stage({ lastActivityAt: null, createdAt: ago(181) })).toBe("dormant");
    expect(stage({ lastActivityAt: null, createdAt: ago(179) })).toBe("new");
  });

  it("uses the configured threshold", () => {
    expect(stage({ lastActivityAt: ago(31) }, 30)).toBe("dormant");
    expect(stage({ lastActivityAt: ago(31) }, 60)).toBe("new");
  });

  it("a Dormant contact with fresh activity is pulled back into the right stage", () => {
    expect(stage({ currentStage: "dormant", lastActivityAt: ago(0) })).toBe("new");
    expect(stage({ currentStage: "dormant", lastActivityAt: ago(2), hasOutboundInteraction: true })).toBe("contacted");
    expect(stage({ currentStage: "dormant", lastActivityAt: ago(2), purchaseCount: 1 })).toBe("first_purchase");
    expect(stage({ currentStage: "dormant", lastActivityAt: ago(2), purchaseCount: 3 })).toBe("repeat");
    expect(stage({ currentStage: "dormant", lastActivityAt: ago(2), purchaseCount: 3, referralCount: 1 })).toBe("advocate");
  });

  it("a Dormant contact with no new activity stays Dormant", () => {
    expect(stage({ currentStage: "dormant", lastActivityAt: ago(300), purchaseCount: 2 })).toBe("dormant");
  });
});

describe("auto stage: lost is manual and sticky until a new enquiry or payment", () => {
  it("Lost stays Lost with no enquiry or payment after it was set", () => {
    expect(stage({ currentStage: "lost", stageChangedAt: ago(5), lastEnquiryOrPaymentAt: ago(6), lastActivityAt: ago(1) })).toBe("lost");
    expect(stage({ currentStage: "lost", stageChangedAt: ago(5), lastEnquiryOrPaymentAt: null })).toBe("lost");
    // an interaction after Lost (e.g. a sales call) does not reopen it
    expect(stage({ currentStage: "lost", stageChangedAt: ago(5), lastEnquiryOrPaymentAt: ago(20), lastActivityAt: ago(1), hasOutboundInteraction: true })).toBe("lost");
    // Lost wins over Dormant
    expect(stage({ currentStage: "lost", stageChangedAt: ago(400), lastEnquiryOrPaymentAt: ago(500), lastActivityAt: ago(500) })).toBe("lost");
    // and over a customer stage
    expect(stage({ currentStage: "lost", stageChangedAt: ago(5), lastEnquiryOrPaymentAt: ago(30), purchaseCount: 2 })).toBe("lost");
  });

  it("an enquiry or payment at the same moment as Lost does not reopen it", () => {
    expect(stage({ currentStage: "lost", stageChangedAt: ago(5), lastEnquiryOrPaymentAt: ago(5) })).toBe("lost");
  });

  it("a new enquiry pulls a Lost lead back to New or Contacted", () => {
    expect(stage({ currentStage: "lost", stageChangedAt: ago(5), lastEnquiryOrPaymentAt: ago(1), lastActivityAt: ago(1) })).toBe("new");
    expect(
      stage({ currentStage: "lost", stageChangedAt: ago(5), lastEnquiryOrPaymentAt: ago(1), lastActivityAt: ago(1), hasOutboundInteraction: true }),
    ).toBe("contacted");
  });

  it("a new payment pulls a Lost contact back to the right customer stage", () => {
    expect(stage({ currentStage: "lost", stageChangedAt: ago(5), lastEnquiryOrPaymentAt: ago(1), purchaseCount: 1 })).toBe("first_purchase");
    expect(stage({ currentStage: "lost", stageChangedAt: ago(5), lastEnquiryOrPaymentAt: ago(1), purchaseCount: 2 })).toBe("repeat");
    expect(stage({ currentStage: "lost", stageChangedAt: ago(5), lastEnquiryOrPaymentAt: ago(1), purchaseCount: 2, referralCount: 1 })).toBe("advocate");
  });
});

import { describe, expect, it } from "vitest";
import {
  bandOf,
  buildQueue,
  contextFor,
  rankScore,
  revenueRankScore,
  type QueueContact,
  type QueueTask,
} from "@/lib/today/rank";

// 13 Oct 2026, 15:00 in India
const NOW = new Date("2026-10-13T09:30:00Z");
const TZ = "Asia/Kolkata";
const H = 3600_000;
const D = 24 * H;

let n = 0;
function contact(over: Partial<QueueContact> = {}): QueueContact {
  n += 1;
  return {
    id: `c${String(n).padStart(3, "0")}`,
    name: `Contact ${n}`,
    phoneE164: `+91984700${String(n).padStart(4, "0")}`,
    phoneCountry: "IN",
    ownerId: "u1",
    grade: "C",
    edaptScore: 50,
    stage: "new",
    nextOffer: null,
    purchaseCount: 0,
    expected90dInr: null,
    nextExpectedAt: null,
    lastEnquiryAt: null,
    ...over,
  };
}
function task(over: Partial<QueueTask> = {}): QueueTask {
  n += 1;
  return {
    id: `t${String(n).padStart(3, "0")}`,
    type: "new_lead",
    reason: "New lead assigned to you",
    dueAt: new Date(NOW.getTime() - H),
    priority: 0,
    createdAt: new Date(NOW.getTime() - 2 * H),
    userId: "u1",
    contact: contact(),
    ...over,
  };
}
const build = (tasks: QueueTask[], cap = 40) => buildQueue(tasks, { now: NOW, timeZone: TZ, cap });

describe("revenueRankScore", () => {
  it("maps expected revenue onto the Edapt Score scale with a log curve", () => {
    expect(revenueRankScore(0)).toBe(0);
    expect(Math.round(revenueRankScore(100))).toBe(40);
    expect(Math.round(revenueRankScore(1_000))).toBe(60);
    expect(Math.round(revenueRankScore(5_600))).toBe(75);
    expect(Math.round(revenueRankScore(10_000))).toBe(80);
    expect(revenueRankScore(100_000)).toBe(100);
    expect(revenueRankScore(10_000_000)).toBe(100);
    expect(revenueRankScore(-50)).toBe(0);
  });

  it("customers rank by expected revenue, leads by Edapt Score, customers without a forecast by their score", () => {
    expect(rankScore(contact({ purchaseCount: 2, expected90dInr: 20_000, edaptScore: 10 }))).toBeCloseTo(86, 0);
    expect(rankScore(contact({ purchaseCount: 0, expected90dInr: null, edaptScore: 72 }))).toBe(72);
    expect(rankScore(contact({ purchaseCount: 1, expected90dInr: null, edaptScore: 64 }))).toBe(64);
    expect(rankScore(contact({ purchaseCount: 0, edaptScore: null }))).toBe(0);
    expect(rankScore(null)).toBe(0);
  });
});

describe("bandOf", () => {
  const dayStart = new Date("2026-10-12T18:30:00Z"); // 00:00 13 Oct IST
  it("puts abandoned checkouts first and follow-ups due before today second", () => {
    expect(bandOf({ type: "abandoned_checkout", dueAt: NOW }, dayStart)).toBe("abandoned");
    expect(bandOf({ type: "follow_up", dueAt: new Date(dayStart.getTime() - 1) }, dayStart)).toBe("overdue");
    expect(bandOf({ type: "follow_up", dueAt: dayStart }, dayStart)).toBe("next");
    // only follow-ups are "overdue follow-ups"; an old alert ranks with the rest
    expect(bandOf({ type: "at_risk", dueAt: new Date(dayStart.getTime() - 5 * D) }, dayStart)).toBe("next");
  });
});

describe("buildQueue", () => {
  it("ranks: abandoned checkouts, overdue follow-ups, then one combined score", () => {
    const abandoned = task({ type: "abandoned_checkout", reason: "Started checkout", contact: contact({ edaptScore: 20, name: "Abandoned" }) });
    const overdue = task({
      type: "follow_up",
      reason: "Follow-up you set after a call",
      dueAt: new Date(NOW.getTime() - D),
      contact: contact({ edaptScore: 30, name: "Overdue" }),
    });
    const leadA = task({ contact: contact({ edaptScore: 90, grade: "A", name: "Lead 90" }) });
    const custBig = task({ type: "at_risk", contact: contact({ purchaseCount: 2, expected90dInr: 20_000, name: "Customer 20K" }) });
    const custSmall = task({ type: "next_rung", contact: contact({ purchaseCount: 1, expected90dInr: 500, name: "Customer 500" }) });
    const leadB = task({
      type: "follow_up",
      dueAt: new Date("2026-10-13T02:30:00Z"), // 08:00 today, not overdue
      contact: contact({ edaptScore: 40, name: "Lead 40" }),
    });
    const q = build([leadB, custSmall, leadA, overdue, custBig, abandoned]);
    expect(q.rows.map((r) => r.contact?.name)).toEqual([
      "Abandoned",
      "Overdue",
      "Lead 90",
      "Customer 20K",
      "Customer 500",
      "Lead 40",
    ]);
    expect(q.rows.map((r) => r.band)).toEqual(["abandoned", "overdue", "next", "next", "next", "next"]);
    expect(q.counts).toMatchObject({ abandoned: 1, overdue: 1, customers: 2, leads: 2, total: 6 });
  });

  it("an abandoned checkout outranks an overdue follow-up even on a far better contact", () => {
    const q = build([
      task({ type: "follow_up", dueAt: new Date(NOW.getTime() - 3 * D), contact: contact({ edaptScore: 99 }) }),
      task({ type: "abandoned_checkout", contact: contact({ edaptScore: 5 }) }),
    ]);
    expect(q.rows[0].band).toBe("abandoned");
  });

  it("ties go to higher priority, then the earlier due date", () => {
    const later = task({ dueAt: new Date(NOW.getTime() - H), contact: contact({ edaptScore: 60 }) });
    const earlier = task({ dueAt: new Date(NOW.getTime() - 3 * H), contact: contact({ edaptScore: 60 }) });
    const urgent = task({ dueAt: new Date(NOW.getTime() - 0.5 * H), priority: 5, contact: contact({ edaptScore: 60 }) });
    const q = build([later, earlier, urgent]);
    expect(q.rows.map((r) => r.primary.id)).toEqual([urgent.id, earlier.id, later.id]);
  });

  it("skips tasks due after the end of the user's local today, keeps those due later today", () => {
    const tonight = task({ dueAt: new Date("2026-10-13T18:00:00Z") }); // 23:30 IST
    const tomorrow = task({ dueAt: new Date("2026-10-13T18:31:00Z") }); // 00:01 IST on the 14th
    const q = build([tonight, tomorrow]);
    expect(q.rows.map((r) => r.primary.id)).toEqual([tonight.id]);
  });

  it("caps the list and counts what was left out (counts cover everything)", () => {
    const tasks = Array.from({ length: 7 }, (_, i) => task({ contact: contact({ edaptScore: 10 * i }) }));
    const q = build(tasks, 3);
    expect(q.rows).toHaveLength(3);
    expect(q.total).toBe(7);
    expect(q.leftOut).toBe(4);
    expect(q.cap).toBe(3);
    expect(q.counts.leads).toBe(7);
    expect(q.rows.map((r) => r.contact?.edaptScore)).toEqual([60, 50, 40]);
  });

  it("folds several tasks on one contact into one row ranked by its best task", () => {
    const c = contact({ purchaseCount: 1, expected90dInr: 3_000 });
    const atRisk = task({ type: "at_risk", reason: "At risk: 35 days past expected purchase", contact: c });
    const follow = task({
      type: "follow_up",
      reason: "Follow-up you set after a call",
      dueAt: new Date(NOW.getTime() - 2 * D),
      contact: c,
    });
    const other = task({ contact: contact({ edaptScore: 99 }) });
    const q = build([atRisk, other, follow]);
    expect(q.rows).toHaveLength(2);
    const row = q.rows[0];
    expect(row.band).toBe("overdue");
    expect(row.taskIds).toEqual([follow.id, atRisk.id]);
    expect(row.reason).toBe("Follow-up you set after a call");
    expect(row.alsoReasons).toEqual(["At risk: 35 days past expected purchase"]);
    expect(row.canDismiss).toBe(false);
    expect(row.types).toEqual(["follow_up", "at_risk"]);
  });

  it("keeps transfer requests on their own row and never dismissible", () => {
    const c = contact();
    const q = build([
      task({ type: "transfer_request", reason: "Asha asks for this contact", contact: c }),
      task({ type: "lead_released", reason: "Back in the pool", contact: c }),
    ]);
    expect(q.rows).toHaveLength(2);
    const transfer = q.rows.find((r) => r.transferTaskId);
    expect(transfer?.canDismiss).toBe(false);
    expect(q.rows.find((r) => !r.transferTaskId)?.canDismiss).toBe(true);
  });

  it("in team view, groups by contact and assignee and marks pool rows", () => {
    const c = contact({ ownerId: null });
    const q = buildQueue(
      [task({ userId: null, contact: c }), task({ userId: "u2", contact: c })],
      { now: NOW, timeZone: TZ, cap: 40, groupBy: "assignee" },
    );
    expect(q.rows).toHaveLength(2);
    expect(q.rows.filter((r) => r.pool)).toHaveLength(1);
  });
});

describe("contextFor (why it is here)", () => {
  it("leads: grade and when they enquired; overdue days", () => {
    const c = contact({ grade: "A", lastEnquiryAt: new Date(NOW.getTime() - 2 * H) });
    expect(contextFor({ type: "new_lead", dueAt: new Date(NOW.getTime() - H) }, c, NOW, TZ)).toEqual([
      "Grade A lead",
      "enquired 2h ago",
    ]);
    expect(contextFor({ type: "follow_up", dueAt: new Date(NOW.getTime() - 2 * D) }, c, NOW, TZ)).toEqual([
      "Grade A lead",
      "enquired 2h ago",
      "Overdue 2 days",
    ]);
  });

  it("customers: grade and the expected purchase date", () => {
    const c = contact({ grade: "B", purchaseCount: 2, nextExpectedAt: new Date("2026-10-20T06:00:00Z") });
    expect(contextFor({ type: "next_rung", dueAt: NOW }, c, NOW, TZ)).toEqual([
      "Grade B customer",
      "Expected to buy around 20 Oct",
    ]);
    const late = contact({ grade: null, purchaseCount: 1, nextExpectedAt: new Date("2026-09-01T06:00:00Z") });
    expect(contextFor({ type: "at_risk", dueAt: NOW }, late, NOW, TZ)).toEqual([
      "Customer",
      "Was expected to buy around 1 Sept",
    ]);
  });

  it("a task due later today says when", () => {
    const c = contact({ grade: null });
    expect(contextFor({ type: "follow_up", dueAt: new Date("2026-10-13T11:30:00Z") }, c, NOW, TZ)).toEqual([
      "Lead, not scored yet",
      "Due 5:00 pm",
    ]);
  });

  it("every row carries the task reason and context", () => {
    const q = build([
      task({ type: "abandoned_checkout", reason: "Started paying for Applied AI Mastery, no completed order" }),
      task({ type: "new_advocate", reason: "Their referral Ravi just paid — call to thank" }),
    ]);
    for (const r of q.rows) {
      expect(r.reason.length).toBeGreaterThan(0);
      expect(r.context.length).toBeGreaterThan(0);
    }
  });
});

describe("derived (synthetic) new-lead rows", () => {
  it("rank like any lead but carry no task ids, no Dismiss and no overdue line", () => {
    const lead = task({
      id: "lead:x",
      synthetic: true,
      type: "new_lead",
      dueAt: new Date(NOW.getTime() - 20 * H), // assigned yesterday evening
      contact: contact({ edaptScore: 70, grade: "B" }),
    });
    const q = build([lead, task({ contact: contact({ edaptScore: 40 }) })]);
    expect(q.rows[0].taskIds).toEqual([]);
    expect(q.rows[0].canDismiss).toBe(false);
    expect(q.rows[0].context).toEqual(["Grade B lead"]);
    expect(q.rows[1].taskIds).toHaveLength(1);
  });

  it("fold into a stored task on the same contact, which keeps the actions", () => {
    const c = contact();
    const stored = task({ type: "at_risk", contact: c });
    const lead = task({ id: "lead:y", synthetic: true, contact: c, reason: "New lead: no call or message logged since it was assigned" });
    const q = build([lead, stored]);
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0].taskIds).toEqual([stored.id]);
    expect(q.rows[0].canDismiss).toBe(true);
  });
});

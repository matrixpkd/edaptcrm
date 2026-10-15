/**
 * The pipeline board's move rules (beyond the spec; docs/CRM_GAP_ANALYSIS.md). PURE: safe in client components and
 * unit tested in tests/unit/pipeline-rules.test.ts.
 *
 * Spec "Lifecycle stages": the system moves contacts through six of the eight stages by itself; people set only
 * Qualified and Lost (Lost with a reason), and a Lost contact can be reopened (its automatic stage comes back). So
 * on the board a card can be dropped only:
 *   - on Qualified (a lead, not yet a customer, not already Qualified);
 *   - on Lost (asks for the reason);
 *   - a Lost card on any other column: Reopen (the system then puts it in its right stage, which may differ from the
 *     column it was dropped on).
 */
import { STAGES, type Stage } from "@/db/schema";

export const BOARD_STAGES: Stage[] = [...STAGES];

export const STAGE_TITLES: Record<Stage, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  first_purchase: "First purchase",
  repeat: "Repeat",
  advocate: "Advocate",
  dormant: "Dormant",
  lost: "Lost",
};

/** One line under each column title: how a contact gets there. */
export const STAGE_HINTS: Record<Stage, string> = {
  new: "Automatic: a new enquiry",
  contacted: "Automatic: a call or message logged",
  qualified: "Set by hand: drop a lead here",
  first_purchase: "Automatic: the first verified payment",
  repeat: "Automatic: a second purchase",
  advocate: "Automatic: someone they referred paid",
  dormant: "Automatic: no activity for a long time",
  lost: "Set by hand, with a reason: drop here",
};

export type MoveIntent =
  | { kind: "qualify" }
  | { kind: "lose" }
  | { kind: "reopen" }
  | { kind: "none"; reason: string };

/**
 * What dropping a card from `from` onto `to` means. `purchaseCount` > 0 is a customer (already past Qualified).
 */
export function moveIntent(from: Stage, to: Stage, purchaseCount: number): MoveIntent {
  if (from === to) return { kind: "none", reason: "It is already there" };
  if (to === "lost") return { kind: "lose" };
  if (from === "lost") return { kind: "reopen" };
  if (to === "qualified") {
    if (purchaseCount > 0) return { kind: "none", reason: "Customers are already past Qualified" };
    return { kind: "qualify" };
  }
  return { kind: "none", reason: `${STAGE_TITLES[to]} is set by the system, not by hand` };
}

/** The columns a card may be moved to (for the "Move" menu on phones). */
export function allowedTargets(from: Stage, purchaseCount: number): { stage: Stage; label: string }[] {
  return BOARD_STAGES.filter((to) => moveIntent(from, to, purchaseCount).kind !== "none").map((to) => {
    const intent = moveIntent(from, to, purchaseCount);
    return { stage: to, label: intent.kind === "reopen" ? "Reopen (the system picks the stage)" : STAGE_TITLES[to] };
  }).filter((t, i, all) => (from === "lost" ? all.findIndex((x) => x.label === t.label) === i : true));
}

import "server-only";
import { db, type Tx } from "@/db";

/**
 * Recalculates every calculated column on one contact: money facts (LTV, purchase count, families, rung,
 * first/last purchase), activity markers, stage (auto stages), Fit/Readiness/Value, Edapt Score and grade,
 * repeat metrics, next best offer, expected 90-day revenue, network value.
 *
 * Call it after ANY change that can affect those values. Safe to call repeatedly.
 *
 * STUB: implemented by the metrics module (src/lib/metrics). Signature is fixed.
 */
export async function recomputeContact(
  contactId: string,
  tx: Tx = db,
  opts: { now?: Date } = {},
): Promise<void> {
  void contactId;
  void tx;
  void opts;
}

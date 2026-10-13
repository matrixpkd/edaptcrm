import "server-only";
import { and, asc, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { audit } from "@/lib/audit";
import { loadMetricsContext, recomputeContacts } from "@/lib/metrics/recompute";
import { buildCohorts } from "@/lib/metrics/repeat";
import { isUuid } from "@/lib/utils";
import { assertAdmin, type AdminActor } from "./settings";

/**
 * "Recalculate all scores now" (Settings > Scoring, Products, Next best offer), in chunks so each server action
 * call stays short: the browser calls recalcChunk(null) first, then recalcChunk(next) until next is null.
 * The first call rebuilds the cohort table and logs the run. Each chunk recomputes the next `batchSize`
 * contacts in id order through recomputeContacts (the one writer of calculated columns).
 * The nightly job (recomputeAll) does the same for everyone anyway.
 */
export async function recalcChunk(
  cursor: string | null,
  actor: AdminActor,
  opts: { batchSize?: number; now?: Date } = {},
): Promise<{ written: number; processed: number; total: number; next: string | null }> {
  assertAdmin(actor, "Only an admin can recalculate every score");
  const now = opts.now ?? new Date();
  const batchSize = Math.max(1, Math.min(Math.floor(opts.batchSize ?? 400), 2000));
  const after = cursor && isUuid(cursor) ? cursor : null;
  if (!after) {
    await buildCohorts(db, now);
    await audit({ table: "contacts", action: "recompute", field: "all", newValue: { startedAt: now.toISOString() }, userId: actor.id });
  }
  const live = isNull(contacts.mergedIntoId);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(contacts).where(live);
  const page = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(after ? and(live, gt(contacts.id, after)) : live)
    .orderBy(asc(contacts.id))
    .limit(batchSize);
  if (!page.length) return { written: 0, processed: 0, total: Number(total), next: null };
  const ctx = await loadMetricsContext(db, now);
  const written = await recomputeContacts(
    page.map((p) => p.id),
    db,
    { now, ctx },
  );
  return {
    written,
    processed: page.length,
    total: Number(total),
    next: page.length < batchSize ? null : page[page.length - 1].id,
  };
}

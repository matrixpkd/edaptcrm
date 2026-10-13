import "server-only";
import { sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { DAY_MS } from "@/lib/utils";

/** How long processed webhook deliveries are kept (failed and skipped ones are kept until someone looks). */
export const WEBHOOK_EVENT_RETENTION_DAYS = 180;

/**
 * Nightly: deletes webhook_events older than `days` that were processed without an error. Failed events (and
 * skipped ones, whose note is stored in `error`) stay for Settings > Integrations, as do events still in flight.
 * Duplicate deliveries after that stay harmless: enquiries.source_ref, purchases.reference, payments.reference and
 * interactions.external_ref still dedupe. Deletes in batches so one run never holds a long lock.
 */
export async function pruneWebhookEvents(
  now: Date,
  tx: Tx = db,
  opts: { days?: number; batchSize?: number; maxBatches?: number } = {},
): Promise<{ deleted: number; before: string }> {
  const days = Math.max(1, Math.floor(opts.days ?? WEBHOOK_EVENT_RETENTION_DAYS));
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? 5000));
  const maxBatches = Math.max(1, Math.floor(opts.maxBatches ?? 200));
  const before = new Date(now.getTime() - days * DAY_MS).toISOString();
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const rows = await tx.execute<{ id: string }>(sql`
      delete from webhook_events
      where id in (
        select id from webhook_events
        where received_at < ${before}::timestamptz and processed_at is not null and error is null
        limit ${batchSize}
      )
      returning id
    `);
    deleted += rows.length;
    if (rows.length < batchSize) break;
  }
  return { deleted, before };
}

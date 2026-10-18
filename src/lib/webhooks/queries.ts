import "server-only";
/** Reads for Settings > Integrations: the webhook event log and per-source health. */
import { and, desc, eq, isNotNull, isNull, like, not, sql, type SQL } from "drizzle-orm";
import { db, queryRows, type Tx } from "@/db";
import { contacts, webhookEvents } from "@/db/schema";
import { isUuid } from "@/lib/utils";
import { SKIP_PREFIX, WEBHOOK_SOURCES, type WebhookSource } from "./sources";

export type WebhookEventFilter = "all" | "failed" | "skipped" | "processed";

export type WebhookEventListRow = {
  id: string;
  source: string;
  eventKey: string;
  receivedAt: Date;
  processedAt: Date | null;
  error: string | null;
  contactId: string | null;
  contactName: string | null;
};

function filterWhere(filter: WebhookEventFilter): SQL | undefined {
  const skipped = like(webhookEvents.error, `${SKIP_PREFIX}%`);
  switch (filter) {
    case "failed":
      return and(isNotNull(webhookEvents.error), not(skipped));
    case "skipped":
      return skipped;
    case "processed":
      return and(isNotNull(webhookEvents.processedAt), isNull(webhookEvents.error));
    default:
      return undefined;
  }
}

/** The latest events (newest first), without their payloads. */
export async function listWebhookEvents(
  opts: { filter?: WebhookEventFilter; source?: WebhookSource | null; limit?: number } = {},
  tx: Tx = db,
): Promise<WebhookEventListRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return tx
    .select({
      id: webhookEvents.id,
      source: webhookEvents.source,
      eventKey: webhookEvents.eventKey,
      receivedAt: webhookEvents.receivedAt,
      processedAt: webhookEvents.processedAt,
      error: webhookEvents.error,
      contactId: webhookEvents.contactId,
      contactName: contacts.name,
    })
    .from(webhookEvents)
    .leftJoin(contacts, eq(contacts.id, webhookEvents.contactId))
    .where(and(filterWhere(opts.filter ?? "all"), opts.source ? eq(webhookEvents.source, opts.source) : undefined))
    .orderBy(desc(webhookEvents.receivedAt), desc(webhookEvents.id))
    .limit(limit);
}

export type WebhookEventDetail = typeof webhookEvents.$inferSelect & { contactName: string | null };

export async function getWebhookEvent(id: string, tx: Tx = db): Promise<WebhookEventDetail | null> {
  if (!isUuid(id)) return null;
  const [row] = await tx
    .select({ event: webhookEvents, contactName: contacts.name })
    .from(webhookEvents)
    .leftJoin(contacts, eq(contacts.id, webhookEvents.contactId))
    .where(eq(webhookEvents.id, id))
    .limit(1);
  return row ? { ...row.event, contactName: row.contactName } : null;
}

export type SourceHealth = { source: string; lastReceivedAt: Date | null; received7d: number; failed7d: number };

/**
 * Per source: the last delivery, and deliveries / failures in the last 7 days. One statement; every subquery is
 * a range on webhook_events_source_idx (source, received_at).
 */
export async function webhookSourceHealth(now: Date = new Date(), tx: Tx = db): Promise<Map<string, SourceHealth>> {
  const since = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  const list = sql.join(
    WEBHOOK_SOURCES.map((s) => sql`${s}`),
    sql`, `,
  );
  const rows = await queryRows<{ source: string; last: string | Date | null; received: number; failed: number }>(sql`
    select s.source,
      (select max(w.received_at) from webhook_events w where w.source = s.source) as last,
      (select count(*)::int from webhook_events w where w.source = s.source and w.received_at > ${since}::timestamptz) as received,
      (select count(*)::int from webhook_events w
        where w.source = s.source and w.received_at > ${since}::timestamptz
          and w.error is not null and w.error not like ${`${SKIP_PREFIX}%`}) as failed
    from unnest(array[${list}]::text[]) as s(source)
  `, tx);
  const out = new Map<string, SourceHealth>();
  for (const r of rows) {
    out.set(r.source, {
      source: r.source,
      lastReceivedAt: r.last ? new Date(r.last) : null,
      received7d: Number(r.received) || 0,
      failed7d: Number(r.failed) || 0,
    });
  }
  return out;
}

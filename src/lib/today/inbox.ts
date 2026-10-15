import "server-only";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { contacts, notifications } from "@/db/schema";
import { isUuid } from "@/lib/utils";

/**
 * The bell inbox (in-app alerts). Each user only ever sees and changes their own notifications.
 * Unread first, newest first; paginated.
 */

export const INBOX_PAGE_SIZE = 25;

export type InboxItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  contactId: string | null;
  contactName: string | null;
  taskId: string | null;
  readAt: Date | null;
  createdAt: Date;
};

export type InboxPage = {
  items: InboxItem[];
  page: number;
  pageSize: number;
  pages: number;
  total: number;
  unread: number;
};

/** One page of a user's notifications: unread first, then newest first. Pages are 1-based. */
export async function listNotifications(
  userId: string,
  opts: { page?: number; pageSize?: number } = {},
  tx: Tx = db,
): Promise<InboxPage> {
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? INBOX_PAGE_SIZE)));
  const [totals] = await tx
    .select({
      total: count(),
      unread: sql<number>`count(*) filter (where ${notifications.readAt} is null)`.mapWith(Number),
    })
    .from(notifications)
    .where(eq(notifications.userId, userId));
  const total = totals?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(opts.page ?? 1) || 1));
  const items = await tx
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      contactId: notifications.contactId,
      contactName: contacts.name,
      taskId: notifications.taskId,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .leftJoin(contacts, eq(contacts.id, notifications.contactId))
    .where(eq(notifications.userId, userId))
    // the (user_id, read_at, created_at) index serves this order: nulls (unread) first
    .orderBy(sql`${notifications.readAt} is not null`, desc(notifications.createdAt), desc(notifications.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { items, page, pageSize, pages, total, unread: totals?.unread ?? 0 };
}

/** Marks some of the user's notifications read (others' ids are ignored). Returns how many changed. */
export async function markNotificationsRead(userId: string, ids: string[], tx: Tx = db): Promise<number> {
  const valid = [...new Set(ids)].filter(isUuid);
  if (!valid.length) return 0;
  const rows = await tx
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), inArray(notifications.id, valid), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}

/** Marks every unread notification of the user read. */
export async function markAllNotificationsRead(userId: string, tx: Tx = db): Promise<number> {
  const rows = await tx
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}

/** One of the user's notifications (with its contact's owner, to check visibility), or null. */
export async function getNotification(userId: string, id: string, tx: Tx = db) {
  if (!isUuid(id)) return null;
  const rows = await tx
    .select({
      id: notifications.id,
      type: notifications.type,
      contactId: notifications.contactId,
      taskId: notifications.taskId,
      readAt: notifications.readAt,
      contactOwnerId: contacts.ownerId,
      contactMerged: sql<boolean>`${contacts.mergedIntoId} is not null`,
      // money alerts carry their payment in the dedupe key ("unverified_payment:<payment id>",
      // "instalment_due:<payment id>[:...]", "instalment_overdue:<payment id>"): the purchase it belongs to
      purchaseId: sql<string | null>`(
        select p.purchase_id::text from payments p
        where ${notifications.type} in (${sql.join(
          MONEY_ALERT_TYPES.map((t) => sql`${t}`),
          sql`, `,
        )})
          and split_part(${notifications.dedupeKey}, ':', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          and p.id = split_part(${notifications.dedupeKey}, ':', 2)::uuid
      )`,
    })
    .from(notifications)
    .leftJoin(contacts, eq(contacts.id, notifications.contactId))
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Alerts about one payment: they open its purchase, where it is verified or recorded. */
export const MONEY_ALERT_TYPES = ["unverified_payment", "instalment_due"] as const;

/**
 * Where a notification leads: a money alert to its purchase (Verify / Record payment are there), else its contact,
 * else Today for task alerts, else the contacts list for "contacts assigned to you", else the inbox itself.
 */
export function notificationHref(n: {
  contactId: string | null;
  taskId: string | null;
  type: string;
  purchaseId?: string | null;
}): string {
  if (n.purchaseId && (MONEY_ALERT_TYPES as readonly string[]).includes(n.type)) return `/payments/${n.purchaseId}`;
  // a task someone gave you (src/lib/tasks/service.ts): your task list shows it with who it is from
  if (n.type === "task_assigned") return "/tasks";
  if (n.contactId) return `/contacts/${n.contactId}`;
  if (n.taskId) return "/today";
  if (n.type === "contacts_assigned") return "/contacts";
  return "/notifications";
}

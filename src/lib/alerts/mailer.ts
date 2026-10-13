import "server-only";
/**
 * Email copies of in-app alerts (notifications.email = true): hot leads, unverified payments, ...
 * One email per person per run lists everything waiting for them, so a burst of alerts is one email, not ten.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { notifications, users } from "@/db/schema";
import { alertsEmail, type AlertEmailItem } from "@/emails/alerts";
import { contactLink, link } from "@/emails/render";
import { sendEmail } from "@/lib/email";
import { validTimeZone } from "@/lib/today/time";

/** Alerts older than this are not emailed any more (they are still in the bell). */
export const PENDING_EMAIL_MAX_AGE_HOURS = 48;
/** Upper bound of notifications handled per run; the next run picks up the rest. */
const RUN_LIMIT = 1000;

export type PendingEmailResult = {
  /** emails sent (one per person) */
  emails: number;
  /** notifications marked as emailed */
  notifications: number;
  /** people whose email could not be sent (their alerts stay pending for the next run) */
  failed: number;
  errors: string[];
};

/** Where an alert links to: the payments desk for payment checks, else the contact, else the bell. */
function hrefFor(n: { type: string; contactId: string | null }): string {
  if (n.type === "unverified_payment") return link("/payments?tab=unverified");
  if (n.contactId) return contactLink(n.contactId);
  return link("/notifications");
}

/**
 * Sends every pending email alert (email = true, emailed_at null, younger than PENDING_EMAIL_MAX_AGE_HOURS) of
 * active users. Rows are claimed first (emailed_at set in one UPDATE ... WHERE emailed_at IS NULL), so two
 * overlapping runs never send the same alert twice; if the email fails, the claim is undone for the next run.
 */
export async function sendPendingNotificationEmails(now: Date, tx: Tx = db): Promise<PendingEmailResult> {
  const result: PendingEmailResult = { emails: 0, notifications: 0, failed: 0, errors: [] };
  const rows = await tx
    .select({ id: notifications.id, userId: notifications.userId })
    .from(notifications)
    .innerJoin(users, and(eq(users.id, notifications.userId), eq(users.active, true)))
    .where(
      and(
        eq(notifications.email, true),
        isNull(notifications.emailedAt),
        // database clock: notifications are stamped by the database when they are created
        sql`${notifications.createdAt} > now() - make_interval(hours => ${PENDING_EMAIL_MAX_AGE_HOURS})`,
      ),
    )
    .orderBy(asc(notifications.createdAt))
    .limit(RUN_LIMIT);
  if (!rows.length) return result;

  const byUser = new Map<string, string[]>();
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.id]);
  const people = await tx
    .select({ id: users.id, name: users.name, email: users.email, timezone: users.timezone })
    .from(users)
    .where(inArray(users.id, [...byUser.keys()]));

  for (const person of people) {
    const ids = byUser.get(person.id) ?? [];
    const claimed = await tx
      .update(notifications)
      .set({ emailedAt: now })
      .where(and(inArray(notifications.id, ids), isNull(notifications.emailedAt)))
      .returning({
        id: notifications.id,
        type: notifications.type,
        title: notifications.title,
        body: notifications.body,
        contactId: notifications.contactId,
        createdAt: notifications.createdAt,
      });
    if (!claimed.length) continue;
    claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const items: AlertEmailItem[] = claimed.map((n) => ({ title: n.title, body: n.body, href: hrefFor(n), createdAt: n.createdAt }));
    const mail = alertsEmail({ name: person.name, timeZone: validTimeZone(person.timezone), items });
    let error: string | null = null;
    try {
      const res = await sendEmail({ to: person.email, ...mail });
      if (!res.ok) error = res.error ?? "the email service refused the message";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (error) {
      await tx
        .update(notifications)
        .set({ emailedAt: null })
        .where(inArray(notifications.id, claimed.map((n) => n.id)));
      result.failed += 1;
      result.errors.push(`${person.email}: ${error}`);
      continue;
    }
    result.emails += 1;
    result.notifications += claimed.length;
  }
  return result;
}

import "server-only";
import { and, count, eq, isNull, lt, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { contacts, payments, purchases } from "@/db/schema";
import { can } from "@/lib/auth/permissions";
import { getSetting } from "@/lib/settings";
import type { Role } from "@/db/schema";

const DAY_MS = 86_400_000;

/** Money work waiting on a manager: unverified bank/UPI/cash claims and overdue instalments. */
export type PaymentsDesk = {
  /** unverified payments (on purchases that are not cancelled) */
  unverified: number;
  /** their INR value */
  unverifiedInr: number;
  /** of those, waiting `staleDays` or more (the "unverified payment" alert threshold) */
  stale: number;
  staleDays: number;
  /** scheduled instalments past their due date */
  overdueInstalments: number;
};

/**
 * The payments a manager must act on, counted in SQL. Null for people who cannot verify payments.
 * Shared by the daily digest and the Today screen, so both say the same thing.
 */
export async function paymentsDesk(user: { role: Role }, now: Date, tx: Tx = db): Promise<PaymentsDesk | null> {
  if (!can(user, "payments.verify")) return null;
  const thresholds = await getSetting("thresholds", tx);
  const staleDays = Math.max(0, Number(thresholds.unverifiedPaymentDays) || 0);
  const staleCutoff = new Date(now.getTime() - staleDays * DAY_MS).toISOString();
  const [[u], [o]] = await Promise.all([
    tx
      .select({
        n: count(),
        inr: sql<number>`coalesce(sum(${payments.amountInr}), 0)`.mapWith(Number),
        stale: sql<number>`count(*) filter (where coalesce(${payments.paidAt}, ${payments.createdAt}) <= ${staleCutoff}::timestamptz)`.mapWith(
          Number,
        ),
      })
      .from(payments)
      .innerJoin(purchases, eq(purchases.id, payments.purchaseId))
      .innerJoin(contacts, eq(contacts.id, payments.contactId))
      .where(
        and(
          eq(payments.kind, "payment"),
          eq(payments.status, "unverified"),
          sql`${purchases.status} <> 'cancelled'`,
          isNull(contacts.mergedIntoId),
        ),
      ),
    tx
      .select({ n: count() })
      .from(payments)
      .innerJoin(purchases, eq(purchases.id, payments.purchaseId))
      .innerJoin(contacts, eq(contacts.id, payments.contactId))
      .where(
        and(
          eq(payments.kind, "payment"),
          eq(payments.status, "scheduled"),
          lt(payments.dueAt, now),
          sql`${purchases.status} not in ('cancelled', 'refunded')`,
          isNull(contacts.mergedIntoId),
        ),
      ),
  ]);
  return { unverified: u.n, unverifiedInr: u.inr, stale: u.stale, staleDays, overdueInstalments: o.n };
}

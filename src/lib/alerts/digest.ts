import "server-only";
/**
 * Digests (spec "Alerts and the Today queue"): "A daily digest goes out at 8:30 am in each user's own time zone,
 * and a weekly summary goes to Umer every Monday."
 *
 * - buildDailyDigest / sendDailyDigests: run every 15 minutes; each active user gets their digest once their
 *   LOCAL time has passed settings digest.dailyHour:dailyMinute, once per local date. A digest with nothing in it
 *   is not emailed.
 * - buildWeeklySummary / sendWeeklySummary: the last full week, Monday to Sunday (India calendar), for every admin
 *   plus settings digest.weeklyRecipients, once per week.
 * "Already sent" is recorded with markers (src/lib/alerts/shared.ts), claimed atomically before sending and given
 * back when the email fails, so overlapping runs never send twice and a failed send is retried.
 */
import { and, count, desc, eq, gt, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { contacts, notifications, payments, purchases, users, type Role } from "@/db/schema";
import { dailyDigestEmail, isDigestEmpty, type DailyDigestData, type DigestContactItem } from "@/emails/daily-digest";
import { weeklySummaryEmail, type WeeklySummaryData } from "@/emails/weekly-summary";
import { can } from "@/lib/auth/permissions";
import { BEYOND_UMER_MAX_LEVEL } from "@/lib/dashboard/metrics";
import { sendEmail } from "@/lib/email";
import { getSetting, getSettings, labelFor } from "@/lib/settings";
import { getTodayQueue } from "@/lib/today/queue";
import { TASK_TYPE_LABELS } from "@/lib/today/rank";
import { localTime, validTimeZone } from "@/lib/today/time";
import { CHECKOUT_CHANNEL } from "./rules";
import { DEFAULT_TIME_ZONE, digestSendTime, isDigestDue, localDateKey, weekWindow, wholeDaysBetween } from "./schedule";
import {
  DAY_MS,
  HOUR_MS,
  claimMarker,
  existingMarkers,
  lastMarkerAt,
  releaseMarker,
  umerRecipients,
  updateMarker,
} from "./shared";

/** Rows listed per section of the daily digest. */
const DIGEST_LIST = 5;

export type DigestUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  team: string | null;
  timezone: string | null;
};

export type SendResult = {
  sent: number;
  /** nothing to say: recorded as done, no email */
  empty: number;
  /** not yet their local send time */
  waiting: number;
  /** already sent today (or this week) */
  skipped: number;
  failed: number;
  errors: string[];
};

const emptyResult = (): SendResult => ({ sent: 0, empty: 0, waiting: 0, skipped: 0, failed: 0, errors: [] });

// ---------------------------------------------------------------------------
// Daily digest
// ---------------------------------------------------------------------------

/**
 * What one person's digest says at `now`: their Today list (count, abandoned checkouts, overdue follow-ups and the
 * first rows), new leads assigned to them, hot leads and VIPs gone quiet alerted to them, and for payment
 * verifiers the payments waiting. "New" means since their previous digest (at most 48 hours back; 24 hours when
 * there was none).
 */
export async function buildDailyDigest(
  user: DigestUser,
  now: Date,
  tx: Tx = db,
  opts: { since?: Date } = {},
): Promise<DailyDigestData> {
  const tz = validTimeZone(user.timezone);
  const s = await getSettings(["digest", "thresholds", "lists.channels"], tx);
  let since = opts.since;
  if (!since) {
    const prev = await lastMarkerAt(`daily:${user.id}:`, now, tx);
    since = prev && prev.getTime() > now.getTime() - 48 * HOUR_MS ? prev : new Date(now.getTime() - DAY_MS);
  }

  const queue = await getTodayQueue({ id: user.id, role: user.role, team: user.team, timezone: tz }, now, { tx });
  const top: DigestContactItem[] = queue.rows.slice(0, DIGEST_LIST).map((r) => ({
    contactId: r.contact?.id ?? null,
    name: r.contact?.name ?? TASK_TYPE_LABELS[r.primary.type],
    detail: r.reason,
  }));

  const newLeadWhere = and(
    eq(contacts.ownerId, user.id),
    isNull(contacts.mergedIntoId),
    eq(contacts.purchaseCount, 0),
    gte(contacts.ownerAssignedAt, since),
    lte(contacts.ownerAssignedAt, now),
  );
  const [{ n: newLeadCount }] = await tx.select({ n: count() }).from(contacts).where(newLeadWhere);
  const newLeadRows = newLeadCount
    ? await tx
        .select({ id: contacts.id, name: contacts.name, channel: contacts.lastChannel, grade: contacts.grade })
        .from(contacts)
        .where(newLeadWhere)
        .orderBy(desc(contacts.ownerAssignedAt), desc(contacts.id))
        .limit(DIGEST_LIST)
    : [];

  const alertsOf = async (type: string) => {
    const where = and(
      eq(notifications.userId, user.id),
      eq(notifications.type, type),
      gte(notifications.createdAt, since),
      lte(notifications.createdAt, now),
    );
    const [{ n }] = await tx.select({ n: count() }).from(notifications).where(where);
    const rows = n
      ? await tx
          .select({ contactId: notifications.contactId, title: notifications.title, body: notifications.body })
          .from(notifications)
          .where(where)
          .orderBy(desc(notifications.createdAt), desc(notifications.id))
          .limit(DIGEST_LIST)
      : [];
    return { count: n, rows };
  };
  const hot = await alertsOf("hot_lead");
  const vip = await alertsOf("vip_quiet");
  const contactNames = await namesOf(
    [...hot.rows, ...vip.rows].map((r) => r.contactId).filter((x): x is string => !!x),
    tx,
  );
  const fromAlert = (r: { contactId: string | null; title: string; body: string | null }): DigestContactItem => ({
    contactId: r.contactId,
    name: (r.contactId && contactNames.get(r.contactId)) || r.title.replace(/^[^:]+:\s*/, ""),
    detail: r.body,
  });

  let paymentsBlock: DailyDigestData["payments"] = null;
  if (can(user, "payments.verify")) {
    const staleDays = Math.max(0, Number(s.thresholds.unverifiedPaymentDays) || 0);
    const staleCutoff = new Date(now.getTime() - staleDays * DAY_MS).toISOString();
    const [u] = await tx
      .select({
        n: count(),
        inr: sql<number>`coalesce(sum(${payments.amountInr}), 0)`.mapWith(Number),
        stale: sql<number>`count(*) filter (where coalesce(${payments.paidAt}, ${payments.createdAt}) <= ${staleCutoff}::timestamptz)`.mapWith(Number),
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
      );
    const [o] = await tx
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
      );
    paymentsBlock = { unverified: u.n, unverifiedInr: u.inr, stale: u.stale, staleDays, overdueInstalments: o.n };
  }

  const channels = s["lists.channels"];
  const sendAt = digestSendTime(now, tz, s.digest.dailyHour, s.digest.dailyMinute);
  return {
    user: { name: user.name, timeZone: tz },
    now,
    sendTimeLabel: localTime(sendAt, tz),
    today: { total: queue.total, abandoned: queue.counts.abandoned, overdue: queue.counts.overdue, top },
    newLeads: {
      count: newLeadCount,
      items: newLeadRows.map((c) => ({
        contactId: c.id,
        name: c.name,
        detail: [c.channel ? labelFor(channels, c.channel) : null, c.grade ? `Grade ${c.grade}` : "Not scored yet"]
          .filter(Boolean)
          .join(" · "),
      })),
    },
    hotLeads: { count: hot.count, items: hot.rows.map(fromAlert) },
    vipQuiet: { count: vip.count, items: vip.rows.map(fromAlert) },
    payments: paymentsBlock,
  };
}

async function namesOf(ids: string[], tx: Tx): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await tx
    .select({ id: contacts.id, name: contacts.name })
    .from(contacts)
    .where(inArray(contacts.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Marker key of a person's digest for their local date. */
export function dailyDigestKey(userId: string, now: Date, timeZone: string | null | undefined): string {
  return `daily:${userId}:${localDateKey(now, timeZone)}`;
}

/**
 * Sends today's digest to every active user whose local time has reached digest.dailyHour:dailyMinute and who has
 * not had today's digest yet (run it every 15 minutes: a Kerala user gets it at 8:30 IST, a Dubai user at 8:30 GST).
 */
export async function sendDailyDigests(now: Date, tx: Tx = db): Promise<SendResult> {
  const result = emptyResult();
  const cfg = await getSetting("digest", tx);
  const people = await tx
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, team: users.team, timezone: users.timezone })
    .from(users)
    .where(eq(users.active, true))
    .orderBy(users.name, users.id);
  const due = people.filter((u) => {
    const ok = isDigestDue(now, u.timezone, cfg.dailyHour, cfg.dailyMinute);
    if (!ok) result.waiting += 1;
    return ok;
  });
  const keyOf = (u: (typeof people)[number]) => dailyDigestKey(u.id, now, u.timezone);
  const done = await existingMarkers(due.map(keyOf), tx);

  for (const u of due) {
    const key = keyOf(u);
    if (done.has(key) || !(await claimMarker(key, "daily", { status: "sending", userId: u.id }, now, tx))) {
      result.skipped += 1;
      continue;
    }
    try {
      const data = await buildDailyDigest(u, now, tx);
      if (isDigestEmpty(data)) {
        await updateMarker(key, { status: "empty", userId: u.id }, tx);
        result.empty += 1;
        continue;
      }
      const mail = dailyDigestEmail(data);
      const res = await sendEmail({ to: u.email, ...mail });
      if (!res.ok) throw new Error(res.error ?? "the email service refused the message");
      await updateMarker(key, { status: "sent", userId: u.id, emailId: res.id ?? null, subject: mail.subject }, tx);
      result.sent += 1;
    } catch (e) {
      // give the claim back so the next run (15 minutes later) tries again; the failure is reported, not hidden
      await releaseMarker(key, tx);
      result.failed += 1;
      result.errors.push(`${u.email}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Weekly summary
// ---------------------------------------------------------------------------

export type WeeklySummary = WeeklySummaryData & { weekKey: string };

const num = (v: unknown) => Number(v ?? 0) || 0;

/**
 * The Monday summary over the last full week, Monday to Sunday (India calendar), compared with the week before:
 * revenue (verified payments minus verified refunds, INR, by payment date), new customers (first purchase in the
 * week), new leads by first channel, assisted vs self-serve revenue (sales credit on the purchase), the
 * Beyond-Umer share (revenue from customers at Umer familiarity 0 to 2, out of the revenue from rated customers;
 * unrated revenue is reported apart, exactly like the dashboard's beyondUmerShare), the at-risk pool, unverified
 * payments, abandoned checkouts (those that passed the window, and how many of them were recovered, as on the
 * dashboard), top advocates and VIPs gone quiet.
 */
export async function buildWeeklySummary(now: Date, tx: Tx = db): Promise<WeeklySummary> {
  const tz = DEFAULT_TIME_ZONE;
  const win = weekWindow(now, tz);
  const s = await getSettings(["thresholds", "lists.channels"], tx);
  const [start, end, prevStart] = [win.start.toISOString(), win.end.toISOString(), win.prevStart.toISOString()];

  const [rev] = await tx.execute<{
    current: string;
    previous: string;
    assisted: string;
    self_serve: string;
    beyond: string;
    circle: string;
    unrated: string;
  }>(sql`
    with m as (
      select
        case when p.kind = 'refund' then -p.amount_inr else p.amount_inr end as inr,
        coalesce(p.paid_at, p.verified_at, p.created_at) as at,
        pu.assisted,
        c.umer_level as umer
      from payments p
      join purchases pu on pu.id = p.purchase_id
      join contacts c on c.id = p.contact_id
      where p.status = 'verified'
        and coalesce(p.paid_at, p.verified_at, p.created_at) >= ${prevStart}::timestamptz
        and coalesce(p.paid_at, p.verified_at, p.created_at) < ${end}::timestamptz
    )
    select
      coalesce(sum(inr) filter (where at >= ${start}::timestamptz), 0) as current,
      coalesce(sum(inr) filter (where at < ${start}::timestamptz), 0) as previous,
      coalesce(sum(inr) filter (where at >= ${start}::timestamptz and assisted), 0) as assisted,
      coalesce(sum(inr) filter (where at >= ${start}::timestamptz and not assisted), 0) as self_serve,
      coalesce(sum(inr) filter (where at >= ${start}::timestamptz and umer <= ${BEYOND_UMER_MAX_LEVEL}), 0) as beyond,
      coalesce(sum(inr) filter (where at >= ${start}::timestamptz and umer > ${BEYOND_UMER_MAX_LEVEL}), 0) as circle,
      coalesce(sum(inr) filter (where at >= ${start}::timestamptz and umer is null), 0) as unrated
    from m
  `);
  const current = num(rev?.current);

  const [{ n: newCustomers }] = await tx
    .select({ n: count() })
    .from(contacts)
    .where(and(isNull(contacts.mergedIntoId), gte(contacts.firstPurchaseAt, win.start), lt(contacts.firstPurchaseAt, win.end)));

  const channelRows = await tx
    .select({ channel: contacts.firstChannel, n: count() })
    .from(contacts)
    .where(and(isNull(contacts.mergedIntoId), gte(contacts.createdAt, win.start), lt(contacts.createdAt, win.end)))
    .groupBy(contacts.firstChannel);
  const byChannel = channelRows
    .map((r) => ({
      key: r.channel ?? "unknown",
      label: r.channel ? labelFor(s["lists.channels"], r.channel) : "Not recorded",
      count: r.n,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const [enq] = await tx.execute<{ total: string; abandoned: string; recovered: string }>(sql`
    select
      count(*) as total,
      count(*) filter (where channel = ${CHECKOUT_CHANNEL} and status in ('abandoned', 'recovered')) as abandoned,
      count(*) filter (where channel = ${CHECKOUT_CHANNEL} and status = 'recovered') as recovered
    from enquiries
    where received_at >= ${start}::timestamptz and received_at < ${end}::timestamptz
  `);

  const [risk] = await tx
    .select({ n: count(), inr: sql<number>`coalesce(sum(${contacts.expected90dInr}), 0)`.mapWith(Number) })
    .from(contacts)
    .where(and(isNull(contacts.mergedIntoId), eq(contacts.atRisk, true)));

  const staleDays = Math.max(0, Number(s.thresholds.unverifiedPaymentDays) || 0);
  const staleCutoff = new Date(now.getTime() - staleDays * DAY_MS).toISOString();
  const [unv] = await tx
    .select({
      n: count(),
      inr: sql<number>`coalesce(sum(${payments.amountInr}), 0)`.mapWith(Number),
      stale: sql<number>`count(*) filter (where coalesce(${payments.paidAt}, ${payments.createdAt}) <= ${staleCutoff}::timestamptz)`.mapWith(Number),
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
    );

  const advocates = await tx
    .select({ id: contacts.id, name: contacts.name, referrals: contacts.referralCount, network: contacts.networkValueInr })
    .from(contacts)
    .where(and(isNull(contacts.mergedIntoId), gt(contacts.networkValueInr, 0)))
    .orderBy(desc(contacts.networkValueInr), desc(contacts.referralCount), contacts.id)
    .limit(5);

  const quietDays = Math.max(1, Number(s.thresholds.vipQuietDays) || 120);
  const lastSeen = sql<Date>`coalesce(${contacts.lastActivityAt}, ${contacts.lastPurchaseAt}, ${contacts.createdAt})`;
  const vipWhere = and(
    isNull(contacts.mergedIntoId),
    eq(contacts.grade, "A"),
    gt(contacts.purchaseCount, 0),
    sql`${contacts.stage} <> 'lost'`,
    sql`${lastSeen} <= ${new Date(now.getTime() - quietDays * DAY_MS).toISOString()}::timestamptz`,
  );
  const [{ n: vipCount }] = await tx.select({ n: count() }).from(contacts).where(vipWhere);
  const vipRows = vipCount
    ? await tx
        .select({
          id: contacts.id,
          name: contacts.name,
          ltv: contacts.ltvInr,
          lastActivityAt: contacts.lastActivityAt,
          lastPurchaseAt: contacts.lastPurchaseAt,
          createdAt: contacts.createdAt,
        })
        .from(contacts)
        .where(vipWhere)
        .orderBy(desc(contacts.ltvInr), contacts.id)
        .limit(5)
    : [];

  return {
    weekKey: win.weekKey,
    range: { start: win.start, end: win.end, timeZone: tz },
    revenue: { current, previous: num(rev?.previous) },
    newCustomers,
    leads: { total: byChannel.reduce((a, c) => a + c.count, 0), enquiries: num(enq?.total), byChannel },
    assisted: { assistedInr: num(rev?.assisted), selfServeInr: num(rev?.self_serve) },
    beyondUmer: {
      share: num(rev?.beyond) + num(rev?.circle) > 0 ? num(rev?.beyond) / (num(rev?.beyond) + num(rev?.circle)) : null,
      inr: num(rev?.beyond),
      unratedInr: num(rev?.unrated),
    },
    atRisk: { count: risk.n, expectedInr: risk.inr },
    unverified: { count: unv.n, inr: unv.inr, stale: unv.stale, staleDays },
    checkouts: { abandoned: num(enq?.abandoned), recovered: num(enq?.recovered) },
    topAdvocates: advocates.map((a) => ({ contactId: a.id, name: a.name, referrals: a.referrals, networkInr: Number(a.network) })),
    vipQuiet: {
      count: vipCount,
      quietDays,
      items: vipRows.map((v) => ({
        contactId: v.id,
        name: v.name,
        ltvInr: Number(v.ltv),
        quietDays: wholeDaysBetween(v.lastActivityAt ?? v.lastPurchaseAt ?? v.createdAt, now),
      })),
    },
  };
}

/**
 * Emails the weekly summary to every admin and to settings digest.weeklyRecipients (user ids, team emails or
 * outside addresses), once per recipient per week. Scheduled for Monday morning.
 */
export async function sendWeeklySummary(now: Date, tx: Tx = db): Promise<SendResult & { weekKey: string; recipients: number }> {
  const result = emptyResult();
  const { weekKey } = weekWindow(now, DEFAULT_TIME_ZONE);
  const recipients = await umerRecipients(tx);
  const keyOf = (email: string) => `weekly:${weekKey}:${email.toLowerCase()}`;
  const done = await existingMarkers(recipients.map((r) => keyOf(r.email)), tx);
  result.skipped = recipients.filter((r) => done.has(keyOf(r.email))).length;
  const pending = recipients.filter((r) => !done.has(keyOf(r.email)));
  // everyone already has this week's summary (a retry later in the week): no need to build it again
  if (!pending.length) return { ...result, weekKey, recipients: recipients.length };
  const summary = await buildWeeklySummary(now, tx);
  const mail = weeklySummaryEmail(summary);
  for (const r of pending) {
    const key = keyOf(r.email);
    if (!(await claimMarker(key, "weekly", { status: "sending", userId: r.userId }, now, tx))) {
      result.skipped += 1;
      continue;
    }
    try {
      const res = await sendEmail({ to: r.email, ...mail });
      if (!res.ok) throw new Error(res.error ?? "the email service refused the message");
      await updateMarker(key, { status: "sent", userId: r.userId, emailId: res.id ?? null, subject: mail.subject }, tx);
      result.sent += 1;
    } catch (e) {
      await releaseMarker(key, tx);
      result.failed += 1;
      result.errors.push(`${r.email}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ...result, weekKey, recipients: recipients.length };
}

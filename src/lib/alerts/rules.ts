import "server-only";
/**
 * The alert rules (spec "Alerts and the Today queue"). One function per alert; each takes (now, tx), reads its
 * thresholds from settings, and is idempotent: tasks and notifications carry dedupe keys (inserted with
 * ON CONFLICT DO NOTHING), so running a rule every 15 minutes never raises the same alert twice.
 *
 * | Alert              | Rule here               | Goes to                                  | Dedupe key                                   |
 * | Abandoned checkout | abandonedCheckouts      | owner, or the pool (top of Today)        | abandoned_checkout:<enquiry>                 |
 * | Untouched lead     | untouchedLeads          | owner (task + in-app); managers later    | untouched_lead[_manager]:<contact>:<assigned>|
 * | Lead released      | releaseStaleLeads       | managers (contacts module)               | lead_released:<contact>:<assigned>           |
 * | Follow-up due      | followUpsDue            | assignee (in-app ping; the task is Today) | follow_up_due:<task>                         |
 * | Due for next rung  | dueForNextRung          | owner, or the pool (Today)               | next_rung:<contact>:<expected date>          |
 * | At risk            | atRisk                  | owner, or the pool (Today)               | at_risk:<contact>:<yyyy-mm>                  |
 * | Instalment due     | instalmentsDue          | owner (task) + owner and managers in-app | instalment_due:<payment>[:overdue]           |
 * | Unverified payment | unverifiedPayments      | managers, by email                       | unverified_payment:<payment>                 |
 * | VIP gone quiet     | vipGoneQuiet            | owner and Umer, in the daily digest      | vip_quiet:<contact>:<yyyy-Qn>                |
 *
 * New lead and hot lead are raised by captureEnquiry (contacts/capture.ts) and new advocate by the money module
 * (money/internal.ts onVerifiedMoney) at the moment they happen; they are not repeated here. The money module
 * also closes instalment / unverified alerts when the money is verified, and abandoned-checkout alerts (marking
 * the enquiry "recovered") when the customer pays.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type Tx } from "@/db";
import { contacts, enquiries, notifications, payments, purchases, tasks, users, type PaymentMode, type Role } from "@/db/schema";
import { releaseStaleLeads as releaseStaleLeadsService } from "@/lib/contacts/assignment";
import { checkoutResolution } from "@/lib/money/rules";
import { getSetting, getSettings, type Settings } from "@/lib/settings";
import { shortDate, validTimeZone } from "@/lib/today/time";
import { formatINR } from "@/lib/utils";
import { createTask, createTasks, managerIds, notify, type NewNotification, type NewTask } from "./core";
import { DEFAULT_TIME_ZONE, monthKey, quarterKey, wholeDaysBetween } from "./schedule";
import {
  DAY_MS,
  HOUR_MS,
  assigneeFor,
  atTimeOn,
  inTx,
  money,
  teamTimeZone,
  umerRecipients,
  unique,
} from "./shared";

/** The TagMango checkout channel key (settings lists.channels). */
export const CHECKOUT_CHANNEL = "tagmango_checkout";
/** Task priority for alerts that must sit above everything else in their Today band. */
export const PRIORITY_HIGH = 100;
/** Monthly / quarterly dedupe keys use the business calendar (India). */
const BUSINESS_TZ = DEFAULT_TIME_ZONE;
/** Rows handled per rule per run; the next run (15 minutes later) picks up the rest. */
const BATCH = 500;
/** Leads released per run (each release writes the ownership log, a task and an alert per manager). */
const RELEASE_BATCH = 300;
/**
 * Checkouts started more than this many days ago are no longer "hot": a backfill or a long outage must not flood
 * Today with week-old checkouts. (The spec's live threshold is thresholds.abandonedCheckoutMinutes.)
 */
export const ABANDONED_LOOKBACK_DAYS = 7;
/** Follow-ups that fell due more than this long ago are not pinged (they are already overdue on Today). */
const FOLLOW_UP_PING_WINDOW_MS = DAY_MS;

const MODE_LABELS: Record<PaymentMode, string> = {
  tagmango: "TagMango",
  bank_transfer: "Bank transfer",
  upi_qr: "UPI QR",
  cash: "Cash",
  other: "Other",
};

const owner = alias(users, "alert_owner");
const ownerCols = { ownerActive: owner.active, ownerRole: owner.role, ownerTz: owner.timezone };

type Wording = { teams: Pick<Settings, "teams" | "assignment"> };

/** The assignee of a contact's alert and the time zone its wording uses. */
function routeTo(
  c: { ownerId: string | null; ownerActive: boolean | null; ownerRole: Role | null; ownerTz: string | null; phoneCountry: string | null },
  w: Wording,
): { userId: string | null; tz: string } {
  const userId = assigneeFor({ id: c.ownerId, active: c.ownerActive, role: c.ownerRole });
  const tz = userId ? validTimeZone(c.ownerTz) : teamTimeZone(c.phoneCountry, w.teams.teams, w.teams.assignment);
  return { userId, tz };
}

async function wording(tx: Tx): Promise<Wording> {
  return { teams: await getSettings(["teams", "assignment"], tx) };
}

/** Which of these keys already exist in `tasks.dedupe_key`. */
async function existingTaskKeys(keys: string[], tx: Tx): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await tx.select({ k: tasks.dedupeKey }).from(tasks).where(inArray(tasks.dedupeKey, unique(keys)));
  return new Set(rows.map((r) => r.k!));
}

/** Which of these keys already exist in `notifications.dedupe_key` (already scoped per user: "<key>:<userId>"). */
async function existingNotificationKeys(keys: string[], tx: Tx): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const out = new Set<string>();
  const list = unique(keys);
  for (let i = 0; i < list.length; i += 1000) {
    const rows = await tx
      .select({ k: notifications.dedupeKey })
      .from(notifications)
      .where(inArray(notifications.dedupeKey, list.slice(i, i + 1000)));
    for (const r of rows) out.add(r.k!);
  }
  return out;
}

/**
 * Inserts the notifications whose "<dedupeKey>:<userId>" does not exist yet. Returns how many were created and
 * the ones that were new before inserting.
 */
async function notifyNew(list: NewNotification[], tx: Tx): Promise<{ created: number; fresh: NewNotification[] }> {
  if (!list.length) return { created: 0, fresh: [] };
  const seen = await existingNotificationKeys(
    list.filter((n) => n.dedupeKey).map((n) => `${n.dedupeKey}:${n.userId}`),
    tx,
  );
  const fresh = list.filter((n) => !n.dedupeKey || !seen.has(`${n.dedupeKey}:${n.userId}`));
  let created = 0;
  for (let i = 0; i < fresh.length; i += 500) created += await notify(fresh.slice(i, i + 500), tx);
  return { created, fresh };
}

// ---------------------------------------------------------------------------
// Abandoned checkout
// ---------------------------------------------------------------------------

export type AbandonedCheckoutResult = {
  /** checkout enquiries marked "abandoned" */
  abandoned: number;
  /** abandoned-checkout tasks created (one per contact; a contact with an open one gets no second) */
  tasks: number;
  /** checkouts that turned out to be paid after all (marked "handled" or "recovered") */
  resolved: number;
  /** checkouts left alone because a manual payment for them is waiting for verification */
  waiting: number;
};

/**
 * "Anyone who started paying and has no completed order an hour later becomes a call task at the top of Today."
 * Looks at TagMango checkout enquiries (status checkout_started / checkout_failed) older than
 * thresholds.abandonedCheckoutMinutes (and not older than ABANDONED_LOOKBACK_DAYS):
 * - verified money for the contact that the money module would match to this checkout (checkoutResolution: paid
 *   from a day before the checkout onwards) -> the enquiry becomes "handled" / "recovered", no alert;
 * - a manual payment for it still waiting for verification -> left alone until it is verified or rejected;
 * - otherwise the enquiry becomes "abandoned" and the contact gets one high-priority "abandoned_checkout" task for
 *   its owner (or the pool when it has no active owner), unless an open one already exists.
 */
export async function abandonedCheckouts(now: Date, tx: Tx = db): Promise<AbandonedCheckoutResult> {
  const thresholds = await getSetting("thresholds", tx);
  const minutes = Math.max(0, Number(thresholds.abandonedCheckoutMinutes) || 0);
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const since = new Date(now.getTime() - ABANDONED_LOOKBACK_DAYS * DAY_MS);
  const w = await wording(tx);
  const result: AbandonedCheckoutResult = { abandoned: 0, tasks: 0, resolved: 0, waiting: 0 };

  return inTx(tx, async (t) => {
    const rows = await t
      .select({
        id: enquiries.id,
        contactId: enquiries.contactId,
        status: enquiries.status,
        receivedAt: enquiries.receivedAt,
        productInterest: enquiries.productInterest,
        contactName: contacts.name,
        ownerId: contacts.ownerId,
        phoneCountry: contacts.phoneCountry,
        ...ownerCols,
      })
      .from(enquiries)
      .innerJoin(contacts, eq(contacts.id, enquiries.contactId))
      .leftJoin(owner, eq(owner.id, contacts.ownerId))
      .where(
        and(
          eq(enquiries.channel, CHECKOUT_CHANNEL),
          inArray(enquiries.status, ["checkout_started", "checkout_failed"]),
          lte(enquiries.receivedAt, cutoff),
          gt(enquiries.receivedAt, since),
          isNull(contacts.mergedIntoId),
        ),
      )
      .orderBy(asc(enquiries.receivedAt), asc(enquiries.id))
      .limit(BATCH)
      .for("update", { of: enquiries, skipLocked: true });
    if (!rows.length) return result;

    const contactIds = unique(rows.map((r) => r.contactId));
    const earliest = Math.min(...rows.map((r) => r.receivedAt.getTime()));
    const paid = await t
      .select({
        contactId: payments.contactId,
        status: payments.status,
        paidAt: payments.paidAt,
        verifiedAt: payments.verifiedAt,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(
        and(
          inArray(payments.contactId, contactIds),
          eq(payments.kind, "payment"),
          inArray(payments.status, ["verified", "unverified"]),
          sql`coalesce(${payments.paidAt}, ${payments.verifiedAt}, ${payments.createdAt}) >= ${new Date(earliest - DAY_MS).toISOString()}::timestamptz`,
        ),
      );
    const moneyOf = new Map<string, { status: string; at: Date }[]>();
    for (const m of paid) {
      const list = moneyOf.get(m.contactId) ?? [];
      list.push({ status: m.status, at: m.paidAt ?? m.verifiedAt ?? m.createdAt });
      moneyOf.set(m.contactId, list);
    }

    const handled: string[] = [];
    const recovered: string[] = [];
    const abandonedByContact = new Map<string, typeof rows>();
    for (const e of rows) {
      const list = moneyOf.get(e.contactId) ?? [];
      const outcomes = list
        .filter((m) => m.status === "verified")
        .map((m) => checkoutResolution(e, m.at, minutes))
        .filter((r): r is "handled" | "recovered" => r !== null);
      if (outcomes.length) {
        (outcomes.includes("handled") ? handled : recovered).push(e.id);
        continue;
      }
      const claimed = list.some((m) => m.status === "unverified" && m.at.getTime() >= e.receivedAt.getTime() - DAY_MS);
      if (claimed) {
        result.waiting += 1;
        continue;
      }
      const g = abandonedByContact.get(e.contactId) ?? [];
      g.push(e);
      abandonedByContact.set(e.contactId, g);
    }

    if (handled.length) await t.update(enquiries).set({ status: "handled" }).where(inArray(enquiries.id, handled));
    if (recovered.length) await t.update(enquiries).set({ status: "recovered" }).where(inArray(enquiries.id, recovered));
    result.resolved = handled.length + recovered.length;
    if (!abandonedByContact.size) return result;

    const open = await t
      .select({ contactId: tasks.contactId })
      .from(tasks)
      .where(
        and(
          inArray(tasks.contactId, [...abandonedByContact.keys()]),
          eq(tasks.type, "abandoned_checkout"),
          eq(tasks.status, "open"),
        ),
      );
    const hasOpen = new Set(open.map((o) => o.contactId));

    const abandonedIds: string[] = [];
    for (const [contactId, list] of abandonedByContact) {
      abandonedIds.push(...list.map((e) => e.id));
      if (hasOpen.has(contactId)) continue;
      const latest = list[list.length - 1];
      const { userId, tz } = routeTo(latest, w);
      const what = latest.productInterest?.trim() || "an order";
      const when = atTimeOn(latest.receivedAt, now, tz);
      const reason =
        latest.status === "checkout_failed"
          ? `Payment failed for ${what} at ${when} — no completed order`
          : `Started paying for ${what} at ${when} — no completed order`;
      const id = await createTask(
        {
          contactId,
          userId,
          type: "abandoned_checkout",
          reason,
          dueAt: new Date(latest.receivedAt.getTime() + minutes * 60_000),
          priority: PRIORITY_HIGH,
          dedupeKey: `abandoned_checkout:${latest.id}`,
          payload: { enquiryIds: list.map((e) => e.id), product: latest.productInterest ?? null },
        },
        t,
      );
      if (id) result.tasks += 1;
    }
    await t.update(enquiries).set({ status: "abandoned" }).where(inArray(enquiries.id, abandonedIds));
    result.abandoned = abandonedIds.length;
    return result;
  });
}

// ---------------------------------------------------------------------------
// Untouched lead
// ---------------------------------------------------------------------------

export type UntouchedLeadResult = {
  /** owner tasks (each with an in-app alert to the owner) */
  ownerAlerts: number;
  /** in-app alerts to managers */
  managerAlerts: number;
  /** open untouched-lead tasks closed because they were answered or no longer apply */
  closed: number;
};

/**
 * "No interaction 24 hours after assignment -> owner; manager at 48 hours."
 * An open lead (no purchase, not Lost) assigned at owner_assigned_at whose owner has logged no interaction since:
 * - after thresholds.untouchedOwnerHours: an "untouched_lead" task and an in-app alert for the owner;
 * - after thresholds.untouchedManagerHours: an in-app alert for every manager (not the owner themselves).
 * Deduped per contact and assignment time, so a reassignment starts the clock again. Assignments older than the
 * release window (thresholds.leadReleaseDays) are left to the release rule. Open untouched tasks that were
 * answered (the owner logged an interaction) or no longer apply (reassigned, released, bought, Lost) are closed.
 */
export async function untouchedLeads(now: Date, tx: Tx = db): Promise<UntouchedLeadResult> {
  const th = await getSetting("thresholds", tx);
  const ownerH = Number(th.untouchedOwnerHours);
  const mgrH = Number(th.untouchedManagerHours);
  const result: UntouchedLeadResult = { ownerAlerts: 0, managerAlerts: 0, closed: 0 };
  const stages = [ownerH, mgrH].filter((h) => Number.isFinite(h) && h > 0);

  return inTx(tx, async (t) => {
    result.closed = await closeUntouchedTasks(now, t);
    if (!stages.length) return result;
    const first = Math.min(...stages);
    const releaseDays = Number(th.leadReleaseDays) > 0 ? Number(th.leadReleaseDays) : 30;
    const lookback = new Date(now.getTime() - Math.max(releaseDays * DAY_MS, Math.max(...stages) * HOUR_MS + DAY_MS));

    // Leads whose alerts for this assignment are all out already are skipped in SQL, so the batch below only
    // holds leads with something left to raise (otherwise a backlog of more than one batch of untouched leads
    // would starve the newest ones forever).
    const assignedStamp = sql`to_char(${contacts.ownerAssignedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    const ownerDone = Number.isFinite(ownerH) && ownerH > 0
      ? sql`exists (select 1 from tasks t where t.dedupe_key = 'untouched_lead:' || ${contacts.id}::text || ':' || ${assignedStamp})`
      : sql`true`;
    const managerDone = Number.isFinite(mgrH) && mgrH > 0
      ? sql`(${contacts.ownerAssignedAt} > ${new Date(now.getTime() - mgrH * HOUR_MS).toISOString()}::timestamptz
          or exists (
            select 1 from notifications n
            where n.contact_id = ${contacts.id} and n.type = 'untouched_lead'
              and n.dedupe_key like 'untouched_lead_manager:' || ${contacts.id}::text || ':' || ${assignedStamp} || ':%'
          ))`
      : sql`true`;

    const rows = await t
      .select({
        id: contacts.id,
        name: contacts.name,
        ownerId: contacts.ownerId,
        assignedAt: contacts.ownerAssignedAt,
        ownerName: users.name,
        ownerTz: users.timezone,
      })
      .from(contacts)
      .innerJoin(users, and(eq(users.id, contacts.ownerId), eq(users.active, true)))
      .where(
        and(
          isNull(contacts.mergedIntoId),
          isNotNull(contacts.ownerAssignedAt),
          eq(contacts.purchaseCount, 0),
          ne(contacts.stage, "lost"),
          lte(contacts.ownerAssignedAt, new Date(now.getTime() - first * HOUR_MS)),
          gt(contacts.ownerAssignedAt, lookback),
          sql`not exists (select 1 from purchases p where p.contact_id = ${contacts.id} and p.status <> 'cancelled')`,
          sql`not exists (
            select 1 from interactions i
            where i.contact_id = ${contacts.id} and i.user_id = ${contacts.ownerId} and i.occurred_at >= ${contacts.ownerAssignedAt}
          )`,
          sql`not (${ownerDone} and ${managerDone})`,
        ),
      )
      .orderBy(asc(contacts.ownerAssignedAt), asc(contacts.id))
      .limit(2 * BATCH);
    if (!rows.length) return result;

    const managers = await managerIds(t);
    const ownerKeys = rows.map((r) => `untouched_lead:${r.id}:${r.assignedAt!.toISOString()}`);
    const seenTasks = await existingTaskKeys(ownerKeys, t);
    const managerAlerts: NewNotification[] = [];

    for (const r of rows) {
      const stamp = r.assignedAt!.toISOString();
      const ageH = (now.getTime() - r.assignedAt!.getTime()) / HOUR_MS;
      const tz = validTimeZone(r.ownerTz);
      const assigned = atTimeOn(r.assignedAt!, now, tz);
      const key = `untouched_lead:${r.id}:${stamp}`;
      if (Number.isFinite(ownerH) && ownerH > 0 && ageH >= ownerH && !seenTasks.has(key)) {
        const reason = `No call or message logged since it was assigned at ${assigned}`;
        const taskId = await createTask(
          {
            contactId: r.id,
            userId: r.ownerId,
            type: "untouched_lead",
            reason,
            dueAt: now,
            dedupeKey: key,
            payload: { assignedAt: stamp },
          },
          t,
        );
        if (taskId) {
          result.ownerAlerts += 1;
          await notify(
            {
              userId: r.ownerId!,
              type: "untouched_lead",
              title: `Untouched lead: ${r.name}`,
              body: reason,
              contactId: r.id,
              taskId,
              dedupeKey: key,
            },
            t,
          );
        }
      }
      if (Number.isFinite(mgrH) && mgrH > 0 && ageH >= mgrH) {
        for (const m of managers) {
          if (m === r.ownerId) continue;
          managerAlerts.push({
            userId: m,
            type: "untouched_lead",
            title: `Untouched for ${Math.round(mgrH)} hours: ${r.name}`,
            body: `${r.ownerName} has logged no interaction in the ${Math.floor(ageH)} hours since the lead was assigned`,
            contactId: r.id,
            dedupeKey: `untouched_lead_manager:${r.id}:${stamp}`,
          });
        }
      }
    }
    result.managerAlerts = (await notifyNew(managerAlerts, t)).created;
    return result;
  });
}

/** Closes open untouched-lead tasks: "done" once the owner logged an interaction, "dismissed" when obsolete. */
async function closeUntouchedTasks(now: Date, t: Tx): Promise<number> {
  const answered = await t
    .update(tasks)
    .set({ status: "done", completedAt: now })
    .where(
      and(
        eq(tasks.type, "untouched_lead"),
        eq(tasks.status, "open"),
        sql`exists (
          select 1 from contacts c join interactions i on i.contact_id = c.id
          where c.id = ${tasks.contactId} and i.user_id = c.owner_id and i.occurred_at >= c.owner_assigned_at
        )`,
      ),
    )
    .returning({ id: tasks.id });
  const obsolete = await t
    .update(tasks)
    .set({ status: "dismissed", completedAt: now })
    .where(
      and(
        eq(tasks.type, "untouched_lead"),
        eq(tasks.status, "open"),
        // only tasks this rule raised (they record the assignment they were about)
        sql`(${tasks.payload}->>'assignedAt') is not null`,
        sql`not exists (
          select 1 from contacts c
          where c.id = ${tasks.contactId}
            and c.merged_into_id is null
            and c.owner_id is not null
            and c.owner_id = ${tasks.userId}
            and c.purchase_count = 0
            and c.stage <> 'lost'
            and date_trunc('milliseconds', c.owner_assigned_at) = (${tasks.payload}->>'assignedAt')::timestamptz
        )`,
      ),
    )
    .returning({ id: tasks.id });
  return answered.length + obsolete.length;
}

// ---------------------------------------------------------------------------
// Lead released (ownership rule 4) — owned by the contacts module
// ---------------------------------------------------------------------------

/**
 * "Use it or lose it": open leads with no interaction for thresholds.leadReleaseDays return to the pool.
 * At most RELEASE_BATCH per run; the next run (15 minutes later) continues with the rest.
 */
export async function releaseStaleLeads(now: Date, tx: Tx = db): Promise<{ released: number }> {
  const ids = await releaseStaleLeadsService(now, tx, { limit: RELEASE_BATCH });
  return { released: ids.length };
}

// ---------------------------------------------------------------------------
// Follow-up due
// ---------------------------------------------------------------------------

/**
 * Follow-ups are already Today tasks. This only pings the assignee in-app once, when the follow-up's time
 * arrives (within the last day: older ones are already overdue on Today).
 */
export async function followUpsDue(now: Date, tx: Tx = db): Promise<{ notified: number }> {
  const rows = await tx
    .select({
      id: tasks.id,
      userId: tasks.userId,
      reason: tasks.reason,
      contactId: tasks.contactId,
      contactName: contacts.name,
    })
    .from(tasks)
    .innerJoin(users, and(eq(users.id, tasks.userId), eq(users.active, true)))
    .leftJoin(contacts, eq(contacts.id, tasks.contactId))
    .where(
      and(
        eq(tasks.type, "follow_up"),
        eq(tasks.status, "open"),
        lte(tasks.dueAt, now),
        gt(tasks.dueAt, new Date(now.getTime() - FOLLOW_UP_PING_WINDOW_MS)),
        or(isNull(tasks.contactId), isNull(contacts.mergedIntoId)),
        sql`not exists (
          select 1 from notifications n where n.dedupe_key = 'follow_up_due:' || ${tasks.id}::text || ':' || ${tasks.userId}::text
        )`,
      ),
    )
    .orderBy(asc(tasks.dueAt))
    .limit(BATCH);
  const notified = await notify(
    rows.map((r) => ({
      userId: r.userId!,
      type: "follow_up_due",
      title: r.contactName ? `Follow-up due: ${r.contactName}` : "Follow-up due",
      body: r.reason,
      contactId: r.contactId,
      taskId: r.id,
      dedupeKey: `follow_up_due:${r.id}`,
    })),
    tx,
  );
  return { notified };
}

// ---------------------------------------------------------------------------
// Repeat purchase: due for next rung, at risk
// ---------------------------------------------------------------------------

/**
 * Closes open next-rung and at-risk tasks once the customer has bought again since the task was raised
 * (their last purchase moved past the one recorded on the task).
 */
export async function closeRepurchasedTasks(now: Date, tx: Tx = db): Promise<{ closed: number }> {
  const rows = await tx
    .update(tasks)
    .set({ status: "done", completedAt: now })
    .where(
      and(
        inArray(tasks.type, ["next_rung", "at_risk"]),
        eq(tasks.status, "open"),
        // only tasks these rules raised (they record the purchase cycle they were about)
        sql`(${tasks.payload}->>'lastPurchaseAt') is not null`,
        sql`exists (
          select 1 from contacts c
          where c.id = ${tasks.contactId}
            and c.last_purchase_at > (${tasks.payload}->>'lastPurchaseAt')::timestamptz + interval '1 millisecond'
        )`,
      ),
    )
    .returning({ id: tasks.id });
  return { closed: rows.length };
}

/**
 * Existing tasks of one type for a page of contacts, as a set of keys: "<contactId>" when `part` is null, else
 * "<contactId>|<epoch ms of the part's timestamp>".
 */
async function contactTaskKeys(
  contactIds: string[],
  type: string,
  part: ReturnType<typeof sql> | null,
  tx: Tx,
  opts: { openOnly?: boolean } = {},
): Promise<Set<string>> {
  if (!contactIds.length) return new Set();
  const rows = await tx.execute<{ contact_id: string; part: string | null }>(sql`
    select t.contact_id, ${part ?? sql`null`} as part
    from tasks t
    where t.contact_id = any(${`{${contactIds.join(",")}}`}::uuid[])
      and t.type = ${type}
      ${opts.openOnly ? sql`and t.status = 'open'` : sql``}
  `);
  const out = new Set<string>();
  for (const r of rows) {
    if (part === null) out.add(r.contact_id);
    else if (r.part) {
      const ms = new Date(r.part).getTime();
      if (Number.isFinite(ms)) out.add(`${r.contact_id}|${ms}`);
    }
  }
  return out;
}

/** Customer rows for the repeat-purchase rules, page by page (keyset on id). */
async function* customerPages(where: ReturnType<typeof and>, tx: Tx) {
  let after: string | null = null;
  for (;;) {
    const page = await tx
      .select({
        id: contacts.id,
        name: contacts.name,
        ownerId: contacts.ownerId,
        phoneCountry: contacts.phoneCountry,
        nextExpectedAt: contacts.nextExpectedAt,
        nextOffer: contacts.nextOffer,
        lastPurchaseAt: contacts.lastPurchaseAt,
        ...ownerCols,
      })
      .from(contacts)
      .leftJoin(owner, eq(owner.id, contacts.ownerId))
      .where(after ? and(where, gt(contacts.id, after)) : where)
      .orderBy(asc(contacts.id))
      .limit(1000);
    if (!page.length) return;
    yield page;
    after = page[page.length - 1].id;
  }
}

/**
 * "Within 7 days of the expected next purchase -> owner, Today." Customers whose next_expected_at falls within
 * thresholds.nextRungDays days of now (either side, so a nightly run that missed a day still catches them) and
 * who are not yet at risk get one "next_rung" task with the next best offer. One per purchase cycle: no second
 * task until they buy again (deduped on contact + expected date, and on the last purchase recorded on the task).
 */
export async function dueForNextRung(now: Date, tx: Tx = db): Promise<{ created: number }> {
  const th = await getSetting("thresholds", tx);
  const days = Number(th.nextRungDays);
  if (!Number.isFinite(days) || days < 0) return { created: 0 };
  const w = await wording(tx);
  const where = and(
    isNull(contacts.mergedIntoId),
    gt(contacts.purchaseCount, 0),
    ne(contacts.stage, "lost"),
    eq(contacts.atRisk, false),
    isNotNull(contacts.lastPurchaseAt),
    sql`${contacts.nextExpectedAt} between ${new Date(now.getTime() - days * DAY_MS).toISOString()}::timestamptz
      and ${new Date(now.getTime() + days * DAY_MS).toISOString()}::timestamptz`,
  );
  let created = 0;
  return inTx(tx, async (t) => {
    for await (const all of customerPages(where, t)) {
      // One task per purchase cycle. Checked per page with an indexed lookup rather than a correlated NOT EXISTS:
      // after a big import the planner's statistics on tasks are stale and the correlated form degrades badly.
      const seen = await contactTaskKeys(
        all.map((c) => c.id),
        "next_rung",
        sql`(t.payload->>'lastPurchaseAt')`,
        t,
      );
      const page = all.filter((c) => !seen.has(`${c.id}|${c.lastPurchaseAt!.getTime()}`));
      const list: NewTask[] = page.map((c) => {
        const { userId, tz } = routeTo(c, w);
        const expected = c.nextExpectedAt!;
        return {
          contactId: c.id,
          userId,
          type: "next_rung",
          reason: c.nextOffer ? `Due for the next rung: offer ${c.nextOffer}` : "Due to buy again: check what fits next",
          dueAt: now,
          dedupeKey: `next_rung:${c.id}:${expected.toISOString().slice(0, 10)}`,
          payload: {
            expectedAt: expected.toISOString(),
            expectedLabel: shortDate(expected, now, tz),
            nextOffer: c.nextOffer,
            lastPurchaseAt: c.lastPurchaseAt!.toISOString(),
          },
        };
      });
      created += (await createTasks(list, t)).length;
    }
    return { created };
  });
}

/**
 * "30 days past the expected next purchase -> owner, Today." Customers flagged at_risk (by the metrics module,
 * thresholds.atRiskDays) get an "at_risk" task with the next best offer, at most once a month and never while an
 * earlier at-risk task for them is still open. Dormant customers are left out (see below).
 */
export async function atRisk(now: Date, tx: Tx = db): Promise<{ created: number }> {
  const w = await wording(tx);
  const month = monthKey(now, BUSINESS_TZ);
  const where = and(
    isNull(contacts.mergedIntoId),
    gt(contacts.purchaseCount, 0),
    ne(contacts.stage, "lost"),
    // Dormant customers (no activity for thresholds.dormantDays) stay in the dashboard's at-risk pool but get no
    // call task: after the history import they would bury Today. Grade A ones are covered by "VIP gone quiet".
    ne(contacts.stage, "dormant"),
    eq(contacts.atRisk, true),
    isNotNull(contacts.lastPurchaseAt),
  );
  let created = 0;
  return inTx(tx, async (t) => {
    for await (const all of customerPages(where, t)) {
      // never while an earlier at-risk task is still open (indexed lookup per page; see dueForNextRung)
      const open = await contactTaskKeys(all.map((c) => c.id), "at_risk", null, t, { openOnly: true });
      const page = all.filter((c) => !open.has(c.id));
      const list: NewTask[] = page.map((c) => {
        const { userId } = routeTo(c, w);
        const past = c.nextExpectedAt ? wholeDaysBetween(c.nextExpectedAt, now) : null;
        const lead = past !== null ? `At risk: ${past} days past the expected next purchase` : "At risk: overdue for a repeat purchase";
        return {
          contactId: c.id,
          userId,
          type: "at_risk",
          reason: c.nextOffer ? `${lead} — offer ${c.nextOffer}` : lead,
          dueAt: now,
          dedupeKey: `at_risk:${c.id}:${month}`,
          payload: {
            expectedAt: c.nextExpectedAt?.toISOString() ?? null,
            nextOffer: c.nextOffer,
            lastPurchaseAt: c.lastPurchaseAt!.toISOString(),
          },
        };
      });
      created += (await createTasks(list, t)).length;
    }
    return { created };
  });
}

// ---------------------------------------------------------------------------
// Instalment due
// ---------------------------------------------------------------------------

export type InstalmentResult = { dueTasks: number; overdueTasks: number; notified: number };

/**
 * "An EMI is due in 3 days or overdue -> owner and manager, in-app." Scheduled instalments due within
 * thresholds.instalmentDueDays, or already overdue, on live purchases:
 * - due soon: an "instalment_due" task for the owner (or the pool) and an in-app alert to the owner and managers;
 * - overdue: the same task is reworded (or, if it was already closed, a new one is raised) and a second alert goes
 *   out. Deduped per payment and stage. The money module closes these when the instalment is paid.
 */
export async function instalmentsDue(now: Date, tx: Tx = db): Promise<InstalmentResult> {
  const th = await getSetting("thresholds", tx);
  const days = Math.max(0, Number(th.instalmentDueDays) || 0);
  const horizon = new Date(now.getTime() + days * DAY_MS);
  const nowIso = now.toISOString();
  const w = await wording(tx);
  const result: InstalmentResult = { dueTasks: 0, overdueTasks: 0, notified: 0 };

  return inTx(tx, async (t) => {
    const rows = await t
      .select({
        id: payments.id,
        seq: payments.seq,
        amount: payments.amount,
        currency: payments.currency,
        dueAt: payments.dueAt,
        purchaseId: payments.purchaseId,
        productName: purchases.productName,
        count: sql<number>`(select count(*) from payments p2 where p2.purchase_id = ${payments.purchaseId} and p2.kind = 'payment')`.mapWith(Number),
        contactId: contacts.id,
        contactName: contacts.name,
        ownerId: contacts.ownerId,
        phoneCountry: contacts.phoneCountry,
        ...ownerCols,
      })
      .from(payments)
      .innerJoin(purchases, eq(purchases.id, payments.purchaseId))
      .innerJoin(contacts, eq(contacts.id, payments.contactId))
      .leftJoin(owner, eq(owner.id, contacts.ownerId))
      .where(
        and(
          eq(payments.kind, "payment"),
          eq(payments.status, "scheduled"),
          isNotNull(payments.dueAt),
          lte(payments.dueAt, horizon),
          sql`${purchases.status} not in ('cancelled', 'refunded')`,
          isNull(contacts.mergedIntoId),
          sql`not exists (
            select 1 from tasks t
            where t.dedupe_key = case when ${payments.dueAt} < ${nowIso}::timestamptz
              then 'instalment_due:' || ${payments.id}::text || ':overdue'
              else 'instalment_due:' || ${payments.id}::text end
          )`,
        ),
      )
      .orderBy(asc(payments.dueAt), asc(payments.id))
      .limit(BATCH);
    if (!rows.length) return result;
    const managers = await managerIds(t);
    const alerts: NewNotification[] = [];

    for (const p of rows) {
      const { userId, tz } = routeTo(p, w);
      const overdue = p.dueAt!.getTime() < now.getTime();
      const what = `Instalment ${p.seq}${p.count > 1 ? ` of ${p.count}` : ""} (${money(p.amount, p.currency)}) for ${p.productName}`;
      const date = shortDate(p.dueAt!, now, tz);
      const reason = overdue ? `${what} was due on ${date} and is unpaid` : `${what} is due on ${date}`;
      const baseKey = `instalment_due:${p.id}`;
      const payload = { paymentId: p.id, purchaseId: p.purchaseId, dueAt: p.dueAt!.toISOString(), stage: overdue ? "overdue" : "due" };
      let taskId: string | null = null;
      if (overdue) {
        // the due-soon task still open: reword it rather than adding a second row for the same instalment
        const [openDue] = await t
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.dedupeKey, baseKey), eq(tasks.status, "open")))
          .limit(1);
        if (openDue) {
          await t
            .update(tasks)
            .set({ dedupeKey: `${baseKey}:overdue`, reason, payload, dueAt: now, userId })
            .where(eq(tasks.id, openDue.id));
          taskId = openDue.id;
        } else {
          taskId = await createTask(
            { contactId: p.contactId, userId, type: "instalment_due", reason, dueAt: now, dedupeKey: `${baseKey}:overdue`, payload },
            t,
          );
        }
        if (taskId) result.overdueTasks += 1;
      } else {
        taskId = await createTask(
          { contactId: p.contactId, userId, type: "instalment_due", reason, dueAt: now, dedupeKey: baseKey, payload },
          t,
        );
        if (taskId) result.dueTasks += 1;
      }
      for (const u of unique([userId, ...managers].filter((x): x is string => !!x))) {
        alerts.push({
          userId: u,
          type: "instalment_due",
          title: `${overdue ? "Instalment overdue" : "Instalment due"}: ${p.contactName}`,
          body: reason,
          contactId: p.contactId,
          taskId,
          dedupeKey: overdue ? `instalment_overdue:${p.id}` : `instalment_due:${p.id}`,
        });
      }
    }
    result.notified = (await notifyNew(alerts, t)).created;
    return result;
  });
}

// ---------------------------------------------------------------------------
// Unverified payment
// ---------------------------------------------------------------------------

/**
 * "A manual payment unverified after 2 days -> manager, email." Payments still unverified
 * thresholds.unverifiedPaymentDays after they were paid (or recorded) raise one alert per manager, sent by email
 * (see sendPendingNotificationEmails). Deduped per payment; payments already alerted are skipped in SQL.
 * Returns how many payments were alerted in this run and how many alerts that made.
 */
export async function unverifiedPayments(now: Date, tx: Tx = db): Promise<{ payments: number; notified: number }> {
  const th = await getSetting("thresholds", tx);
  const days = Math.max(0, Number(th.unverifiedPaymentDays) || 0);
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const recorder = alias(users, "alert_recorder");
  const since = sql<Date>`coalesce(${payments.paidAt}, ${payments.createdAt})`;
  const rows = await tx
    .select({
      id: payments.id,
      amount: payments.amount,
      currency: payments.currency,
      paidAt: payments.paidAt,
      createdAt: payments.createdAt,
      mode: payments.mode,
      reference: payments.reference,
      productName: purchases.productName,
      contactId: contacts.id,
      contactName: contacts.name,
      recordedBy: recorder.name,
    })
    .from(payments)
    .innerJoin(purchases, eq(purchases.id, payments.purchaseId))
    .innerJoin(contacts, eq(contacts.id, payments.contactId))
    .leftJoin(recorder, eq(recorder.id, payments.createdById))
    .where(
      and(
        eq(payments.kind, "payment"),
        eq(payments.status, "unverified"),
        sql`${since} <= ${cutoff.toISOString()}::timestamptz`,
        ne(purchases.status, "cancelled"),
        isNull(contacts.mergedIntoId),
        // already alerted: skipped here so a backlog older than one batch cannot starve newer payments
        sql`not exists (
          select 1 from notifications n
          where n.contact_id = ${payments.contactId} and n.type = 'unverified_payment'
            and n.dedupe_key like 'unverified_payment:' || ${payments.id}::text || ':%'
        )`,
      ),
    )
    .orderBy(asc(since), asc(payments.id))
    .limit(BATCH);
  if (!rows.length) return { payments: 0, notified: 0 };
  const managers = await managerIds(tx);
  const alerts: NewNotification[] = [];
  for (const p of rows) {
    const waiting = wholeDaysBetween(p.paidAt ?? p.createdAt, now);
    const bits = [
      p.productName,
      [p.mode ? MODE_LABELS[p.mode] : null, p.reference ? `ref ${p.reference}` : null].filter(Boolean).join(" "),
      p.recordedBy ? `recorded by ${p.recordedBy}` : null,
      `waiting ${waiting} day${waiting === 1 ? "" : "s"} for verification`,
    ].filter(Boolean);
    for (const m of managers) {
      alerts.push({
        userId: m,
        type: "unverified_payment",
        title: `Verify ${money(p.amount, p.currency)} from ${p.contactName}`,
        body: bits.join(" · "),
        contactId: p.contactId,
        email: true,
        dedupeKey: `unverified_payment:${p.id}`,
      });
    }
  }
  const { created } = await notifyNew(alerts, tx);
  return { payments: rows.length, notified: created };
}

// ---------------------------------------------------------------------------
// VIP gone quiet
// ---------------------------------------------------------------------------

/**
 * "A grade A customer with no activity for 120 days -> owner and Umer, email digest." Raises an in-app alert
 * (type vip_quiet) for the owner and for Umer (every admin plus settings digest.weeklyRecipients); the daily
 * digest email lists them, and the Monday summary carries the full list. Once per contact per quarter.
 */
export async function vipGoneQuiet(now: Date, tx: Tx = db): Promise<{ contacts: number; notified: number }> {
  const th = await getSetting("thresholds", tx);
  const days = Number(th.vipQuietDays);
  if (!Number.isFinite(days) || days <= 0) return { contacts: 0, notified: 0 };
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const quarter = quarterKey(now, BUSINESS_TZ);
  const lastSeen = sql<Date>`coalesce(${contacts.lastActivityAt}, ${contacts.lastPurchaseAt}, ${contacts.createdAt})`;
  const rows = await tx
    .select({
      id: contacts.id,
      name: contacts.name,
      ownerId: contacts.ownerId,
      ltvInr: contacts.ltvInr,
      nextOffer: contacts.nextOffer,
      lastActivityAt: contacts.lastActivityAt,
      lastPurchaseAt: contacts.lastPurchaseAt,
      createdAt: contacts.createdAt,
      ...ownerCols,
    })
    .from(contacts)
    .leftJoin(owner, eq(owner.id, contacts.ownerId))
    .where(
      and(
        isNull(contacts.mergedIntoId),
        eq(contacts.grade, "A"),
        gt(contacts.purchaseCount, 0),
        ne(contacts.stage, "lost"),
        sql`${lastSeen} <= ${cutoff.toISOString()}::timestamptz`,
        // already alerted this quarter: skipped so the batch only holds VIPs with something left to raise
        sql`not exists (
          select 1 from notifications n
          where n.contact_id = ${contacts.id} and n.type = 'vip_quiet'
            and n.dedupe_key like 'vip_quiet:' || ${contacts.id}::text || ${`:${quarter}:`} || '%'
        )`,
      ),
    )
    .orderBy(desc(contacts.ltvInr), asc(contacts.id))
    .limit(4 * BATCH);
  if (!rows.length) return { contacts: 0, notified: 0 };
  const umer = (await umerRecipients(tx)).map((r) => r.userId).filter((x): x is string => !!x);
  const alerts: NewNotification[] = [];
  for (const c of rows) {
    const last = c.lastActivityAt ?? c.lastPurchaseAt ?? c.createdAt;
    const quiet = wholeDaysBetween(last, now);
    const ownerId = assigneeFor({ id: c.ownerId, active: c.ownerActive, role: c.ownerRole });
    const body = [`Grade A customer`, `LTV ${formatINR(c.ltvInr)}`, `no activity for ${quiet} days`, c.nextOffer ? `offer ${c.nextOffer}` : null]
      .filter(Boolean)
      .join(" · ");
    for (const u of unique([ownerId, ...umer].filter((x): x is string => !!x))) {
      alerts.push({
        userId: u,
        type: "vip_quiet",
        title: `VIP gone quiet: ${c.name}`,
        body,
        contactId: c.id,
        dedupeKey: `vip_quiet:${c.id}:${quarter}`,
      });
    }
  }
  const { created, fresh } = await notifyNew(alerts, tx);
  return { contacts: new Set(fresh.map((a) => a.contactId)).size, notified: created };
}

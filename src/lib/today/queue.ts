import "server-only";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { contacts, tasks, users, type Role, type Stage } from "@/db/schema";
import { can } from "@/lib/auth/permissions";
import { getSettings } from "@/lib/settings";
import { buildQueue, type BuiltQueue, type QueueTask } from "./rank";
import { localDayEnd, localDayStart, validTimeZone } from "./time";

/**
 * The Today queue (spec "Alerts and the Today queue"): one ranked list per person, capped at
 * settings thresholds.todayCap. The ranking rules live in ./rank.ts (pure); this file only loads tasks.
 *
 * Sources: the user's OPEN tasks due before the end of their local today (follow-ups, abandoned checkouts,
 * new advocates, next rung, at risk, hot / new / untouched leads, instalments due, and for managers transfer
 * requests and released leads), plus — for salespeople — pool tasks (no assignee) on pool contacts of their
 * team: GCC phone numbers belong to settings assignment.gccTeam, every other number to defaultTeam. A
 * salesperson with no team sees the whole pool; one in any other team sees none of it.
 *
 * Also derived (no stored task): the user's NEW LEADS — open leads assigned to them within the last
 * thresholds.untouchedOwnerHours with no call or message logged since. The alerts engine only raises an
 * "untouched_lead" task after that window, so without this a fresh lead would not reach Today for a day.
 *
 * Visibility: a salesperson's own tasks only show for contacts they can still see (their own or the pool), so a
 * follow-up left behind on a contact that has since moved to a colleague never leaks its name or number.
 *
 * Bounded queries: tasks are fetched in ranking order (the same bands and score as ./rank.ts, in SQL) with a
 * safety limit, so when someone holds thousands of open tasks the limit drops the lowest-ranked ones, never an
 * abandoned checkout or an overdue follow-up. The total ("left out") is then counted in SQL.
 */

export type QueueUser = { id: string; role: Role; team: string | null; timezone: string | null };

export type TodayQueue = BuiltQueue & { timeZone: string };

export type TeamQueueGroup = {
  /** null = the pool */
  userId: string | null;
  name: string;
  role: Role | null;
  active: boolean;
  queue: TodayQueue;
};

/** Safety bound on tasks loaded for one ranking (they come in ranking order, so only the tail is dropped). */
const FETCH_LIMIT = 2000;
/** Team view: at most this many tasks per person (and for the pool), again in ranking order. */
const TEAM_PER_GROUP_LIMIT = 400;
/** Derived new-lead rows loaded per ranking. */
const NEW_LEAD_LIMIT = 500;

type TaskRow = {
  id: string;
  type: QueueTask["type"];
  reason: string;
  dueAt: Date;
  priority: number;
  createdAt: Date;
  userId: string | null;
  contactId: string | null;
  contactName: string | null;
  phoneE164: string | null;
  phoneCountry: string | null;
  ownerId: string | null;
  grade: "A" | "B" | "C" | "D" | null;
  edaptScore: number | null;
  stage: Stage | null;
  nextOffer: string | null;
  purchaseCount: number | null;
  expected90dInr: number | null;
  nextExpectedAt: Date | null;
  lastEnquiryAt: Date | null;
};

function toQueueTask(r: TaskRow): QueueTask {
  return {
    id: r.id,
    type: r.type,
    reason: r.reason,
    dueAt: r.dueAt,
    priority: r.priority,
    createdAt: r.createdAt,
    userId: r.userId,
    contact:
      r.contactId && r.contactName !== null && r.phoneE164 !== null && r.stage
        ? {
            id: r.contactId,
            name: r.contactName,
            phoneE164: r.phoneE164,
            phoneCountry: r.phoneCountry,
            ownerId: r.ownerId,
            grade: r.grade,
            edaptScore: r.edaptScore,
            stage: r.stage,
            nextOffer: r.nextOffer,
            purchaseCount: r.purchaseCount ?? 0,
            expected90dInr: r.expected90dInr === null ? null : Number(r.expected90dInr),
            nextExpectedAt: r.nextExpectedAt,
            lastEnquiryAt: r.lastEnquiryAt,
          }
        : null,
  };
}

/** Open tasks whose contact (if any) is still live. */
const liveOpen = (): SQL => and(eq(tasks.status, "open"), or(isNull(tasks.contactId), isNull(contacts.mergedIntoId)))!;

/**
 * The ranking of ./rank.ts in SQL (used to ORDER the fetch so a safety limit only drops the tail):
 * band (abandoned checkout, follow-up or task due before `overdueBefore`, the rest), then the combined score
 * (customers: 20 x log10(1 + expected 90-day revenue) up to 100; otherwise the Edapt Score), then priority and
 * due date. Keep in step with rankScore() / compareRanked() in ./rank.ts.
 */
function rankOrder(overdueBefore: Date): SQL[] {
  const band = sql`case when ${tasks.type} = 'abandoned_checkout' then 0 when ${tasks.type} in ('follow_up', 'task') and ${tasks.dueAt} < ${overdueBefore.toISOString()}::timestamptz then 1 else 2 end`;
  // float8, not numeric: log() of a numeric is computed to full precision and made this sort ~10x slower
  // (docs/PERFORMANCE.md); rank.ts uses a JS double for the same score anyway
  const score = sql`case when coalesce(${contacts.purchaseCount}, 0) > 0 and ${contacts.expected90dInr} is not null then least(100, 20 * log(1 + greatest(${contacts.expected90dInr}, 0)::float8)) else coalesce(${contacts.edaptScore}, 0) end`;
  return [band, sql`${score} desc`, desc(tasks.priority), asc(tasks.dueAt), asc(tasks.createdAt), asc(tasks.id)];
}

/** The Today row a task lands on (one per contact; transfer requests and contactless tasks on their own). */
const rowKeySql = sql`case when ${tasks.contactId} is null or ${tasks.type} = 'transfer_request' then 'task:' || ${tasks.id}::text else ${tasks.contactId}::text end`;

/** A ranked task row as the raw query returns it (bigint and numeric arrive as strings). */
type TeamTaskRaw = {
  id: string;
  type: QueueTask["type"];
  reason: string;
  due_at: Date | string;
  priority: number;
  created_at: Date | string;
  user_id: string | null;
  contact_id: string | null;
  contact_name: string | null;
  phone_e164: string | null;
  phone_country: string | null;
  owner_id: string | null;
  grade: TaskRow["grade"];
  edapt_score: number | null;
  stage: Stage | null;
  next_offer: string | null;
  purchase_count: number | null;
  expected_90d_inr: string | number | null;
  next_expected_at: Date | string | null;
  last_enquiry_at: Date | string | null;
  rn: string | number;
  group_rows: string | number;
};

const asDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));
const asDateOrNull = (v: Date | string | null) => (v === null ? null : asDate(v));

function fromRaw(r: TeamTaskRaw): TaskRow {
  return {
    id: r.id,
    type: r.type,
    reason: r.reason,
    dueAt: asDate(r.due_at),
    priority: Number(r.priority),
    createdAt: asDate(r.created_at),
    userId: r.user_id,
    contactId: r.contact_id,
    contactName: r.contact_name,
    phoneE164: r.phone_e164,
    phoneCountry: r.phone_country,
    ownerId: r.owner_id,
    grade: r.grade,
    edaptScore: r.edapt_score === null ? null : Number(r.edapt_score),
    stage: r.stage,
    nextOffer: r.next_offer,
    purchaseCount: r.purchase_count === null ? null : Number(r.purchase_count),
    expected90dInr: r.expected_90d_inr === null ? null : Number(r.expected_90d_inr),
    nextExpectedAt: asDateOrNull(r.next_expected_at),
    lastEnquiryAt: asDateOrNull(r.last_enquiry_at),
  };
}

/** The pool tasks a salesperson sees: no assignee, contact in the pool (or theirs), contact in their team. */
function poolCondition(
  user: QueueUser,
  assignment: { gccCountries: string[]; gccTeam: string; defaultTeam: string },
): SQL | undefined {
  if (user.role !== "sales") return undefined;
  const base = and(
    isNull(tasks.userId),
    isNotNull(tasks.contactId),
    or(isNull(contacts.ownerId), eq(contacts.ownerId, user.id)),
  )!;
  if (!user.team) return base;
  const gcc = assignment.gccCountries.map((c) => c.toUpperCase());
  const isGcc: SQL = gcc.length
    ? sql`upper(coalesce(${contacts.phoneCountry}, '')) in (${sql.join(gcc.map((c) => sql`${c}`), sql`, `)})`
    : sql`false`;
  const inGccTeam = user.team === assignment.gccTeam;
  const inDefaultTeam = user.team === assignment.defaultTeam;
  if (inGccTeam && inDefaultTeam) return base;
  if (inGccTeam) return and(base, isGcc);
  if (inDefaultTeam) return and(base, sql`not (${isGcc})`);
  return undefined;
}

/** The user's own tasks; for anyone who cannot see every contact, only on contacts they can still see. */
function ownCondition(user: QueueUser): SQL {
  const mine = eq(tasks.userId, user.id);
  if (can(user, "contacts.viewAll")) return mine;
  return and(mine, or(isNull(tasks.contactId), isNull(contacts.ownerId), eq(contacts.ownerId, user.id)))!;
}

/** Hours a freshly assigned lead shows on Today as a derived "new lead" row (then the untouched alert takes over). */
function newLeadWindowHours(th: { untouchedOwnerHours: number; leadReleaseDays: number }): number {
  const h = Number(th.untouchedOwnerHours);
  if (Number.isFinite(h) && h > 0) return h;
  const d = Number(th.leadReleaseDays);
  return Number.isFinite(d) && d > 0 ? d * 24 : 24;
}

/**
 * Derived rows: open leads (no purchase, not Lost) owned by these users, assigned within the window, with no
 * interaction logged by the owner since the assignment (the same test as the untouched-lead alert).
 */
async function loadNewLeads(ownerIds: string[], now: Date, windowHours: number, tx: Tx): Promise<QueueTask[]> {
  if (!ownerIds.length) return [];
  const since = new Date(now.getTime() - windowHours * 3600_000);
  const rows = await tx
    .select({
      assignedAt: contacts.ownerAssignedAt,
      contactId: contacts.id,
      contactName: contacts.name,
      phoneE164: contacts.phoneE164,
      phoneCountry: contacts.phoneCountry,
      ownerId: contacts.ownerId,
      grade: contacts.grade,
      edaptScore: contacts.edaptScore,
      stage: contacts.stage,
      nextOffer: contacts.nextOffer,
      purchaseCount: contacts.purchaseCount,
      expected90dInr: contacts.expected90dInr,
      nextExpectedAt: contacts.nextExpectedAt,
      lastEnquiryAt: contacts.lastEnquiryAt,
    })
    .from(contacts)
    .where(
      and(
        inArray(contacts.ownerId, ownerIds),
        isNull(contacts.mergedIntoId),
        eq(contacts.purchaseCount, 0),
        ne(contacts.stage, "lost"),
        gt(contacts.ownerAssignedAt, since),
        lt(contacts.ownerAssignedAt, now),
        sql`not exists (select 1 from purchases p where p.contact_id = ${contacts.id} and p.status <> 'cancelled')`,
        sql`not exists (
          select 1 from interactions i
          where i.contact_id = ${contacts.id} and i.user_id = ${contacts.ownerId} and i.occurred_at >= ${contacts.ownerAssignedAt}
        )`,
        // snoozed: an open task of theirs on this contact moved to a later day takes the person off Today until
        // then (otherwise Snooze on an abandoned checkout would bring the same person straight back as a new lead)
        sql`not exists (
          select 1 from tasks st
          where st.contact_id = ${contacts.id} and st.status = 'open'
            and (st.user_id = ${contacts.ownerId} or st.user_id is null)
            and st.due_at > ${now.toISOString()}::timestamptz
        )`,
      ),
    )
    .orderBy(desc(sql`coalesce(${contacts.edaptScore}, 0)`), desc(contacts.ownerAssignedAt), asc(contacts.id))
    .limit(NEW_LEAD_LIMIT);
  return rows.map((r) => {
    const hot = r.grade === "A";
    return {
      id: `lead:${r.contactId}`,
      synthetic: true,
      type: hot ? "hot_lead" : "new_lead",
      // neutral wording: the team view shows the same row to managers
      reason: hot
        ? "Hot lead: no call or message logged since it was assigned"
        : "New lead: no call or message logged since it was assigned",
      dueAt: r.assignedAt!,
      priority: hot ? 1 : 0,
      createdAt: r.assignedAt!,
      userId: r.ownerId,
      contact: {
        id: r.contactId,
        name: r.contactName,
        phoneE164: r.phoneE164,
        phoneCountry: r.phoneCountry,
        ownerId: r.ownerId,
        grade: r.grade,
        edaptScore: r.edaptScore,
        stage: r.stage,
        nextOffer: r.nextOffer,
        purchaseCount: r.purchaseCount ?? 0,
        expected90dInr: r.expected90dInr === null ? null : Number(r.expected90dInr),
        nextExpectedAt: r.nextExpectedAt,
        lastEnquiryAt: r.lastEnquiryAt,
      },
    } satisfies QueueTask;
  });
}

/**
 * Open tasks with their contact in ranking order, in ONE pass (docs/PERFORMANCE.md): at most `limit` tasks (per
 * assignee when `perUser`), each with its rank (rn) and the number of Today rows all of its group's tasks make
 * (group_rows: distinct row keys, counted with dense_rank before the limit), so a cut queue still reports its
 * true size without a second scan of tasks and contacts.
 */
function loadRankedTasks(tx: Tx, where: SQL, order: SQL[], opts: { perUser: boolean; limit: number }) {
  const partition = opts.perUser ? sql`partition by ${tasks.userId}` : sql``;
  const groupPartition = opts.perUser ? sql`partition by uid` : sql``;
  // ranked on narrow rows (id, assignee, rank), then the kept tasks are joined back to their columns: the window
  // sorts then move a few bytes per task instead of the whole row
  return tx.execute<TeamTaskRaw>(sql`
    with ranked as (
      select ${tasks.id} as task_id, ${tasks.userId} as uid,
        row_number() over (${partition} order by ${sql.join(order, sql`, `)}) as rn,
        dense_rank() over (${partition} order by ${rowKeySql}) as row_key_rank
      from ${tasks} left join ${contacts} on ${contacts.id} = ${tasks.contactId}
      where ${where}
    ), counted as (
      select task_id, uid, rn, max(row_key_rank) over (${groupPartition}) as group_rows from ranked
    )
    select ${tasks.id} as id, ${tasks.type} as type, ${tasks.reason} as reason, ${tasks.dueAt} as due_at,
      ${tasks.priority} as priority, ${tasks.createdAt} as created_at, ${tasks.userId} as user_id,
      ${contacts.id} as contact_id, ${contacts.name} as contact_name, ${contacts.phoneE164} as phone_e164,
      ${contacts.phoneCountry} as phone_country, ${contacts.ownerId} as owner_id, ${contacts.grade} as grade,
      ${contacts.edaptScore} as edapt_score, ${contacts.stage} as stage, ${contacts.nextOffer} as next_offer,
      ${contacts.purchaseCount} as purchase_count, ${contacts.expected90dInr} as expected_90d_inr,
      ${contacts.nextExpectedAt} as next_expected_at, ${contacts.lastEnquiryAt} as last_enquiry_at,
      counted.rn, counted.group_rows
    from counted
      join ${tasks} on ${tasks.id} = counted.task_id
      left join ${contacts} on ${contacts.id} = ${tasks.contactId}
    where counted.rn <= ${opts.limit}
    order by counted.uid, counted.rn`);
}

/** Row count when the fetch hit its limit: what the cap really left out. */
function withTrueTotal(queue: BuiltQueue, trueTotal: number | null): BuiltQueue {
  if (trueTotal === null || trueTotal <= queue.total) return queue;
  return { ...queue, total: trueTotal, leftOut: Math.max(0, trueTotal - queue.rows.length) };
}

/**
 * The ranked Today queue of one user at `now`, capped at settings thresholds.todayCap (or opts.cap),
 * with the number of rows left out and the counts by band.
 * `includePool: false` leaves the pool out (the team view shows the pool as its own group).
 */
export async function getTodayQueue(
  user: QueueUser,
  now: Date = new Date(),
  opts: { cap?: number; tx?: Tx; includePool?: boolean } = {},
): Promise<TodayQueue> {
  const tx = opts.tx ?? db;
  const s = await getSettings(["thresholds", "assignment"], tx);
  const timeZone = validTimeZone(user.timezone);
  const dayStart = localDayStart(now, timeZone);
  const dayEnd = localDayEnd(now, timeZone);
  const pool = opts.includePool === false ? undefined : poolCondition(user, s.assignment);
  const mine = ownCondition(user);
  const where = and(liveOpen(), lt(tasks.dueAt, dayEnd), pool ? or(mine, pool) : mine)!;
  const [raw, newLeads] = await Promise.all([
    loadRankedTasks(tx, where, rankOrder(dayStart), { perUser: false, limit: FETCH_LIMIT }),
    loadNewLeads([user.id], now, newLeadWindowHours(s.thresholds), tx),
  ]);
  const rows = raw.map(fromRaw);
  const trueTotal = raw.length >= FETCH_LIMIT ? Number(raw[0].group_rows) : null;
  const queue = buildQueue([...rows.map(toQueueTask), ...newLeads], {
    now,
    timeZone,
    cap: opts.cap ?? s.thresholds.todayCap,
    groupBy: "contact",
  });
  return { ...withTrueTotal(queue, trueTotal), timeZone };
}

/**
 * Team view for managers and admins: every person's queue (each in their own time zone, each capped), plus
 * the pool (in the viewer's time zone). The pool comes first, then people by name. A person's group is their
 * own work only (the pool is shown once, as its own group). One bounded query loads at most
 * TEAM_PER_GROUP_LIMIT tasks per person in ranking order, with each person's true row count.
 */
export async function getTeamQueues(
  viewer: QueueUser,
  now: Date = new Date(),
  opts: { cap?: number; tx?: Tx } = {},
): Promise<TeamQueueGroup[]> {
  if (viewer.role !== "admin" && viewer.role !== "manager") {
    throw new Error("Only managers and admins can see the team's queues");
  }
  const tx = opts.tx ?? db;
  const s = await getSettings(["thresholds"], tx);
  const cap = opts.cap ?? s.thresholds.todayCap;
  // the furthest "end of today" anywhere on earth is under 2 days away; each group then filters in its own zone
  const bound = new Date(now.getTime() + 2 * 86_400_000);
  const live = and(liveOpen(), lt(tasks.dueAt, bound))!;
  // in SQL every follow-up due before now counts as "overdue" for ordering: a superset of each zone's overdue
  const order = rankOrder(now);
  // One pass over the open tasks (docs/PERFORMANCE.md): each task's rank within its assignee (rn), and how many
  // Today rows the assignee's tasks make in all (group_rows, distinct row keys counted with dense_rank), so
  // groups cut at the per-person limit still report their true size without a second scan.
  const [rawRows, people] = await Promise.all([
    loadRankedTasks(tx, live, order, { perUser: true, limit: TEAM_PER_GROUP_LIMIT }),
    tx
      .select({ id: users.id, name: users.name, role: users.role, team: users.team, timezone: users.timezone, active: users.active })
      .from(users)
      .where(
        or(
          eq(users.active, true),
          sql`exists (select 1 from tasks t where t.user_id = ${users.id} and t.status = 'open' and t.due_at < ${bound.toISOString()}::timestamptz)`,
        ),
      ),
  ]);
  const newLeads = await loadNewLeads(
    people.map((p) => p.id),
    now,
    newLeadWindowHours(s.thresholds),
    tx,
  );

  const byUser = new Map<string | null, QueueTask[]>();
  const add = (k: string | null, t: QueueTask) => {
    const list = byUser.get(k);
    if (list) list.push(t);
    else byUser.set(k, [t]);
  };
  // groups that hit the per-person limit report their real row totals
  const trueTotals = new Map<string | null, number>();
  for (const r of rawRows) {
    add(r.user_id, toQueueTask(fromRaw(r)));
    if (Number(r.rn) >= TEAM_PER_GROUP_LIMIT) trueTotals.set(r.user_id, Number(r.group_rows));
  }
  for (const t of newLeads) add(t.userId, t);
  const viewerTz = validTimeZone(viewer.timezone);

  const groups: TeamQueueGroup[] = [];
  const poolTasks = byUser.get(null);
  if (poolTasks?.length) {
    const queue = withTrueTotal(
      buildQueue(poolTasks, { now, timeZone: viewerTz, cap, groupBy: "assignee" }),
      trueTotals.get(null) ?? null,
    );
    if (queue.total) groups.push({ userId: null, name: "Pool", role: null, active: true, queue: { ...queue, timeZone: viewerTz } });
  }
  for (const p of [...people].sort((a, b) => a.name.localeCompare(b.name))) {
    const list = byUser.get(p.id);
    if (!list?.length) continue;
    const timeZone = validTimeZone(p.timezone);
    const queue = withTrueTotal(buildQueue(list, { now, timeZone, cap, groupBy: "assignee" }), trueTotals.get(p.id) ?? null);
    if (!queue.total) continue;
    groups.push({ userId: p.id, name: p.name, role: p.role, active: p.active, queue: { ...queue, timeZone } });
  }
  return groups;
}

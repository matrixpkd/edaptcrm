import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/db";
import type { Role } from "@/db/schema";
import { isUuid } from "@/lib/utils";

/**
 * Team activity feed for managers and admins (/activity; beyond the spec, docs/CRM_GAP_ANALYSIS.md): what people did,
 * newest first. Only things a person did (the system's own webhooks and alerts are left out, they are not activity):
 *   - interaction  a call, WhatsApp, meeting, email, note or support issue logged
 *   - lead         a contact added by hand (Quick Add)
 *   - payment      a payment or refund recorded
 *   - verify       a bank / UPI payment verified (or rejected)
 *   - stage        a stage set by hand (Qualified, Lost, reopened)
 *   - owner        a contact reassigned, handed over or released
 *   - task         a task or follow-up done
 * Each source is read newest-first with its own limit, then merged, so the feed stays cheap however long the history.
 */

export const ACTIVITY_KINDS = ["interaction", "lead", "payment", "verify", "stage", "owner", "task"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Filter groups on the screen. */
export const ACTIVITY_FILTERS: { key: string; label: string; kinds: ActivityKind[] }[] = [
  { key: "all", label: "Everything", kinds: [...ACTIVITY_KINDS] },
  { key: "calls", label: "Calls and messages", kinds: ["interaction"] },
  { key: "leads", label: "Leads added", kinds: ["lead"] },
  { key: "money", label: "Payments", kinds: ["payment", "verify"] },
  { key: "pipeline", label: "Stages and owners", kinds: ["stage", "owner"] },
  { key: "tasks", label: "Tasks done", kinds: ["task"] },
];

export type ActivityItem = {
  kind: ActivityKind;
  id: string;
  at: Date;
  actorId: string | null;
  actorName: string | null;
  contactId: string | null;
  contactName: string | null;
  /** interaction type / payment kind / new stage / new owner name / task title */
  detail: string | null;
  /** interaction outcome / verification status / lost reason */
  extra: string | null;
  amountInr: number | null;
};

export const ACTIVITY_PAGE = 50;

type Raw = {
  kind: ActivityKind;
  id: string;
  at: Date | string;
  actor_id: string | null;
  actor_name: string | null;
  contact_id: string | null;
  contact_name: string | null;
  detail: string | null;
  extra: string | null;
  amount_inr: string | number | null;
};

export async function getActivityFeed(
  viewer: { role: Role },
  opts: { kinds?: ActivityKind[]; userId?: string | null; before?: Date | null; limit?: number; tx?: Tx } = {},
): Promise<{ items: ActivityItem[]; nextBefore: Date | null }> {
  if (viewer.role !== "admin" && viewer.role !== "manager") throw new Error("Only managers and admins see team activity");
  const tx = opts.tx ?? db;
  const limit = Math.min(Math.max(opts.limit ?? ACTIVITY_PAGE, 1), 200);
  const kinds = new Set(opts.kinds?.length ? opts.kinds : ACTIVITY_KINDS);
  const userId = opts.userId && isUuid(opts.userId) ? opts.userId : null;
  const before = opts.before && !Number.isNaN(opts.before.getTime()) ? opts.before.toISOString() : null;
  // each arm: who (actor column), when (time column), filtered by person and cursor, newest first, own limit
  const arm = (actor: SQL, at: SQL) =>
    sql`${userId ? sql`and ${actor} = ${userId}::uuid` : sql``} ${before ? sql`and ${at} < ${before}::timestamptz` : sql``} order by ${at} desc limit ${limit}`;

  const parts: SQL[] = [];
  if (kinds.has("interaction")) {
    parts.push(sql`(select 'interaction' as kind, i.id::text as id, i.occurred_at as at, i.user_id as actor_id, u.name as actor_name,
      c.id as contact_id, c.name as contact_name, i.type as detail, i.outcome as extra, null::numeric as amount_inr
      from interactions i join users u on u.id = i.user_id join contacts c on c.id = i.contact_id
      where i.user_id is not null and i.occurred_at <= now() ${arm(sql`i.user_id`, sql`i.occurred_at`)})`);
  }
  if (kinds.has("lead")) {
    parts.push(sql`(select 'lead' as kind, c.id::text as id, c.created_at as at, c.created_by_id as actor_id, u.name as actor_name,
      c.id as contact_id, c.name as contact_name, c.first_channel as detail, null as extra, null::numeric as amount_inr
      from contacts c join users u on u.id = c.created_by_id
      where c.merged_into_id is null ${arm(sql`c.created_by_id`, sql`c.created_at`)})`);
  }
  if (kinds.has("payment")) {
    parts.push(sql`(select 'payment' as kind, p.id::text as id, p.created_at as at, p.created_by_id as actor_id, u.name as actor_name,
      c.id as contact_id, c.name as contact_name, p.kind as detail, p.status as extra, p.amount_inr as amount_inr
      from payments p join users u on u.id = p.created_by_id join contacts c on c.id = p.contact_id
      where p.status <> 'scheduled' ${arm(sql`p.created_by_id`, sql`p.created_at`)})`);
  }
  if (kinds.has("verify")) {
    parts.push(sql`(select 'verify' as kind, p.id::text as id, p.verified_at as at, p.verified_by_id as actor_id, u.name as actor_name,
      c.id as contact_id, c.name as contact_name, p.kind as detail, p.status as extra, p.amount_inr as amount_inr
      from payments p join users u on u.id = p.verified_by_id join contacts c on c.id = p.contact_id
      where p.verified_at is not null ${arm(sql`p.verified_by_id`, sql`p.verified_at`)})`);
  }
  if (kinds.has("stage")) {
    parts.push(sql`(select 'stage' as kind, a.id::text as id, a.changed_at as at, a.user_id as actor_id, u.name as actor_name,
      c.id as contact_id, c.name as contact_name, a.new_value #>> '{}' as detail, a.old_value #>> '{}' as extra, null::numeric as amount_inr
      from audit_log a join users u on u.id = a.user_id join contacts c on c.id::text = a.row_id
      where a.table_name = 'contacts' and a.field = 'stage' ${arm(sql`a.user_id`, sql`a.changed_at`)})`);
  }
  if (kinds.has("owner")) {
    parts.push(sql`(select 'owner' as kind, o.id::text as id, o.changed_at as at, o.changed_by_id as actor_id, u.name as actor_name,
      c.id as contact_id, c.name as contact_name, coalesce(t.name, 'the pool') as detail, o.reason as extra, null::numeric as amount_inr
      from ownership_log o join users u on u.id = o.changed_by_id join contacts c on c.id = o.contact_id
      left join users t on t.id = o.to_user_id
      where o.changed_by_id is not null ${arm(sql`o.changed_by_id`, sql`o.changed_at`)})`);
  }
  if (kinds.has("task")) {
    parts.push(sql`(select 'task' as kind, t.id::text as id, t.completed_at as at, t.completed_by_id as actor_id, u.name as actor_name,
      c.id as contact_id, c.name as contact_name, t.reason as detail, t.type as extra, null::numeric as amount_inr
      from tasks t join users u on u.id = t.completed_by_id left join contacts c on c.id = t.contact_id
      where t.status = 'done' and t.type in ('task', 'follow_up') and t.completed_at is not null ${arm(sql`t.completed_by_id`, sql`t.completed_at`)})`);
  }
  if (!parts.length) return { items: [], nextBefore: null };
  const rows = await tx.execute<Raw>(sql`select * from (${sql.join(parts, sql` union all `)}) feed order by at desc, id limit ${limit}`);
  const items = rows.map((r) => ({
    kind: r.kind,
    id: `${r.kind}:${r.id}`,
    at: r.at instanceof Date ? r.at : new Date(r.at),
    actorId: r.actor_id,
    actorName: r.actor_name,
    contactId: r.contact_id,
    contactName: r.contact_name,
    detail: r.detail,
    extra: r.extra,
    amountInr: r.amount_inr === null ? null : Number(r.amount_inr),
  }));
  return { items, nextBefore: items.length === limit ? items[items.length - 1].at : null };
}

import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { contacts, users } from "@/db/schema";
import { getSettings, type AssignmentConfig, type Team } from "@/lib/settings";
import { AdminError } from "./errors";
import { assertAdmin, inTx, saveSettingAudited, type AdminActor } from "./settings";
import { validateAssignment, validateTeams } from "./validate";

/**
 * Teams and auto-assignment (Settings > Teams and assignment; spec ownership rule 1: GCC numbers to the Dubai
 * team, others to Kerala, then round robin among active salespeople in that team).
 */

export type RoundRobinMember = {
  id: string;
  name: string;
  lastAssignedAt: Date | null;
  /** live contacts they own */
  contactCount: number;
};

/**
 * Active salespeople per team, in round-robin order: the first one gets the next lead (least recently assigned,
 * never-assigned first — the same order pickAutoOwner uses).
 */
export async function roundRobinByTeam(tx: Tx = db): Promise<Map<string, RoundRobinMember[]>> {
  const rows = await tx
    .select({
      id: users.id,
      name: users.name,
      team: users.team,
      lastAssignedAt: users.lastAssignedAt,
      // the outer column written in full: Drizzle leaves it unqualified in a one-table select, which would bind it to c
      contactCount: sql<number>`(select count(*)::int from contacts c where c.owner_id = ${sql.raw(`"users"."id"`)} and c.merged_into_id is null)`,
    })
    .from(users)
    .where(and(eq(users.active, true), eq(users.role, "sales")))
    .orderBy(sql`${users.lastAssignedAt} asc nulls first`, asc(users.createdAt), asc(users.id));
  const out = new Map<string, RoundRobinMember[]>();
  for (const r of rows) {
    const key = r.team ?? "";
    const list = out.get(key) ?? [];
    list.push({ id: r.id, name: r.name, lastAssignedAt: r.lastAssignedAt, contactCount: Number(r.contactCount) });
    out.set(key, list);
  }
  return out;
}

/** How many unassigned (pool) contacts there are. */
export async function poolSize(tx: Tx = db): Promise<number> {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(and(isNull(contacts.ownerId), isNull(contacts.mergedIntoId)));
  return Number(n);
}

/**
 * Saves the teams. A team cannot be removed while people are on it or the assignment rules send leads to it.
 */
export async function saveTeams(input: unknown, actor: AdminActor, tx: Tx = db): Promise<{ changed: boolean }> {
  assertAdmin(actor);
  const v = validateTeams(input);
  if (!v.ok) throw new AdminError(v.error);
  const teams: Team[] = v.value;
  return inTx(tx, async (t) => {
    const s = await getSettings(["teams", "assignment"], t);
    const kept = new Set(teams.map((x) => x.key));
    for (const old of s.teams.filter((x) => !kept.has(x.key))) {
      const [{ n }] = await t.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.team, old.key));
      if (Number(n) > 0) throw new AdminError(`${old.label} still has ${n} team member${Number(n) === 1 ? "" : "s"}. Move them first.`);
      if (s.assignment.gccTeam === old.key || s.assignment.defaultTeam === old.key) {
        throw new AdminError(`New leads are sent to ${old.label}. Change the assignment rules first.`);
      }
    }
    return saveSettingAudited("teams", teams, actor, t);
  });
}

export async function saveAssignment(input: unknown, actor: AdminActor, tx: Tx = db): Promise<{ changed: boolean; warnings: string[] }> {
  assertAdmin(actor);
  return inTx(tx, async (t) => {
    const { teams } = await getSettings(["teams"], t);
    const v = validateAssignment(input, teams);
    if (!v.ok) throw new AdminError(v.error, v.field);
    const value: AssignmentConfig = v.value;
    const { changed } = await saveSettingAudited("assignment", value, actor, t);
    return { changed, warnings: v.warnings };
  });
}

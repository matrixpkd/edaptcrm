import "server-only";
import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { auditLog, importBatches, settings as settingsTable, users, webhookEvents } from "@/db/schema";
import { getSettings } from "@/lib/settings";
import { WEBHOOK_SOURCES } from "@/lib/webhooks/sources";
import { buildChecklist, type ChecklistItem, type OnboardingFacts } from "./checklist";

/**
 * Reads what the "Getting started" checklist needs from the data itself (src/lib/admin/checklist.ts): teammates,
 * product edits, saved settings, webhook deliveries and committed imports. A handful of small indexed queries.
 */
export async function getOnboardingFacts(tx: Tx = db): Promise<OnboardingFacts> {
  const [s, people, saved, [flags], sources] = await Promise.all([
    getSettings(["teams", "assignment", "currency"], tx),
    tx
      .select({ role: users.role, team: users.team, n: count() })
      .from(users)
      .where(and(eq(users.active, true), ne(users.role, "admin")))
      .groupBy(users.role, users.team),
    tx.select({ key: settingsTable.key }).from(settingsTable).where(inArray(settingsTable.key, ["teams", "assignment", "currency"])),
    // existence checks only: each stops at the first row (indexes on audit_log(table_name, row_id) and import status)
    tx.execute<{ productsEdited: boolean; importsCommitted: number }>(sql`
      select
        exists (select 1 from ${auditLog} where ${auditLog.tableName} = 'products' and ${auditLog.userId} is not null) as "productsEdited",
        (select count(*)::int from ${importBatches} where ${importBatches.status} = 'committed') as "importsCommitted"
    `),
    // one index probe per known source (webhook_events_source_idx) instead of a DISTINCT over every delivery
    tx.execute<{ source: string }>(sql`
      select s.source from unnest(${sql.raw(`array[${WEBHOOK_SOURCES.map((x) => `'${x}'`).join(",")}]`)}::text[]) as s(source)
      where exists (select 1 from ${webhookEvents} w where w.source = s.source)
    `),
  ]);
  const salesByTeam: Record<string, number> = {};
  for (const p of people) if (p.role === "sales" && p.team) salesByTeam[p.team] = (salesByTeam[p.team] ?? 0) + Number(p.n);
  const savedKeys = new Set(saved.map((r) => r.key));
  return {
    teammates: people.reduce((a, p) => a + Number(p.n), 0),
    salesByTeam,
    leadTeams: [...new Set([s.assignment.defaultTeam, s.assignment.gccTeam])],
    teamLabels: Object.fromEntries(s.teams.map((t) => [t.key, t.label])),
    assignmentSaved: savedKeys.has("teams") || savedKeys.has("assignment"),
    productsEdited: !!flags.productsEdited,
    webhookSources: sources.map((r) => r.source),
    importsCommitted: Number(flags.importsCommitted),
    currencySaved: savedKeys.has("currency"),
    foreignCurrencies: s.currency.enabled.filter((c) => c !== s.currency.base),
  };
}

export type Onboarding = { items: ChecklistItem[]; done: number; total: number; complete: boolean };

export async function getOnboarding(tx: Tx = db): Promise<Onboarding> {
  const items = buildChecklist(await getOnboardingFacts(tx));
  const done = items.filter((i) => i.done).length;
  return { items, done, total: items.length, complete: done === items.length };
}

/** Whether this admin hid the checklist on Today. */
export async function onboardingDismissed(userId: string, tx: Tx = db): Promise<boolean> {
  const [u] = await tx.select({ at: users.onboardingDismissedAt }).from(users).where(eq(users.id, userId)).limit(1);
  return !!u?.at;
}

/** Hides (or, with `show`, brings back) the checklist on this admin's Today. */
export async function setOnboardingDismissed(userId: string, dismissed: boolean, tx: Tx = db): Promise<void> {
  await tx
    .update(users)
    .set({ onboardingDismissedAt: dismissed ? sql`now()` : null })
    .where(eq(users.id, userId));
}

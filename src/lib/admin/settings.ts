import "server-only";
import { sql } from "drizzle-orm";
import { db, type Database, type Tx } from "@/db";
import type { Role } from "@/db/schema";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth/permissions";
import { getSetting, setSetting, type SettingKey, type Settings } from "@/lib/settings";
import { AdminForbiddenError } from "./errors";

/** The signed-in admin (a SessionUser satisfies this). */
export type AdminActor = { id: string; role: Role };

/** Throws unless the actor may manage settings (the admin). Every admin service calls this first. */
export function assertAdmin(actor: AdminActor | null | undefined, message?: string): asserts actor is AdminActor {
  if (!actor || !can(actor, "settings.manage")) throw new AdminForbiddenError(message);
}

/** Runs `fn` atomically: a transaction on the root handle, a savepoint inside an open transaction. */
export function inTx<T>(tx: Tx, fn: (t: Tx) => Promise<T>): Promise<T> {
  return (tx as Database).transaction((t) => fn(t));
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Saves one setting and writes audit_log (table "settings", row = the key) with the old and the new JSON, in one
 * transaction. The old value is the effective one (saved value or spec default). Saving an unchanged value writes
 * nothing. Admin only. Callers validate the value first (src/lib/admin/validate.ts).
 */
export async function saveSettingAudited<K extends SettingKey>(
  key: K,
  value: Settings[K],
  actor: AdminActor,
  tx: Tx = db,
): Promise<{ changed: boolean; before: Settings[K] }> {
  assertAdmin(actor);
  return inTx(tx, async (t) => {
    // one writer per key at a time, so two admins saving at once both land in the audit log in order
    await t.execute(sql`select pg_advisory_xact_lock(hashtext(${`edapt:settings:${key}`}))`);
    const before = await getSetting(key, t);
    if (sameJson(before, value)) return { changed: false, before };
    await setSetting(key, value, actor.id, t);
    await audit(
      { table: "settings", rowId: key, action: "update", field: key, oldValue: before, newValue: value, userId: actor.id },
      t,
    );
    return { changed: true, before };
  });
}

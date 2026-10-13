import "server-only";
import { cache } from "react";
import { eq, inArray } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { settings as settingsTable } from "@/db/schema";
import { DEFAULT_SETTINGS, type ListItem, type SettingKey, type Settings } from "./defaults";

export * from "./defaults";

/**
 * Read one setting: the saved value if present, otherwise the default.
 * Saved objects are shallow-merged over the default so new default keys appear automatically.
 */
export async function getSetting<K extends SettingKey>(key: K, tx: Tx = db): Promise<Settings[K]> {
  const rows = await tx.select().from(settingsTable).where(eq(settingsTable.key, key)).limit(1);
  return mergeWithDefault(key, rows[0]?.value);
}

/** Read several settings in one query. */
export async function getSettings<K extends SettingKey>(keys: K[], tx: Tx = db): Promise<Pick<Settings, K>> {
  const rows = keys.length
    ? await tx.select().from(settingsTable).where(inArray(settingsTable.key, keys as string[]))
    : [];
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as Pick<Settings, K>;
  for (const k of keys) out[k] = mergeWithDefault(k, byKey.get(k));
  return out;
}

/** Request-scoped cached read for server components. */
export const getSettingCached = cache(<K extends SettingKey>(key: K) => getSetting(key));

/** Every setting, merged with defaults (request-scoped cache). */
export const getAllSettings = cache(async (): Promise<Settings> => {
  const rows = await db.select().from(settingsTable);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) out[k] = mergeWithDefault(k, byKey.get(k));
  return out as Settings;
});

export async function setSetting<K extends SettingKey>(
  key: K,
  value: Settings[K],
  userId: string | null,
  tx: Tx = db,
): Promise<void> {
  await tx
    .insert(settingsTable)
    .values({ key, value: value as unknown, updatedById: userId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: { value: value as unknown, updatedById: userId, updatedAt: new Date() },
    });
}

function mergeWithDefault<K extends SettingKey>(key: K, saved: unknown): Settings[K] {
  const def = DEFAULT_SETTINGS[key];
  if (saved === undefined || saved === null) return structuredClone(def);
  if (Array.isArray(def) || Array.isArray(saved)) return saved as Settings[K];
  if (typeof def === "object" && typeof saved === "object") {
    return { ...(structuredClone(def) as object), ...(saved as object) } as Settings[K];
  }
  return saved as Settings[K];
}

/** Label for a stored key, falling back to the key itself. */
export function labelFor(list: ListItem[], key: string | null | undefined): string {
  if (!key) return "";
  return list.find((i) => i.key === key)?.label ?? key;
}

/** Only items that are not switched off, for dropdowns. */
export function activeItems(list: ListItem[]): ListItem[] {
  return list.filter((i) => i.active !== false);
}

import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { getSetting, getSettings, type ListItem } from "@/lib/settings";
import { AdminError } from "./errors";
import { LIST_META, type ListKey } from "./meta";
import { assertAdmin, inTx, saveSettingAudited, type AdminActor } from "./settings";
import { validateList } from "./validate";

/**
 * Dropdown lists (Settings > Lists): channels, first doors, campaigns, tags, languages, age bands, industries,
 * lost reasons, outcomes. Stored values are keys, so a key never changes once added: labels can be renamed,
 * items reordered and switched off. An item can only be removed while nothing uses its key.
 */

export type KeyUsage = {
  contacts: number;
  enquiries: number;
  interactions: number;
  /** purchases carrying the key (campaigns) */
  purchases: number;
  /** next-best-offer rules naming the key */
  rules: number;
  /** capture settings that write the key (Settings > Integrations self-rating answers and buttons) */
  mappings: number;
  total: number;
};

const empty = (): KeyUsage => ({ contacts: 0, enquiries: 0, interactions: 0, purchases: 0, rules: 0, mappings: 0, total: 0 });

/** One query per source; each returns (key, n). */
function usageQueries(list: ListKey): { source: "contacts" | "enquiries" | "interactions" | "purchases"; q: SQL }[] {
  switch (list) {
    case "lists.channels":
      return [
        { source: "enquiries", q: sql`select channel as k, count(*)::int as n from enquiries group by 1` },
        {
          source: "contacts",
          q: sql`select k, count(*)::int as n from (
                   select id, first_channel as k from contacts where first_channel is not null
                   union select id, last_channel from contacts where last_channel is not null
                 ) x group by 1`,
        },
      ];
    case "lists.firstDoors":
      return [{ source: "contacts", q: sql`select first_door as k, count(*)::int as n from contacts group by 1` }];
    case "lists.campaigns":
      return [
        { source: "enquiries", q: sql`select campaign as k, count(*)::int as n from enquiries where campaign is not null group by 1` },
        { source: "purchases", q: sql`select campaign as k, count(*)::int as n from purchases where campaign is not null group by 1` },
        {
          source: "contacts",
          q: sql`select k, count(*)::int as n from (
                   select id, first_campaign as k from contacts where first_campaign is not null
                   union select id, last_campaign from contacts where last_campaign is not null
                 ) x group by 1`,
        },
      ];
    case "lists.tags":
      return [{ source: "contacts", q: sql`select t as k, count(*)::int as n from contacts, unnest(tags) as t group by 1` }];
    case "lists.languages":
      return [{ source: "contacts", q: sql`select language as k, count(*)::int as n from contacts where language is not null group by 1` }];
    case "lists.ageBands":
      return [{ source: "contacts", q: sql`select age_band as k, count(*)::int as n from contacts where age_band is not null group by 1` }];
    case "lists.industries":
      return [{ source: "contacts", q: sql`select industry as k, count(*)::int as n from contacts where industry is not null group by 1` }];
    case "lists.lostReasons":
      return [{ source: "contacts", q: sql`select lost_reason as k, count(*)::int as n from contacts where lost_reason is not null group by 1` }];
    case "lists.outcomes":
      return [{ source: "interactions", q: sql`select outcome as k, count(*)::int as n from interactions where outcome is not null group by 1` }];
  }
}

/** Next-best-offer conditions read first doors, tags and industries by key. */
const RULE_CONDITION: Partial<Record<ListKey, string>> = {
  "lists.firstDoors": "first_door_in",
  "lists.tags": "tag_in",
  "lists.industries": "industry_in",
};

/**
 * How often each key of a list is used: by contacts (merged ones included, so undoing a merge never meets an
 * unknown key), enquiries, interactions, purchases, next-best-offer rules, and the capture mappings that write
 * first doors (Settings > Integrations self-ratings): removing a key those still write would leave new contacts
 * with an unknown first door.
 */
export async function listUsage(list: ListKey, tx: Tx = db): Promise<Map<string, KeyUsage>> {
  const out = new Map<string, KeyUsage>();
  const add = (k: string, field: keyof Omit<KeyUsage, "total">, n: number) => {
    const u = out.get(k) ?? empty();
    u[field] += n;
    u.total += n;
    out.set(k, u);
  };
  for (const { source, q } of usageQueries(list)) {
    const rows = await tx.execute<{ k: string | null; n: number }>(q);
    for (const r of rows) if (r.k !== null) add(r.k, source, Number(r.n));
  }
  const cond = RULE_CONDITION[list];
  if (cond) {
    const rules = await getSetting("nbo.rules", tx);
    for (const rule of rules) {
      for (const c of rule.when) {
        if (c.type === cond && "values" in c) for (const v of c.values) add(v, "rules", 1);
      }
    }
  }
  if (list === "lists.firstDoors") {
    const self = await getSetting("integrations.selfRatings", tx);
    for (const m of [...(self.answers ?? []), ...(self.buttons ?? [])]) {
      if (m.field === "firstDoor" && m.value) add(m.value, "mappings", 1);
    }
  }
  return out;
}

/**
 * Saves a list. Keys that disappear must be unused (no contact, enquiry, interaction or rule) and not one the
 * system relies on; otherwise switch them off. Labels must stay unique. Admin only, audited.
 */
export async function saveList(
  list: ListKey,
  input: unknown,
  actor: AdminActor,
  tx: Tx = db,
): Promise<{ changed: boolean }> {
  assertAdmin(actor);
  const meta = LIST_META.find((m) => m.key === list);
  if (!meta) throw new AdminError("That list does not exist");
  const v = validateList(input, meta.title);
  if (!v.ok) throw new AdminError(v.error);
  const items: ListItem[] = v.value;
  return inTx(tx, async (t) => {
    const before = (await getSettings([list], t))[list] as ListItem[];
    const kept = new Set(items.map((i) => i.key));
    const removed = before.filter((i) => !kept.has(i.key));
    if (removed.length) {
      const system = removed.find((i) => meta.systemKeys.includes(i.key));
      if (system) throw new AdminError(`"${system.label}" is used by the system. Switch it off instead of removing it.`);
      const usage = await listUsage(list, t);
      const used = removed.find((i) => (usage.get(i.key)?.total ?? 0) > 0);
      if (used) {
        throw new AdminError(`"${used.label}" is in use (${usage.get(used.key)!.total} records). Switch it off instead of removing it.`);
      }
    }
    const { changed } = await saveSettingAudited(list, items, actor, t);
    return { changed };
  });
}

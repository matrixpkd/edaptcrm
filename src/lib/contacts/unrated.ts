import "server-only";
import { sql, type SQL } from "drizzle-orm";

export { UNRATED_LABEL } from "./rules";

/**
 * "Unrated": no rating of any kind. No ratings row from anyone (a salesperson, the contact's own self-rating or an
 * import) and none of the four scales (AI knowledge, Umer familiarity, spending power, gut stars) set.
 * THE definition: the Contacts list filter (?unrated=1), the export and the dashboard's data-health tile all use it,
 * so the tile's count is exactly the list it links to (for a viewer who sees every contact).
 *
 * `table` is the SQL name or alias of the contacts row being tested ("contacts" by default, "c" in raw SQL).
 */
export function unratedCondition(table = "contacts"): SQL {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`Bad table alias: ${table}`);
  const t = sql.raw(`"${table}"`);
  return sql`(${t}."ai_level" is null and ${t}."umer_level" is null and ${t}."spending_band" is null and ${t}."gut_stars" is null
    and not exists (select 1 from ratings r where r.contact_id = ${t}."id"))`;
}

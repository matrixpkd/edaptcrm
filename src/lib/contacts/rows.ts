import "server-only";
import { getTableColumns, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";
import { contacts, type Contact } from "@/db/schema";

/**
 * Whole-contact reads on the hot paths (getContact, the phone/email/name lookups, the money services). Drizzle
 * rebuilds the 70-column select list on every `select().from(contacts)`, which costs about 1 ms of CPU per query;
 * an import commits thousands of rows, each reading a few contacts. Here the select list is built once and each
 * value is decoded with the column's own mapFromDriverValue, exactly as drizzle's select does, so the rows are
 * identical (tests/integration/contacts-rows.test.ts compares them).
 */
const COLUMNS = Object.entries(getTableColumns(contacts));
const SELECT_LIST = sql.raw(COLUMNS.map(([, c]) => `"contacts"."${c.name}"`).join(", "));

function mapRow(raw: Record<string, unknown>): Contact {
  const out: Record<string, unknown> = {};
  for (const [key, col] of COLUMNS) {
    const v = raw[col.name];
    out[key] = v === null || v === undefined ? null : col.mapFromDriverValue(v);
  }
  return out as Contact;
}

/** `select <every contact column> from contacts where <where> [order by] [limit] [for update]`, as Contact rows. */
export async function selectContacts(
  where: SQL,
  tx: Tx,
  opts: { orderBy?: SQL; limit?: number; forUpdate?: boolean } = {},
): Promise<Contact[]> {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    select ${SELECT_LIST} from "contacts" where ${where}
    ${opts.orderBy ? sql`order by ${opts.orderBy}` : sql``}
    ${opts.limit ? sql`limit ${sql.raw(String(Math.floor(opts.limit)))}` : sql``}
    ${opts.forUpdate ? sql`for update` : sql``}
  `);
  return rows.map(mapRow);
}

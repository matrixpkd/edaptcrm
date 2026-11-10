import "server-only";
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { contacts, type Role } from "@/db/schema";
import { can } from "./permissions";

/**
 * The WHERE condition for contacts a user may see. ALWAYS use this when listing or
 * searching contacts: it also hides merged-away rows and contacts whose personal data was erased on request
 * (src/lib/contacts/privacy.ts; their money rows still count in the dashboard, which does not use this scope).
 */
export function contactScope(user: { id: string; role: Role }): SQL {
  const notMerged = and(isNull(contacts.mergedIntoId), isNull(contacts.erasedAt))!;
  if (can(user, "contacts.viewAll")) return notMerged;
  return and(notMerged, or(eq(contacts.ownerId, user.id), isNull(contacts.ownerId)))!;
}

/**
 * canViewContact in SQL, for the `contacts` row in the query: true when the user may open it (the owner rule only;
 * it does not hide merged or erased rows). For read models that show rows next to the contact they belong to, such
 * as an organisation's people and deals, to leave out or count in SQL what the user may not open. Lists and
 * searches of contacts use contactScope.
 */
export function canViewContactSql(user: { id: string; role: Role }): SQL {
  if (can(user, "contacts.viewAll")) return sql`true`;
  return sql`(${contacts.ownerId} = ${user.id} or ${contacts.ownerId} is null)`;
}

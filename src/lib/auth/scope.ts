import "server-only";
import { and, eq, isNull, or, type SQL } from "drizzle-orm";
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

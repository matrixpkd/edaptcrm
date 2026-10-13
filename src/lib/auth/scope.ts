import "server-only";
import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import { contacts, type Role } from "@/db/schema";
import { can } from "./permissions";

/**
 * The WHERE condition for contacts a user may see. ALWAYS use this when listing or
 * searching contacts: it also hides merged-away rows.
 */
export function contactScope(user: { id: string; role: Role }): SQL {
  const notMerged = isNull(contacts.mergedIntoId);
  if (can(user, "contacts.viewAll")) return notMerged;
  return and(notMerged, or(eq(contacts.ownerId, user.id), isNull(contacts.ownerId)))!;
}

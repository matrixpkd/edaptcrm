/**
 * Who can do what. Pure functions, safe for client and server.
 *
 * | Role    | Sees                                | Can do                                                    |
 * | Admin   | Everything                          | Settings, scoring weights, imports, exports, all below    |
 * | Manager | All contacts                        | Reassign owners, verify payments, team dashboard          |
 * | Sales   | Own contacts plus unassigned pool   | Add leads, log calls, rate, record payments               |
 * | Support | All contacts                        | Log support issues and notes without changing the owner   |
 */
import type { Role } from "@/db/schema";

export type Permission =
  | "settings.manage"
  | "users.manage"
  | "import.run"
  | "export.run"
  | "contacts.viewAll"
  | "contacts.create"
  | "contacts.edit"
  | "contacts.reassign"
  | "contacts.merge"
  | "contacts.erase"
  | "contacts.setStage"
  | "contacts.requestTransfer"
  | "interactions.log"
  | "ratings.edit"
  | "payments.record"
  | "payments.verify"
  | "payments.refund"
  | "credit.adjust"
  | "dashboard.view"
  | "audit.view";

const MATRIX: Record<Role, Permission[]> = {
  admin: [
    "settings.manage",
    "users.manage",
    "import.run",
    "export.run",
    "contacts.viewAll",
    "contacts.create",
    "contacts.edit",
    "contacts.reassign",
    "contacts.merge",
    "contacts.erase",
    "contacts.setStage",
    "interactions.log",
    "ratings.edit",
    "payments.record",
    "payments.verify",
    "payments.refund",
    "credit.adjust",
    "dashboard.view",
    "audit.view",
  ],
  manager: [
    "contacts.viewAll",
    "contacts.create",
    "contacts.edit",
    "contacts.reassign",
    "contacts.merge",
    "contacts.setStage",
    "interactions.log",
    "ratings.edit",
    "payments.record",
    "payments.verify",
    "payments.refund",
    "credit.adjust",
    "dashboard.view",
  ],
  sales: [
    "contacts.create",
    "contacts.edit",
    "contacts.setStage",
    "contacts.requestTransfer",
    "interactions.log",
    "ratings.edit",
    "payments.record",
  ],
  support: ["contacts.viewAll", "contacts.create", "interactions.log"],
};

export function can(user: { role: Role } | null | undefined, permission: Permission): boolean {
  if (!user) return false;
  return MATRIX[user.role]?.includes(permission) ?? false;
}

/** Sales see their own contacts and the unassigned pool; everyone else sees all. */
export function canViewContact(
  user: { id: string; role: Role },
  contact: { ownerId: string | null },
): boolean {
  if (can(user, "contacts.viewAll")) return true;
  return contact.ownerId === null || contact.ownerId === user.id;
}

/** Editing profile fields, ratings, stage. Support can only log interactions. */
export function canEditContact(
  user: { id: string; role: Role },
  contact: { ownerId: string | null },
): boolean {
  if (user.role === "admin" || user.role === "manager") return true;
  if (user.role === "sales") return contact.ownerId === null || contact.ownerId === user.id;
  return false;
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  manager: "Manager",
  sales: "Sales",
  support: "Support",
};

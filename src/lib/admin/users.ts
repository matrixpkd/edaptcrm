import "server-only";
import { randomInt } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { ROLES, contacts, sessions, tasks, users, type Role, type User } from "@/db/schema";
import { audit, auditDiff } from "@/lib/audit";
import { hashPassword } from "@/lib/auth/password";
import { handoverAllContacts } from "@/lib/contacts/assignment";
import { ContactError } from "@/lib/contacts/errors";
import { normalizePhone } from "@/lib/phone";
import { getSetting } from "@/lib/settings";
import { isUuid } from "@/lib/utils";
import { AdminError } from "./errors";
import { assertAdmin, inTx, type AdminActor } from "./settings";
import { isTimeZone, normalizeUserEmail } from "./validate";

/**
 * Team members (Settings > Users): create, edit, reset password, deactivate with handover, reactivate.
 * Admin only. Every change is written to audit_log (table "users"); password hashes never are.
 * The last active admin can never be removed (deactivated or given another role).
 */

// ---------------------------------------------------------------------------
// Temporary passwords
// ---------------------------------------------------------------------------

/** No 0/O, 1/l/I: easy to read out over the phone. */
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * A strong temporary password, shown to the admin once: four groups of four characters from a 56-symbol
 * alphabet (about 93 bits), e.g. "Kp7m-Xq2r-Tn9w-Hb4c". Always contains a lower-case letter, a capital and a digit.
 */
export function generateTempPassword(): string {
  for (;;) {
    let s = "";
    for (let i = 0; i < 16; i++) s += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
    if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) return s.match(/.{4}/g)!.join("-");
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type AdminUserRow = Pick<
  User,
  "id" | "name" | "email" | "role" | "team" | "phone" | "timezone" | "active" | "lastLoginAt" | "lastAssignedAt" | "createdAt"
> & {
  /** live contacts they own */
  contactCount: number;
  /** open tasks assigned to them */
  openTaskCount: number;
};

const USER_COLS = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
  team: users.team,
  phone: users.phone,
  timezone: users.timezone,
  active: users.active,
  lastLoginAt: users.lastLoginAt,
  lastAssignedAt: users.lastAssignedAt,
  createdAt: users.createdAt,
};

/** Every team member, active first, with how many contacts and open tasks each holds. */
export async function listUsers(tx: Tx = db): Promise<AdminUserRow[]> {
  const rows = await tx.select(USER_COLS).from(users).orderBy(desc(users.active), asc(sql`lower(${users.name})`));
  const owned = await tx
    .select({ id: contacts.ownerId, n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(and(isNull(contacts.mergedIntoId), sql`${contacts.ownerId} is not null`))
    .groupBy(contacts.ownerId);
  const open = await tx
    .select({ id: tasks.userId, n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.status, "open"), sql`${tasks.userId} is not null`))
    .groupBy(tasks.userId);
  const ownedBy = new Map(owned.map((r) => [r.id, Number(r.n)]));
  const openBy = new Map(open.map((r) => [r.id, Number(r.n)]));
  return rows.map((u) => ({ ...u, contactCount: ownedBy.get(u.id) ?? 0, openTaskCount: openBy.get(u.id) ?? 0 }));
}

export async function getAdminUser(id: string, tx: Tx = db): Promise<AdminUserRow | null> {
  if (!isUuid(id)) return null;
  const [u] = await tx.select(USER_COLS).from(users).where(eq(users.id, id)).limit(1);
  if (!u) return null;
  const [{ n: contactCount }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(and(eq(contacts.ownerId, id), isNull(contacts.mergedIntoId)));
  const [{ n: openTaskCount }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.userId, id), eq(tasks.status, "open")));
  return { ...u, contactCount: Number(contactCount), openTaskCount: Number(openTaskCount) };
}

/** Active people who can receive a leaver's contacts: anyone but support (support never owns), except the leaver. */
export async function listHandoverTargets(exceptUserId: string, tx: Tx = db) {
  return tx
    .select({ id: users.id, name: users.name, role: users.role, team: users.team })
    .from(users)
    .where(and(eq(users.active, true), ne(users.role, "support"), isUuid(exceptUserId) ? ne(users.id, exceptUserId) : undefined))
    .orderBy(asc(sql`lower(${users.name})`));
}

/**
 * The default receiver of a leaver's contacts (spec rule 8: "all their contacts move to the manager"): an active
 * manager — one in the leaver's team first — else an active admin. Null when nobody else qualifies.
 */
export async function defaultHandoverTarget(userId: string, tx: Tx = db): Promise<string | null> {
  if (!isUuid(userId)) return null;
  const [leaver] = await tx.select({ team: users.team }).from(users).where(eq(users.id, userId)).limit(1);
  const rows = await tx
    .select({ id: users.id, role: users.role, team: users.team })
    .from(users)
    .where(and(eq(users.active, true), inArray(users.role, ["manager", "admin"]), ne(users.id, userId)))
    .orderBy(asc(users.createdAt), asc(users.id));
  const managers = rows.filter((r) => r.role === "manager");
  const sameTeam = managers.find((m) => leaver?.team && m.team === leaver.team);
  return (sameTeam ?? managers[0] ?? rows.find((r) => r.role === "admin"))?.id ?? null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type UserInput = {
  name: string | null;
  email?: string | null;
  role: string | null;
  team: string | null;
  timezone: string | null;
  phone: string | null;
};

type CleanUser = { name: string; role: Role; team: string | null; timezone: string; phone: string | null };

async function cleanUserInput(input: UserInput, t: Tx): Promise<CleanUser> {
  const name = (input.name ?? "").trim().replace(/\s+/g, " ");
  if (!name) throw new AdminError("Enter their name", "name");
  if (name.length > 100) throw new AdminError("That name is too long", "name");
  const role = input.role as Role;
  if (!(ROLES as readonly string[]).includes(role)) throw new AdminError("Choose a role", "role");
  const teams = await getSetting("teams", t);
  const teamKey = input.team?.trim() || null;
  if (teamKey && !teams.some((x) => x.key === teamKey)) throw new AdminError("Choose a team from the list", "team");
  const teamZone = teams.find((x) => x.key === teamKey)?.timezone;
  const timezone = input.timezone?.trim() || teamZone || "Asia/Kolkata";
  if (!isTimeZone(timezone)) throw new AdminError("Choose a time zone from the list", "timezone");
  let phone: string | null = null;
  if (input.phone?.trim()) {
    const p = normalizePhone(input.phone);
    if (!p) throw new AdminError("That phone number does not look valid", "phone");
    phone = p.e164;
  }
  return { name, role, team: teamKey, timezone, phone };
}

/** Count of active admins other than `exceptId`, with their rows locked so two removals cannot race. */
async function otherActiveAdmins(exceptId: string, t: Tx): Promise<number> {
  const rows = await t
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.active, true), ne(users.id, exceptId)))
    .for("update");
  return rows.length;
}

async function lockUser(id: string, t: Tx): Promise<User> {
  if (!isUuid(id)) throw new AdminError("That team member does not exist");
  const [u] = await t.select().from(users).where(eq(users.id, id)).limit(1).for("update");
  if (!u) throw new AdminError("That team member does not exist");
  return u;
}

async function ownedContactCount(id: string, t: Tx): Promise<number> {
  const [{ n }] = await t
    .select({ n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(and(eq(contacts.ownerId, id), isNull(contacts.mergedIntoId)));
  return Number(n);
}

/** Adds a team member with a generated temporary password, which is returned once and never stored in clear. */
export async function createUser(
  input: UserInput,
  actor: AdminActor,
  tx: Tx = db,
): Promise<{ user: User; tempPassword: string }> {
  assertAdmin(actor, "Only an admin can add team members");
  const email = normalizeUserEmail(input.email);
  if (!email) throw new AdminError("Enter a valid email address", "email");
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  return inTx(tx, async (t) => {
    const clean = await cleanUserInput(input, t);
    const [dup] = await t
      .select({ id: users.id })
      .from(users)
      .where(eq(sql`lower(${users.email})`, email))
      .limit(1);
    if (dup) throw new AdminError("Someone already uses that email", "email");
    const [user] = await t
      .insert(users)
      .values({ ...clean, email, passwordHash, active: true })
      .returning();
    await audit(
      {
        table: "users",
        rowId: user.id,
        action: "insert",
        newValue: { name: user.name, email: user.email, role: user.role, team: user.team, timezone: user.timezone, phone: user.phone },
        userId: actor.id,
      },
      t,
    );
    return { user, tempPassword };
  });
}

/**
 * Edits name, role, team, time zone and phone. The last active admin keeps the admin role, and someone who still
 * owns contacts cannot become support (support never owns: hand their contacts over first).
 */
export async function updateUser(id: string, input: UserInput, actor: AdminActor, tx: Tx = db): Promise<User> {
  assertAdmin(actor, "Only an admin can edit team members");
  return inTx(tx, async (t) => {
    const before = await lockUser(id, t);
    const clean = await cleanUserInput(input, t);
    if (before.role === "admin" && clean.role !== "admin" && before.active && (await otherActiveAdmins(id, t)) === 0) {
      throw new AdminError(`${before.name} is the only active admin. Make someone else an admin first.`, "role");
    }
    if (clean.role === "support" && before.role !== "support") {
      const owned = await ownedContactCount(id, t);
      if (owned > 0) {
        throw new AdminError(
          `${before.name} owns ${owned} contact${owned === 1 ? "" : "s"}. Support never owns contacts: hand them over first.`,
          "role",
        );
      }
    }
    const [after] = await t
      .update(users)
      .set({ ...clean, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    await auditDiff("users", id, before, clean, actor.id, t);
    return after;
  });
}

/** A new temporary password (returned once). Ends every session of that person, so the old password stops working. */
export async function resetUserPassword(id: string, actor: AdminActor, tx: Tx = db): Promise<{ tempPassword: string; sessionsEnded: number }> {
  assertAdmin(actor, "Only an admin can reset passwords");
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  return inTx(tx, async (t) => {
    const u = await lockUser(id, t);
    await t.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, u.id));
    const ended = await t.delete(sessions).where(eq(sessions.userId, u.id)).returning({ id: sessions.id });
    await audit({ table: "users", rowId: u.id, action: "update", field: "password", newValue: "reset", userId: actor.id }, t);
    return { tempPassword, sessionsEnded: ended.length };
  });
}

/**
 * Spec rule 8, "When someone leaves": in one transaction, every contact they own and every open task of theirs
 * moves to `handoverToId` (handoverAllContacts: ownership_log + audit per contact), the account is switched off
 * and all of their sessions end. Refuses to remove the last active admin, or to deactivate yourself.
 */
export async function deactivateUser(
  id: string,
  handoverToId: string | null | undefined,
  actor: AdminActor,
  tx: Tx = db,
): Promise<{ moved: number; sessionsEnded: number }> {
  assertAdmin(actor, "Only an admin can deactivate team members");
  if (id === actor.id) throw new AdminError("You cannot deactivate your own account. Ask another admin.");
  if (!handoverToId || !isUuid(handoverToId)) throw new AdminError("Choose who receives their contacts", "handoverTo");
  return inTx(tx, async (t) => {
    const u = await lockUser(id, t);
    if (!u.active) throw new AdminError(`${u.name} is already deactivated`);
    if (u.role === "admin" && (await otherActiveAdmins(id, t)) === 0) {
      throw new AdminError(`${u.name} is the only active admin and cannot be deactivated.`);
    }
    let moved: number;
    try {
      moved = await handoverAllContacts(u.id, handoverToId, actor, t);
    } catch (e) {
      // the receiver is inactive, support or the leaver: show the contacts service's reason on the form
      if (e instanceof ContactError) throw new AdminError(e.message, "handoverTo");
      throw e;
    }
    await t.update(users).set({ active: false, updatedAt: new Date() }).where(eq(users.id, u.id));
    const ended = await t.delete(sessions).where(eq(sessions.userId, u.id)).returning({ id: sessions.id });
    await audit(
      {
        table: "users",
        rowId: u.id,
        action: "update",
        field: "active",
        oldValue: true,
        newValue: false,
        userId: actor.id,
      },
      t,
    );
    return { moved, sessionsEnded: ended.length };
  });
}

/** Switches a deactivated account back on. Their old contacts stay with whoever received them. */
export async function reactivateUser(id: string, actor: AdminActor, tx: Tx = db): Promise<User> {
  assertAdmin(actor, "Only an admin can reactivate team members");
  return inTx(tx, async (t) => {
    const u = await lockUser(id, t);
    if (u.active) throw new AdminError(`${u.name} is already active`);
    const [after] = await t.update(users).set({ active: true, updatedAt: new Date() }).where(eq(users.id, u.id)).returning();
    await audit({ table: "users", rowId: u.id, action: "update", field: "active", oldValue: false, newValue: true, userId: actor.id }, t);
    return after;
  });
}

/**
 * Moves every contact and open task of an active team member to someone else without deactivating them
 * (e.g. before they move to support). Returns the number of contacts moved.
 */
export async function handoverUserContacts(
  id: string,
  handoverToId: string | null | undefined,
  actor: AdminActor,
  tx: Tx = db,
): Promise<number> {
  assertAdmin(actor, "Only an admin can hand over contacts here");
  if (!handoverToId || !isUuid(handoverToId)) throw new AdminError("Choose who receives their contacts", "handoverTo");
  return inTx(tx, async (t) => {
    const u = await lockUser(id, t);
    try {
      return await handoverAllContacts(u.id, handoverToId, actor, t);
    } catch (e) {
      if (e instanceof ContactError) throw new AdminError(e.message, "handoverTo");
      throw e;
    }
  });
}

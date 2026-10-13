import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, contacts, ownershipLog, products, purchases, sessions, tasks, users } from "@/db/schema";
import { listAuditLog } from "@/lib/admin/audit-log";
import { AdminError, AdminForbiddenError } from "@/lib/admin/errors";
import { prepareExport } from "@/lib/admin/export";
import { listUsage, saveList } from "@/lib/admin/lists";
import { editCurrency } from "@/lib/admin/currency";
import { createProduct, deleteProduct, saveLadder, updateProduct } from "@/lib/admin/products";
import { recalcChunk } from "@/lib/admin/recalc";
import { saveSettingAudited } from "@/lib/admin/settings";
import { roundRobinByTeam, saveAssignment, saveTeams } from "@/lib/admin/teams";
import {
  createUser,
  deactivateUser,
  defaultHandoverTarget,
  generateTempPassword,
  reactivateUser,
  resetUserPassword,
  updateUser,
} from "@/lib/admin/users";
import { validateScoring } from "@/lib/admin/validate";
import { verifyPassword } from "@/lib/auth/password";
import { createTask } from "@/lib/alerts/core";
import { captureEnquiry } from "@/lib/contacts/capture";
import { getSetting } from "@/lib/settings";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";
import { makeUser, resetDb } from "../support/db";

let seq = 0;
const phone = () => `98471${String(40000 + seq++).padStart(5, "0")}`;

async function lead(over: Partial<Parameters<typeof captureEnquiry>[0]> = {}) {
  return (await captureEnquiry({ phone: phone(), channel: "phone_call", skipAlerts: true, ...over })).contact;
}

async function auditRows(where: ReturnType<typeof and>) {
  return db.select().from(auditLog).where(where).orderBy(auditLog.id);
}

async function readStream(s: ReadableStream<Uint8Array>): Promise<string> {
  const reader = s.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

/** Minimal CSV parser for the tests (quotes, commas, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r") continue;
    else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

describe("admin services", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // -------------------------------------------------------------------------
  describe("users", () => {
    it("generates strong, readable temporary passwords", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const p = generateTempPassword();
        expect(p).toMatch(/^[a-zA-Z2-9]{4}(-[a-zA-Z2-9]{4}){3}$/);
        expect(p).toMatch(/[a-z]/);
        expect(p).toMatch(/[A-Z]/);
        expect(p).toMatch(/\d/);
        expect(p).not.toMatch(/[01lIO]/);
        seen.add(p);
      }
      expect(seen.size).toBe(50);
    });

    it("creates a user with a temporary password shown once, audited without the hash", async () => {
      const admin = await makeUser({ role: "admin" });
      const { user, tempPassword } = await createUser(
        { name: "  Asha  Menon ", email: " Asha@Edapt.IN ", role: "sales", team: "dubai", timezone: null, phone: "050 123 4567" },
        admin,
      );
      expect(user).toMatchObject({ name: "Asha Menon", email: "asha@edapt.in", role: "sales", team: "dubai", active: true });
      // time zone defaults to the team's, phone is normalised (a UAE mobile written locally)
      expect(user.timezone).toBe("Asia/Dubai");
      expect(user.phone).toBe("+971501234567");
      expect(await verifyPassword(tempPassword, user.passwordHash)).toBe(true);

      const rows = await auditRows(and(eq(auditLog.tableName, "users"), eq(auditLog.rowId, user.id)));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: "insert", userId: admin.id });
      expect(JSON.stringify(rows[0].newValue)).not.toContain("passwordHash");
      expect(JSON.stringify(rows[0].newValue)).not.toContain(tempPassword);
    });

    it("rejects duplicate emails (any case), bad input and non-admins", async () => {
      const admin = await makeUser({ role: "admin" });
      const manager = await makeUser({ role: "manager" });
      await createUser({ name: "A", email: "a@edapt.in", role: "sales", team: "kerala", timezone: null, phone: null }, admin);
      await expect(
        createUser({ name: "B", email: "A@EDAPT.IN", role: "sales", team: "kerala", timezone: null, phone: null }, admin),
      ).rejects.toThrow(/already uses that email/);
      await expect(
        createUser({ name: "B", email: "not-an-email", role: "sales", team: null, timezone: null, phone: null }, admin),
      ).rejects.toMatchObject({ field: "email" });
      await expect(
        createUser({ name: "B", email: "b@edapt.in", role: "owner", team: null, timezone: null, phone: null }, admin),
      ).rejects.toMatchObject({ field: "role" });
      await expect(
        createUser({ name: "B", email: "b@edapt.in", role: "sales", team: "mars", timezone: null, phone: null }, admin),
      ).rejects.toMatchObject({ field: "team" });
      await expect(
        createUser({ name: "B", email: "b@edapt.in", role: "sales", team: null, timezone: "Mars/Olympus", phone: null }, admin),
      ).rejects.toMatchObject({ field: "timezone" });
      await expect(
        createUser({ name: "B", email: "b@edapt.in", role: "sales", team: null, timezone: null, phone: null }, manager),
      ).rejects.toBeInstanceOf(AdminForbiddenError);
    });

    it("edits role, team and time zone with a field-by-field audit", async () => {
      const admin = await makeUser({ role: "admin" });
      const u = await makeUser({ role: "sales", team: "kerala", name: "Biju" });
      const after = await updateUser(u.id, { name: "Biju", role: "manager", team: "dubai", timezone: "Asia/Dubai", phone: null }, admin);
      expect(after).toMatchObject({ role: "manager", team: "dubai", timezone: "Asia/Dubai" });
      const rows = await auditRows(and(eq(auditLog.tableName, "users"), eq(auditLog.rowId, u.id)));
      expect(Object.fromEntries(rows.map((r) => [r.field, [r.oldValue, r.newValue]]))).toEqual({
        role: ["sales", "manager"],
        team: ["kerala", "dubai"],
        timezone: ["Asia/Kolkata", "Asia/Dubai"],
      });
    });

    it("does not let someone who owns contacts become support", async () => {
      const admin = await makeUser({ role: "admin" });
      const s = await makeUser({ role: "sales" });
      await lead({ ownerId: s.id });
      await expect(updateUser(s.id, { name: s.name, role: "support", team: "kerala", timezone: null, phone: null }, admin)).rejects.toThrow(
        /owns 1 contact\. Support never owns/,
      );
    });

    it("resets a password: new temporary password, old sessions end, audited without secrets", async () => {
      const admin = await makeUser({ role: "admin" });
      const u = await makeUser({ role: "sales" });
      await db.insert(sessions).values({ id: `s-${u.id}`, userId: u.id, expiresAt: new Date(Date.now() + 3600_000) });
      const { tempPassword, sessionsEnded } = await resetUserPassword(u.id, admin);
      expect(sessionsEnded).toBe(1);
      const [row] = await db.select().from(users).where(eq(users.id, u.id));
      expect(await verifyPassword(tempPassword, row.passwordHash)).toBe(true);
      const [a] = await auditRows(and(eq(auditLog.tableName, "users"), eq(auditLog.field, "password")));
      expect(a.newValue).toBe("reset");
    });

    it("deactivates a leaver: hands every contact and open task over, ends sessions, all in one action", async () => {
      const admin = await makeUser({ role: "admin" });
      const manager = await makeUser({ role: "manager", team: "kerala" });
      const leaver = await makeUser({ role: "sales", team: "kerala", name: "Leaver" });
      const c1 = await lead({ ownerId: leaver.id });
      const c2 = await lead({ ownerId: leaver.id });
      await createTask({ contactId: c1.id, userId: leaver.id, type: "follow_up", reason: "Call back" });
      await db.insert(sessions).values({ id: `s-${leaver.id}`, userId: leaver.id, expiresAt: new Date(Date.now() + 3600_000) });

      expect(await defaultHandoverTarget(leaver.id)).toBe(manager.id);
      const r = await deactivateUser(leaver.id, manager.id, admin);
      expect(r).toEqual({ moved: 2, sessionsEnded: 1 });

      const owned = await db.select({ id: contacts.id, ownerId: contacts.ownerId, firstOwnerId: contacts.firstOwnerId }).from(contacts);
      expect(owned.every((c) => c.ownerId === manager.id)).toBe(true);
      // the first owner never changes
      expect(owned.find((c) => c.id === c1.id)?.firstOwnerId).toBe(leaver.id);
      const logs = await db.select().from(ownershipLog).where(eq(ownershipLog.toUserId, manager.id));
      expect(logs.map((l) => l.contactId).sort()).toEqual([c1.id, c2.id].sort());
      expect(logs.every((l) => l.reason === "Owner left the team" && l.changedById === admin.id)).toBe(true);
      const openTasks = await db.select().from(tasks).where(eq(tasks.status, "open"));
      expect(openTasks.every((t) => t.userId === manager.id)).toBe(true);
      const [u] = await db.select().from(users).where(eq(users.id, leaver.id));
      expect(u.active).toBe(false);
      expect(await db.select().from(sessions).where(eq(sessions.userId, leaver.id))).toHaveLength(0);
      const deact = await auditRows(and(eq(auditLog.rowId, leaver.id), eq(auditLog.field, "active")));
      expect(deact[0]).toMatchObject({ oldValue: true, newValue: false, userId: admin.id });

      // reactivating does not take the contacts back
      await reactivateUser(leaver.id, admin);
      const [again] = await db.select().from(users).where(eq(users.id, leaver.id));
      expect(again.active).toBe(true);
      expect((await db.select().from(contacts).where(eq(contacts.ownerId, leaver.id))).length).toBe(0);
    });

    it("rolls everything back when the handover target is not allowed (support never owns)", async () => {
      const admin = await makeUser({ role: "admin" });
      const support = await makeUser({ role: "support" });
      const leaver = await makeUser({ role: "sales" });
      await lead({ ownerId: leaver.id });
      await expect(deactivateUser(leaver.id, support.id, admin)).rejects.toMatchObject({ field: "handoverTo" });
      await expect(deactivateUser(leaver.id, null, admin)).rejects.toThrow(/Choose who receives/);
      const [u] = await db.select().from(users).where(eq(users.id, leaver.id));
      expect(u.active).toBe(true);
      expect((await db.select().from(contacts).where(eq(contacts.ownerId, leaver.id))).length).toBe(1);
    });

    it("protects the last active admin and refuses self-deactivation", async () => {
      const admin = await makeUser({ role: "admin", name: "Umer" });
      const manager = await makeUser({ role: "manager" });
      await expect(deactivateUser(admin.id, manager.id, admin)).rejects.toThrow(/your own account/);
      await expect(
        updateUser(admin.id, { name: "Umer", role: "manager", team: "kerala", timezone: null, phone: null }, admin),
      ).rejects.toThrow(/only active admin/);

      // an admin acting on a stale session cannot remove the last active one either
      const former = await makeUser({ role: "admin", active: false });
      await expect(deactivateUser(admin.id, manager.id, { id: former.id, role: "admin" })).rejects.toThrow(/only active admin/);

      // with a second active admin, either can step down
      const second = await makeUser({ role: "admin" });
      await updateUser(admin.id, { name: "Umer", role: "manager", team: "kerala", timezone: null, phone: null }, second);
      const [a] = await db.select().from(users).where(eq(users.id, admin.id));
      expect(a.role).toBe("manager");
    });

    it("hands over to an admin when there is no manager", async () => {
      const admin = await makeUser({ role: "admin" });
      const leaver = await makeUser({ role: "sales" });
      expect(await defaultHandoverTarget(leaver.id)).toBe(admin.id);
    });
  });

  // -------------------------------------------------------------------------
  describe("settings", () => {
    it("saves with old and new JSON in the audit log; an unchanged save writes nothing", async () => {
      const admin = await makeUser({ role: "admin" });
      const t = structuredClone(DEFAULT_SETTINGS.thresholds);
      t.todayCap = 25;
      const r = await saveSettingAudited("thresholds", t, admin);
      expect(r.changed).toBe(true);
      expect((await getSetting("thresholds")).todayCap).toBe(25);
      const rows = await auditRows(and(eq(auditLog.tableName, "settings"), eq(auditLog.rowId, "thresholds")));
      expect(rows).toHaveLength(1);
      expect((rows[0].oldValue as { todayCap: number }).todayCap).toBe(40);
      expect((rows[0].newValue as { todayCap: number }).todayCap).toBe(25);
      expect(rows[0].userId).toBe(admin.id);

      expect((await saveSettingAudited("thresholds", t, admin)).changed).toBe(false);
      expect(await auditRows(and(eq(auditLog.tableName, "settings")))).toHaveLength(1);
    });

    it("only the admin can save settings", async () => {
      const manager = await makeUser({ role: "manager" });
      await expect(saveSettingAudited("thresholds", DEFAULT_SETTINGS.thresholds, manager)).rejects.toBeInstanceOf(AdminForbiddenError);
    });

    it("validates scoring before saving: negatives rejected, spec defaults clean", () => {
      const lists = {
        industries: DEFAULT_SETTINGS["lists.industries"].map((i) => i.key),
        ageBands: DEFAULT_SETTINGS["lists.ageBands"].map((i) => i.key),
      };
      const good = validateScoring(DEFAULT_SETTINGS.scoring, lists);
      expect(good.ok && good.warnings).toEqual([]);
      const bad = structuredClone(DEFAULT_SETTINGS.scoring);
      bad.fit.spendingBand["3"] = -1;
      expect(validateScoring(bad, lists)).toMatchObject({ ok: false, error: expect.stringMatching(/cannot be negative/) });
    });

    it("teams: a team with members, or one leads are sent to, cannot be removed", async () => {
      const admin = await makeUser({ role: "admin" });
      await makeUser({ role: "sales", team: "dubai" });
      const onlyKerala = DEFAULT_SETTINGS.teams.filter((t) => t.key === "kerala");
      await expect(saveTeams(onlyKerala, admin)).rejects.toThrow(/still has 1 team member/);
      await db.update(users).set({ team: "kerala" });
      await expect(saveTeams(onlyKerala, admin)).rejects.toThrow(/Change the assignment rules first/);
      await saveAssignment({ gccCountries: "ae, sa", gccTeam: "kerala", defaultTeam: "kerala", autoAssign: "on" }, admin);
      expect(await getSetting("assignment")).toEqual({ gccCountries: ["AE", "SA"], gccTeam: "kerala", defaultTeam: "kerala", autoAssign: true });
      await saveTeams(onlyKerala, admin);
      expect(await getSetting("teams")).toEqual(onlyKerala);
    });

    it("shows each team's round-robin order with how many contacts each person owns", async () => {
      const a = await makeUser({ role: "sales", team: "kerala", name: "A" });
      const b = await makeUser({ role: "sales", team: "kerala", name: "B" });
      await makeUser({ role: "sales", team: "kerala", active: false });
      await makeUser({ role: "manager", team: "kerala" });
      // the first lead goes to A (never assigned, created first), so B is next in line
      await lead();
      await lead({ ownerId: a.id });
      const rr = await roundRobinByTeam();
      expect(rr.get("kerala")?.map((m) => [m.id, m.contactCount])).toEqual([
        [b.id, 0],
        [a.id, 2],
      ]);
      expect(rr.get("dubai")).toBeUndefined();
    });

    it("lists: keys in use or used by the system can be switched off but not removed", async () => {
      const admin = await makeUser({ role: "admin" });
      await lead({ firstDoor: "youtube", campaign: "claude_mastery_meta" });
      const usage = await listUsage("lists.campaigns");
      expect(usage.get("claude_mastery_meta")).toMatchObject({ enquiries: 1, contacts: 1 });

      const campaigns = DEFAULT_SETTINGS["lists.campaigns"];
      await expect(saveList("lists.campaigns", campaigns.filter((c) => c.key !== "claude_mastery_meta"), admin)).rejects.toThrow(
        /is in use/,
      );
      // an unused campaign can go; a used one can be renamed and switched off
      const next = campaigns
        .filter((c) => c.key !== "koduvally_ai_literacy")
        .map((c) => (c.key === "claude_mastery_meta" ? { ...c, label: "Claude Mastery (Meta)", active: false } : c));
      await saveList("lists.campaigns", next, admin);
      const saved = await getSetting("lists.campaigns");
      expect(saved.map((c) => c.key)).not.toContain("koduvally_ai_literacy");
      expect(saved.find((c) => c.key === "claude_mastery_meta")).toEqual({ key: "claude_mastery_meta", label: "Claude Mastery (Meta)", active: false });

      const doors = DEFAULT_SETTINGS["lists.firstDoors"].filter((d) => d.key !== "referral");
      await expect(saveList("lists.firstDoors", doors, admin)).rejects.toThrow(/used by the system/);
      // first doors named by a next-best-offer rule count as in use
      const tagUsage = await listUsage("lists.tags");
      expect(tagUsage.get("Legacy: Delegation")?.rules).toBe(1);
    });

    it("lists: campaigns on purchases and first doors written by capture mappings count as in use", async () => {
      const admin = await makeUser({ role: "admin" });
      const c = await lead();
      await db.insert(purchases).values({ contactId: c.id, productName: "Workshop", family: "workshop", amount: 699, amountInr: 699, mode: "cash", campaign: "koduvally_ai_literacy" });
      expect((await listUsage("lists.campaigns")).get("koduvally_ai_literacy")).toMatchObject({ purchases: 1, total: 1 });
      await expect(
        saveList("lists.campaigns", DEFAULT_SETTINGS["lists.campaigns"].filter((x) => x.key !== "koduvally_ai_literacy"), admin),
      ).rejects.toThrow(/is in use/);

      // "youtube" is not a system key and no contact has it, but the WhatsApp buttons and form answers still write it
      const doors = await listUsage("lists.firstDoors");
      expect(doors.get("youtube")?.mappings).toBeGreaterThan(0);
      await expect(saveList("lists.firstDoors", DEFAULT_SETTINGS["lists.firstDoors"].filter((d) => d.key !== "youtube"), admin)).rejects.toThrow(
        /is in use/,
      );
      // a door nothing uses can go
      await saveList("lists.firstDoors", [...DEFAULT_SETTINGS["lists.firstDoors"], { key: "podcast", label: "Podcast" }], admin);
      await saveList("lists.firstDoors", DEFAULT_SETTINGS["lists.firstDoors"], admin);
      expect((await getSetting("lists.firstDoors")).map((d) => d.key)).not.toContain("podcast");
    });
  });

  // -------------------------------------------------------------------------
  describe("products and ladder", () => {
    it("derives the rung from the family, guards TagMango ids, and moves products when a family changes rung", async () => {
      const admin = await makeUser({ role: "admin" });
      const p = await createProduct(
        { name: "Claude Mastery", family: "workshop", listPrice: 999, currency: "inr", active: true, externalIds: ["tm-1", " tm-1 ", "Claude*"], description: null },
        admin,
      );
      expect(p).toMatchObject({ rung: 1, currency: "INR", externalIds: ["tm-1", "Claude*"] });
      await expect(
        createProduct({ name: "Other", family: "workshop", listPrice: 1, currency: "INR", active: true, externalIds: ["tm-1"], description: null }, admin),
      ).rejects.toThrow(/already belongs to Claude Mastery/);
      await expect(
        createProduct({ name: "X", family: "nope", listPrice: 1, currency: "INR", active: true, externalIds: [], description: null }, admin),
      ).rejects.toMatchObject({ field: "family" });
      await expect(
        createProduct({ name: "X", family: "workshop", listPrice: 1, currency: "JPY", active: true, externalIds: [], description: null }, admin),
      ).rejects.toMatchObject({ field: "currency" });

      const moved = await updateProduct(p.id, { name: "Claude Mastery", family: "applied_ai_mastery", listPrice: 1500, currency: "INR", active: true, externalIds: ["tm-1"], description: null }, admin);
      expect(moved.rung).toBe(2);

      const families = DEFAULT_SETTINGS["ladder.families"].map((f) => (f.key === "applied_ai_mastery" ? { ...f, rung: 3 } : f));
      const r = await saveLadder({ rungs: DEFAULT_SETTINGS["ladder.rungs"], families }, admin);
      expect(r.productsMoved).toBe(1);
      const [after] = await db.select().from(products).where(eq(products.id, p.id));
      expect(after.rung).toBe(3);

      // a family in use cannot be removed
      await expect(
        saveLadder({ rungs: DEFAULT_SETTINGS["ladder.rungs"], families: families.filter((f) => f.key !== "applied_ai_mastery") }, admin),
      ).rejects.toThrow(/cannot be removed/);
    });

    it("deletes only products nobody bought", async () => {
      const admin = await makeUser({ role: "admin" });
      const p = await createProduct({ name: "Used", family: "workshop", listPrice: 699, currency: "INR", active: true, externalIds: [], description: null }, admin);
      const c = await lead();
      await db.insert(purchases).values({ contactId: c.id, productId: p.id, productName: "Used", family: "workshop", amount: 699, amountInr: 699, mode: "cash" });
      await expect(deleteProduct(p.id, admin)).rejects.toThrow(/Switch it off instead/);
      const q = await createProduct({ name: "Unused", family: "workshop", listPrice: 699, currency: "INR", active: true, externalIds: [], description: null }, admin);
      await deleteProduct(q.id, admin);
      expect(await db.select().from(products).where(eq(products.id, q.id))).toHaveLength(0);
      const [a] = await auditRows(and(eq(auditLog.tableName, "products"), eq(auditLog.action, "delete")));
      expect(a.rowId).toBe(q.id);
    });

    it("keeps the family TagMango falls back to, and the fallback currency's last rate", async () => {
      const admin = await makeUser({ role: "admin" });
      const rungs = DEFAULT_SETTINGS["ladder.rungs"];
      // unused by products and purchases, but Settings > Integrations sends unknown TagMango products there
      await saveSettingAudited("integrations.options", { ...DEFAULT_SETTINGS["integrations.options"], tagmangoDefaultFamily: "consulting", defaultCurrency: "USD" }, admin);
      await expect(
        saveLadder({ rungs, families: DEFAULT_SETTINGS["ladder.families"].filter((f) => f.key !== "consulting") }, admin),
      ).rejects.toThrow(/TagMango orders for unknown products/);
      // any other unused family can still go
      await saveLadder({ rungs, families: DEFAULT_SETTINGS["ladder.families"].filter((f) => f.key !== "premium") }, admin);

      await editCurrency({ op: "enable", currency: "USD", on: false }, admin);
      await editCurrency({ op: "deleteRate", currency: "USD", month: "2026-01" }, admin);
      await expect(editCurrency({ op: "deleteRate", currency: "USD", month: "2026-10" }, admin)).rejects.toThrow(/read as USD/);
      // AED is nobody's fallback: its rates can all go once it is off
      await editCurrency({ op: "enable", currency: "AED", on: false }, admin);
      await editCurrency({ op: "deleteRate", currency: "AED", month: "2026-01" }, admin);
      await editCurrency({ op: "deleteRate", currency: "AED", month: "2026-10" }, admin);
      expect((await getSetting("currency")).rates.AED).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("exports", () => {
    it("non-admins are refused and the attempt is logged", async () => {
      const sales = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      await expect(prepareExport("contacts", sales, { grade: "A" })).rejects.toBeInstanceOf(AdminForbiddenError);
      await expect(prepareExport("purchases", manager, {})).rejects.toBeInstanceOf(AdminForbiddenError);
      const rows = await auditRows(eq(auditLog.action, "export_denied"));
      expect(rows.map((r) => [r.tableName, r.userId])).toEqual([
        ["contacts", sales.id],
        ["purchases", manager.id],
      ]);
      expect(rows[0].newValue).toMatchObject({ filters: { grade: "A" }, role: "sales" });
    });

    it("streams every matching contact in batches and logs the filter and row count first", async () => {
      const admin = await makeUser({ role: "admin" });
      const owner = await makeUser({ role: "sales", name: "Asha" });
      for (let i = 0; i < 7; i++) await lead({ name: `Person ${i}`, ownerId: owner.id, firstDoor: "youtube" });
      await lead({ name: "=HYPERLINK(\"x\")", firstDoor: "meta_ad", skipAssignment: true });
      await lead({ name: 'Quote "and", comma', firstDoor: "youtube", tags: ["VIP"], skipAssignment: true });

      const all = await prepareExport("contacts", admin, {}, { batchSize: 3, now: new Date("2026-10-13T06:00:00Z") });
      expect(all.fileName).toBe("edapt-contacts-2026-10-13.csv");
      expect(all.rows).toBe(9);
      const csv = parseCsv(await readStream(all.stream));
      expect(csv[0].slice(0, 3)).toEqual(["Contact id", "Name", "Phone"]);
      expect(csv).toHaveLength(10);
      const names = csv.slice(1).map((r) => r[1]);
      // a name that would run as a spreadsheet formula is neutralised with a leading apostrophe
      expect(names.some((n) => /^'=hyperlink\("x"\)$/i.test(n))).toBe(true);
      expect(names.map((n) => n.toLowerCase())).toContain('quote "and", comma');
      const phoneCol = csv.slice(1).map((r) => r[2]);
      expect(phoneCol.every((p) => p.startsWith("+91"))).toBe(true);
      const door = csv[0].indexOf("First door");
      expect(csv.slice(1).some((r) => r[door] === "YouTube")).toBe(true);
      const ownerCol = csv[0].indexOf("Owner");
      expect(csv.slice(1).filter((r) => r[ownerCol] === "Asha")).toHaveLength(7);

      // filters match the Contacts list URL
      const vip = await prepareExport("contacts", admin, new URLSearchParams("tag=VIP&door=youtube"));
      expect(vip.rows).toBe(1);
      expect(parseCsv(await readStream(vip.stream))).toHaveLength(2);

      const logs = await auditRows(eq(auditLog.action, "export"));
      expect(logs).toHaveLength(2);
      expect(logs[0]).toMatchObject({ tableName: "contacts", userId: admin.id });
      expect(logs[0].newValue).toMatchObject({ rows: 9, filters: {}, fileName: "edapt-contacts-2026-10-13.csv" });
      expect(logs[1].newValue).toMatchObject({ rows: 1, filters: { door: "youtube", tag: "VIP" } });
    });

    it("exports purchases with date filters in the admin's time zone", async () => {
      const admin = await makeUser({ role: "admin" });
      const c = await lead({ name: "Buyer" });
      // 13 Oct 00:30 in India is still 12 Oct in UTC
      await db.insert(purchases).values([
        { contactId: c.id, productName: "Workshop", family: "workshop", amount: 699, amountInr: 699, mode: "cash", reference: "R1", purchasedAt: new Date("2026-10-12T19:00:00Z") },
        { contactId: c.id, productName: "Mastery", family: "applied_ai_mastery", amount: 300, currency: "AED", fxRate: 22.7, amountInr: 6810, mode: "bank_transfer", reference: "R2", purchasedAt: new Date("2026-10-11T10:00:00Z") },
      ]);
      const e = await prepareExport("purchases", admin, { from: "2026-10-13", to: "2026-10-13" });
      expect(e.rows).toBe(1);
      const csv = parseCsv(await readStream(e.stream));
      expect(csv).toHaveLength(2);
      expect(csv[1][csv[0].indexOf("Reference")]).toBe("R1");
      expect(csv[1][csv[0].indexOf("Contact")]).toBe("Buyer");
      expect(csv[1][csv[0].indexOf("Credited to")]).toBe("Self-serve");
      const all = await prepareExport("purchases", admin, { family: "applied_ai_mastery" });
      const rows = parseCsv(await readStream(all.stream));
      expect(rows[1][rows[0].indexOf("Currency")]).toBe("AED");
      expect(rows[1][rows[0].indexOf("Amount (INR)")]).toBe("6810");
    });
  });

  // -------------------------------------------------------------------------
  describe("audit log viewer and recalculation", () => {
    it("pages newest first with keyset cursors and filters by user and action", async () => {
      const admin = await makeUser({ role: "admin" });
      const other = await makeUser({ role: "manager" });
      for (let i = 0; i < 5; i++) {
        await db.insert(auditLog).values({ tableName: "settings", rowId: `k${i}`, action: "update", userId: i % 2 ? other.id : admin.id });
      }
      const p1 = await listAuditLog({}, { limit: 2 });
      expect(p1.rows.map((r) => r.rowId)).toEqual(["k4", "k3"]);
      expect(p1.newerCursor).toBeNull();
      const p2 = await listAuditLog({}, { limit: 2, before: p1.olderCursor });
      expect(p2.rows.map((r) => r.rowId)).toEqual(["k2", "k1"]);
      const p3 = await listAuditLog({}, { limit: 2, before: p2.olderCursor });
      expect(p3.rows.map((r) => r.rowId)).toEqual(["k0"]);
      expect(p3.olderCursor).toBeNull();
      const back = await listAuditLog({}, { limit: 2, after: p2.newerCursor });
      expect(back.rows.map((r) => r.rowId)).toEqual(["k4", "k3"]);
      expect(back.newerCursor).toBeNull();

      const mine = await listAuditLog({ userId: other.id }, {});
      expect(mine.rows.map((r) => r.rowId)).toEqual(["k3", "k1"]);
      expect(mine.rows[0].userName).toBe(other.name);
      expect((await listAuditLog({ action: "export" }, {})).rows).toHaveLength(0);
    });

    it("recalculates every score in chunks", async () => {
      const admin = await makeUser({ role: "admin" });
      for (let i = 0; i < 5; i++) await lead({ firstDoor: "youtube" });
      await db.update(contacts).set({ edaptScore: null, grade: null });
      let cursor: string | null = null;
      let processed = 0;
      let calls = 0;
      do {
        const r: Awaited<ReturnType<typeof recalcChunk>> = await recalcChunk(cursor, admin, { batchSize: 2 });
        expect(r.total).toBe(5);
        processed += r.processed;
        cursor = r.next;
        calls++;
      } while (cursor && calls < 10);
      expect(processed).toBe(5);
      const rows = await db.select({ score: contacts.edaptScore }).from(contacts);
      expect(rows.every((r) => r.score !== null)).toBe(true);
      expect((await auditRows(eq(auditLog.action, "recompute"))).length).toBe(1);
      const manager = await makeUser({ role: "manager" });
      await expect(recalcChunk(null, manager)).rejects.toBeInstanceOf(AdminError);
    });
  });

});

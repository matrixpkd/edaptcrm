import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { products } from "@/db/schema";
import { DEMO_EMAILS, demoCounts, seedDemo, type DemoSummary } from "../../scripts/seed-demo";
import { STARTER_PRODUCTS } from "../../scripts/starter-products";
import { makeUser, resetDb } from "../support/db";

/**
 * The demo seeder at a small scale: everything goes through the domain services, so the data must satisfy the
 * same invariants the services keep (LTV from verified money, owners never support, references unique, stages
 * and scores written by recompute) and nothing may be stamped in the future.
 */
describe("demo seed (small)", () => {
  let summary: DemoSummary;
  const RealDate = Date;

  beforeAll(async () => {
    await resetDb();
    await makeUser({ role: "admin", name: "Umer Abdussalam", email: "umer@edapt.in" });
    await db.insert(products).values(STARTER_PRODUCTS.map((p) => ({ ...p, active: p.active ?? true })));
    summary = await seedDemo({ contacts: 50, quiet: true, seed: 7 });
  }, 240_000);

  it("puts the real clock back", () => {
    expect(Date).toBe(RealDate);
    expect(Math.abs(Date.now() - new RealDate().getTime())).toBeLessThan(1000);
  });

  it("creates the team with the demo password and sensible time zones", async () => {
    const rows = await db.execute<{ email: string; role: string; team: string | null; timezone: string; has_password: boolean }>(
      sql`select email, role, team, timezone, password_hash is not null as has_password from users order by email`,
    );
    const byEmail = new Map(rows.map((r) => [r.email, r]));
    for (const e of DEMO_EMAILS) expect(byEmail.get(e)?.has_password).toBe(true);
    expect(byEmail.get("meera@edapt.in")?.role).toBe("manager");
    expect(byEmail.get("fatima@edapt.in")?.timezone).toBe("Asia/Dubai");
    expect(byEmail.get("omar@edapt.in")?.team).toBe("dubai");
    expect(byEmail.get("sana@edapt.in")?.role).toBe("support");
  });

  it("builds contacts, customers and the set pieces every screen needs", async () => {
    expect(summary.skipped).toBeUndefined();
    expect(summary.contacts).toBeGreaterThan(60);
    expect(summary.customers).toBeGreaterThan(15);
    expect(summary.ltvInr).toBeGreaterThan(0);
    const c = await demoCounts();
    expect(c.refunds).toBe(2);
    expect(c.unverified).toBeGreaterThanOrEqual(3);
    expect(c.scheduled).toBeGreaterThanOrEqual(3);
    expect(c.rated).toBeGreaterThan(10);
    expect(c.openTasks).toBeGreaterThan(5);
    const [x] = await db.execute<{ abandoned: string; hot: string; transfers: string; orgs: string; lost: string }>(sql`
      select
        (select count(*) from tasks where type = 'abandoned_checkout' and status = 'open') as abandoned,
        (select count(*) from notifications where type = 'hot_lead') as hot,
        (select count(*) from tasks where type = 'transfer_request' and status = 'open') as transfers,
        (select count(distinct organisation_id) from purchases where organisation_id is not null) as orgs,
        (select count(*) from contacts where stage = 'lost' and lost_reason is not null) as lost
    `);
    expect(Number(x.abandoned)).toBeGreaterThanOrEqual(3);
    expect(Number(x.hot)).toBeGreaterThanOrEqual(2);
    expect(Number(x.transfers)).toBeGreaterThanOrEqual(1);
    expect(Number(x.orgs)).toBe(2);
    expect(Number(x.lost)).toBeGreaterThanOrEqual(1);
  });

  it("keeps the services' invariants", async () => {
    const [x] = await db.execute<{ ltv_mismatch: string; support_owned: string; bad_inr: string; future: string; unscored: string; lost_no_reason: string }>(sql`
      select
        (select count(*) from contacts c where c.merged_into_id is null and abs(c.ltv_inr - coalesce((
          select sum(case when p.kind = 'refund' then -p.amount_inr else p.amount_inr end)
          from payments p where p.contact_id = c.id and p.status = 'verified'), 0)) > 0.01) as ltv_mismatch,
        (select count(*) from contacts c join users u on u.id = c.owner_id where u.role = 'support') as support_owned,
        (select count(*) from purchases where abs(amount_inr - round(amount * fx_rate, 2)) > 0.01) as bad_inr,
        (select count(*) from interactions where occurred_at > now() or created_at > now() + interval '1 minute') +
        (select count(*) from purchases where purchased_at > now()) +
        (select count(*) from audit_log where changed_at > now() + interval '1 minute') +
        (select count(*) from ratings where created_at > now() + interval '1 minute') as future,
        (select count(*) from contacts where merged_into_id is null and grade is null) as unscored,
        (select count(*) from contacts where stage = 'lost' and lost_reason is null) as lost_no_reason
    `);
    expect(Number(x.ltv_mismatch)).toBe(0);
    expect(Number(x.support_owned)).toBe(0);
    expect(Number(x.bad_inr)).toBe(0);
    expect(Number(x.future)).toBe(0);
    expect(Number(x.unscored)).toBe(0);
    expect(Number(x.lost_no_reason)).toBe(0);
  });

  it("spreads history over the last 18 months instead of stamping it today", async () => {
    const [x] = await db.execute<{ old_ratings: string; old_audit: string; old_contacts: string }>(sql`
      select
        (select count(*) from ratings where created_at < now() - interval '30 days') as old_ratings,
        (select count(*) from audit_log where changed_at < now() - interval '90 days') as old_audit,
        (select count(*) from contacts where created_at < now() - interval '180 days') as old_contacts
    `);
    expect(Number(x.old_ratings)).toBeGreaterThan(0);
    expect(Number(x.old_audit)).toBeGreaterThan(0);
    expect(Number(x.old_contacts)).toBeGreaterThan(0);
  });

  it("refuses to run twice", async () => {
    const again = await seedDemo({ contacts: 50, quiet: true });
    expect(again.skipped).toMatch(/already loaded/);
  });
});

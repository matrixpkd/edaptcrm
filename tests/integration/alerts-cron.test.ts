import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { GET as frequent } from "@/app/api/cron/frequent/route";
import { GET as nightly } from "@/app/api/cron/nightly/route";
import { GET as weekly } from "@/app/api/cron/weekly/route";
import { makeUser, resetDb } from "../support/db";

const mail = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async () => (mail.fail ? { ok: false, error: "provider down" } : { ok: true, id: "test" })),
}));

const SECRET = process.env.CRON_SECRET!;
const call = (handler: (req: Request) => Promise<Response>, path: string, auth?: string) =>
  handler(new Request(`http://localhost${path}`, { headers: auth ? { authorization: auth } : {} }));

beforeEach(async () => {
  await resetDb();
  mail.fail = false;
});

describe("cron routes", () => {
  it("the test environment has a cron secret", () => {
    expect(SECRET).toBeTruthy();
  });

  it.each([
    ["frequent", frequent],
    ["nightly", nightly],
    ["weekly", weekly],
  ])("/api/cron/%s answers 401 without the secret or with a wrong one", async (name, handler) => {
    const none = await call(handler, `/api/cron/${name}`);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ ok: false, error: "Unauthorized" });
    expect((await call(handler, `/api/cron/${name}`, "Bearer wrong")).status).toBe(401);
    expect((await call(handler, `/api/cron/${name}`, SECRET)).status).toBe(401); // the Bearer prefix is required
  });

  it("frequent runs every 15-minute step and reports counts as JSON", async () => {
    await makeUser({ role: "admin" });
    const res = await call(frequent, "/api/cron/frequent", `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, job: "frequent" });
    expect(Object.keys(body.steps)).toEqual([
      "abandonedCheckouts",
      "releaseStaleLeads",
      "untouchedLeads",
      "followUpsDue",
      "instalmentsDue",
      "unverifiedPayments",
      "sendPendingNotificationEmails",
      "sendDailyDigests",
    ]);
    expect(body.steps.abandonedCheckouts).toMatchObject({ ok: true, result: { abandoned: 0, tasks: 0 } });
  });

  it("nightly recomputes, then raises the repeat-purchase alerts", async () => {
    const res = await call(nightly, "/api/cron/nightly", `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.steps)).toEqual(["recomputeAll", "closeRepurchasedTasks", "dueForNextRung", "atRisk", "vipGoneQuiet"]);
    expect(body.steps.recomputeAll.result).toEqual({ contacts: 0 });
  });

  it("weekly sends the summary", async () => {
    await makeUser({ role: "admin" });
    const res = await call(weekly, "/api/cron/weekly", `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect((await res.json()).steps.sendWeeklySummary.result).toMatchObject({ recipients: 1 });
  });

  it("answers 500 and names the step when a step fails, after running the others", async () => {
    const admin = await makeUser({ role: "admin" });
    await db.insert(notifications).values({ userId: admin.id, type: "hot_lead", title: "Hot lead: X", email: true });
    mail.fail = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(frequent, "/api/cron/frequent", `Bearer ${SECRET}`);
    errors.mockRestore();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.steps.sendPendingNotificationEmails).toMatchObject({ ok: false });
    expect(body.steps.sendPendingNotificationEmails.error).toContain("provider down");
    expect(body.steps.sendDailyDigests.ok).toBeDefined();
  });
});

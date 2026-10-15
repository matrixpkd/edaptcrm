import { describe, expect, it } from "vitest";
import { allowedTargets, moveIntent } from "@/lib/pipeline/rules";
import { agendaWindow, bucketOf, canChangeTask, cleanTitle, dueChips, dueInputs, parseTaskView, resolveDue, TaskError, todayDefaultTime } from "@/lib/tasks/rules";
import { dueLabel } from "@/lib/tasks/view";
import { fillTemplate, templatesFor, unknownPlaceholders, validateTemplates } from "@/lib/templates/whatsapp";
import { bandOf, buildQueue, type QueueTask } from "@/lib/today/rank";

const TZ = "Asia/Kolkata";
// Thursday 15 Oct 2026, 14:00 IST
const NOW = new Date("2026-10-15T08:30:00Z");

describe("task rules", () => {
  it("resolves the due date and time in the person's time zone", () => {
    expect(resolveDue("2026-10-16", "15:30", NOW, TZ).toISOString()).toBe("2026-10-16T10:00:00.000Z");
    // no time: 10:00 local
    expect(resolveDue("2026-10-16", null, NOW, TZ).toISOString()).toBe("2026-10-16T04:30:00.000Z");
    expect(resolveDue("2026-10-16", "09:00", NOW, "Asia/Dubai").toISOString()).toBe("2026-10-16T05:00:00.000Z");
    // earlier today is allowed (a reminder added late), yesterday is not
    expect(resolveDue("2026-10-15", "09:00", NOW, TZ).toISOString()).toBe("2026-10-15T03:30:00.000Z");
    expect(() => resolveDue("2026-10-14", "23:00", NOW, TZ)).toThrow(TaskError);
    expect(() => resolveDue("", "10:00", NOW, TZ)).toThrow("Pick a due date");
    expect(() => resolveDue("2026-02-31", "10:00", NOW, TZ)).toThrow("Pick a real date");
    expect(() => resolveDue("2026-10-16", "25:00", NOW, TZ)).toThrow(/time/);
    expect(() => resolveDue("2030-01-01", "10:00", NOW, TZ)).toThrow(/two years/);
  });

  it("cleans titles and refuses empty or very long ones", () => {
    expect(cleanTitle("  Send   the brochure ")).toBe("Send the brochure");
    expect(() => cleanTitle("   ")).toThrow("Write what needs doing");
    expect(() => cleanTitle("x".repeat(201))).toThrow(/200/);
  });

  it("decides who may change a task", () => {
    const sales = { id: "s1", role: "sales" as const };
    expect(canChangeTask(sales, { userId: "s1", createdById: "m1" })).toBe(true);
    expect(canChangeTask(sales, { userId: "s2", createdById: "s1" })).toBe(true);
    expect(canChangeTask(sales, { userId: "s2", createdById: "m1" })).toBe(false);
    expect(canChangeTask(sales, { userId: null, createdById: null })).toBe(true);
    expect(canChangeTask({ id: "x", role: "support" }, { userId: null, createdById: null })).toBe(false);
    expect(canChangeTask({ id: "m", role: "manager" }, { userId: "s2", createdById: "s2" })).toBe(true);
  });

  it("only managers and admins get the team view", () => {
    expect(parseTaskView("team", { role: "sales" })).toBe("mine");
    expect(parseTaskView("team", { role: "manager" })).toBe("team");
    expect(parseTaskView("nonsense", { role: "admin" })).toBe("mine");
    expect(parseTaskView("agenda", { role: "support" })).toBe("agenda");
  });

  it("buckets and labels due times", () => {
    expect(bucketOf(new Date("2026-10-15T08:00:00Z"), NOW, TZ)).toBe("overdue");
    expect(bucketOf(new Date("2026-10-15T15:00:00Z"), NOW, TZ)).toBe("today");
    expect(bucketOf(new Date("2026-10-15T19:00:00Z"), NOW, TZ)).toBe("upcoming"); // 00:30 IST on the 16th
    expect(dueLabel(new Date("2026-10-15T11:00:00Z"), NOW, TZ)).toBe("Today 4:30 pm");
    expect(dueLabel(new Date("2026-10-16T04:30:00Z"), NOW, TZ)).toBe("Tomorrow 10:00 am");
    expect(dueLabel(new Date("2026-10-13T04:30:00Z"), NOW, TZ)).toBe("Overdue 2 days · 13 Oct");
    expect(dueLabel(new Date("2026-10-15T04:30:00Z"), NOW, TZ)).toBe("Overdue · today 10:00 am");
  });

  it("builds day and week agenda windows of whole local days", () => {
    const week = agendaWindow(NOW, TZ, "week");
    expect(week.days.map((d) => d.key)).toEqual(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"]);
    expect(week.from.toISOString()).toBe("2026-10-14T18:30:00.000Z");
    expect(week.to.toISOString()).toBe("2026-10-21T18:30:00.000Z");
    expect(agendaWindow(NOW, TZ, "week", 1).days[0].key).toBe("2026-10-22");
    expect(agendaWindow(NOW, TZ, "week", -1).days[0].key).toBe("2026-10-08");
    expect(agendaWindow(NOW, TZ, "day", -1).days.map((d) => d.key)).toEqual(["2026-10-14"]);
    // across a DST change (London, 25 Oct 2026) every day is still one calendar day
    const london = agendaWindow(new Date("2026-10-22T12:00:00Z"), "Europe/London", "week");
    expect(london.days.map((d) => d.key)).toEqual(["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"]);
  });

  it("offers local date chips and form values", () => {
    expect(dueChips(NOW, TZ).map((c) => c.date)).toEqual(["2026-10-15", "2026-10-16", "2026-10-18", "2026-10-22"]);
    expect(dueInputs(new Date("2026-10-16T10:00:00Z"), TZ)).toEqual({ date: "2026-10-16", time: "15:30" });
    // a task for today defaults to 10:00, or the next whole hour once 10:00 has passed (14:00 IST -> 15:00)
    expect(todayDefaultTime(NOW, TZ)).toBe("15:00");
    expect(todayDefaultTime(new Date("2026-10-15T02:00:00Z"), TZ)).toBe("10:00");
    expect(todayDefaultTime(new Date("2026-10-15T18:00:00Z"), TZ)).toBe("23:00");
  });

  it("puts overdue manual tasks with overdue follow-ups on Today, and labels them", () => {
    const dayStart = new Date("2026-10-14T18:30:00Z");
    expect(bandOf({ type: "task", dueAt: new Date("2026-10-14T05:00:00Z") }, dayStart)).toBe("overdue");
    expect(bandOf({ type: "task", dueAt: new Date("2026-10-15T05:00:00Z") }, dayStart)).toBe("next");
    const task: QueueTask = {
      id: "t1",
      type: "task",
      reason: "Prepare the Dubai price list",
      dueAt: new Date("2026-10-14T05:00:00Z"),
      priority: 0,
      createdAt: new Date("2026-10-10T05:00:00Z"),
      userId: "u1",
      contact: null,
    };
    const q = buildQueue([task], { now: NOW, timeZone: TZ, cap: 40 });
    expect(q.rows[0]).toMatchObject({ band: "overdue", canDismiss: true, reason: "Prepare the Dubai price list" });
    expect(q.rows[0].context).toContain("Overdue 1 day");
  });
});

describe("pipeline rules", () => {
  it("allows only the stages people set by hand", () => {
    expect(moveIntent("new", "qualified", 0)).toEqual({ kind: "qualify" });
    expect(moveIntent("contacted", "lost", 0)).toEqual({ kind: "lose" });
    expect(moveIntent("repeat", "lost", 3)).toEqual({ kind: "lose" });
    expect(moveIntent("lost", "new", 0)).toEqual({ kind: "reopen" });
    expect(moveIntent("lost", "repeat", 2)).toEqual({ kind: "reopen" });
    expect(moveIntent("first_purchase", "qualified", 1)).toMatchObject({ kind: "none", reason: "Customers are already past Qualified" });
    expect(moveIntent("new", "contacted", 0)).toMatchObject({ kind: "none", reason: "Contacted is set by the system, not by hand" });
    expect(moveIntent("qualified", "qualified", 0).kind).toBe("none");
  });

  it("lists the Move menu choices", () => {
    expect(allowedTargets("new", 0).map((t) => t.stage)).toEqual(["qualified", "lost"]);
    expect(allowedTargets("repeat", 2).map((t) => t.stage)).toEqual(["lost"]);
    expect(allowedTargets("lost", 0)).toEqual([{ stage: "new", label: "Reopen (the system picks the stage)" }]);
  });
});

describe("WhatsApp templates", () => {
  it("fills the placeholders and never leaves a gap", () => {
    expect(fillTemplate("Hi {first_name}, {owner} here about {offer}. ({name})", { name: "Priya Nair", offer: "The AI Office", owner: "Asha" })).toBe(
      "Hi Priya, Asha here about The AI Office. (Priya Nair)",
    );
    expect(fillTemplate("{offer} from {owner}", { name: "Ravi" })).toBe("our next programme from the Edapt team");
    expect(fillTemplate("Hi { FIRST_NAME }, {price}", { name: "Ravi" })).toBe("Hi Ravi, {price}");
    expect(unknownPlaceholders("Hi {first_name} {price} {Discount}")).toEqual(["price", "Discount"]);
  });

  it("validates what an admin saves", () => {
    const ok = validateTemplates([
      { id: "", name: " Intro ", body: " Hi {first_name} " },
      { id: "intro", name: "Second", body: "x", active: false },
    ]);
    expect(ok).toEqual({
      ok: true,
      value: [
        { id: "intro", name: "Intro", body: "Hi {first_name}" },
        { id: "intro_2", name: "Second", body: "x", active: false },
      ],
    });
    const bad = validateTemplates([{ name: "", body: "" }, { name: "A", body: "b" }, { name: "a", body: "c" }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.message)).toEqual(["Give the template a name", "Write the message", "Two templates have this name"]);
    expect(validateTemplates("nope").ok).toBe(false);
  });

  it("offers only templates in use", () => {
    const list = templatesFor(
      [
        { id: "a", name: "A", body: "Hi {first_name}" },
        { id: "b", name: "B", body: "off", active: false },
      ],
      { name: "Meera K" },
    );
    expect(list).toEqual([{ id: "a", name: "A", text: "Hi Meera" }]);
  });
});

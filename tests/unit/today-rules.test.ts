import { describe, expect, it } from "vitest";
import {
  AI_KNOWLEDGE_SCALE,
  SPENDING_POWER_SCALE,
  UMER_FAMILIARITY_SCALE,
  isGccContact,
} from "@/lib/today/rating-scales";
import {
  canActOnTask,
  defaultLogType,
  dismissible,
  FollowUpError,
  resolveFollowUp,
  safeReturnPath,
  suggestedFollowUp,
  suggestedLostReason,
} from "@/lib/today/rules";
import {
  compactAgo,
  greetingFor,
  localDateAt,
  localDayEnd,
  localDayStart,
  localDaysBetween,
  localIsoDate,
  validTimeZone,
} from "@/lib/today/time";

const NOW = new Date("2026-10-13T09:30:00Z"); // 15:00 IST, 13:30 Dubai

describe("time", () => {
  it("finds the user's local day", () => {
    expect(localDayStart(NOW, "Asia/Kolkata").toISOString()).toBe("2026-10-12T18:30:00.000Z");
    expect(localDayEnd(NOW, "Asia/Kolkata").toISOString()).toBe("2026-10-13T18:30:00.000Z");
    expect(localDayStart(NOW, "Asia/Dubai").toISOString()).toBe("2026-10-12T20:00:00.000Z");
    expect(localDayStart(NOW, "Nowhere/Land").toISOString()).toBe("2026-10-12T18:30:00.000Z");
    expect(validTimeZone(null)).toBe("Asia/Kolkata");
  });

  it("counts calendar days, not 24-hour blocks", () => {
    // 23:00 IST on the 12th -> 15:00 IST on the 13th is one calendar day
    expect(localDaysBetween(new Date("2026-10-12T17:30:00Z"), NOW, "Asia/Kolkata")).toBe(1);
    expect(localDaysBetween(new Date("2026-10-13T00:30:00Z"), NOW, "Asia/Kolkata")).toBe(0);
  });

  it("greets by local hour", () => {
    expect(greetingFor(new Date("2026-10-13T03:00:00Z"), "Asia/Kolkata")).toBe("Good morning");
    expect(greetingFor(NOW, "Asia/Kolkata")).toBe("Good afternoon");
    expect(greetingFor(new Date("2026-10-13T13:00:00Z"), "Asia/Kolkata")).toBe("Good evening");
  });

  it("compactAgo", () => {
    expect(compactAgo(new Date(NOW.getTime() - 30_000), NOW)).toBe("just now");
    expect(compactAgo(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe("5m ago");
    expect(compactAgo(new Date(NOW.getTime() - 2 * 3600_000), NOW)).toBe("2h ago");
    expect(compactAgo(new Date(NOW.getTime() - 3 * 86_400_000), NOW)).toBe("3d ago");
  });

  it("parses a local date at 10:00", () => {
    expect(localDateAt("2026-10-20", "Asia/Kolkata")?.toISOString()).toBe("2026-10-20T04:30:00.000Z");
    expect(localDateAt("2026-10-20", "Asia/Dubai")?.toISOString()).toBe("2026-10-20T06:00:00.000Z");
    expect(localDateAt("2026-02-31", "Asia/Kolkata")).toBeNull();
    expect(localDateAt("20-10-2026", "Asia/Kolkata")).toBeNull();
    expect(localIsoDate(new Date("2026-10-13T20:00:00Z"), "Asia/Kolkata")).toBe("2026-10-14");
  });
});

describe("resolveFollowUp", () => {
  it("presets are 10:00 local on the chosen day; none is null", () => {
    expect(resolveFollowUp("tomorrow", null, NOW, "Asia/Kolkata")?.toISOString()).toBe("2026-10-14T04:30:00.000Z");
    expect(resolveFollowUp("in3Days", null, NOW, "Asia/Kolkata")?.toISOString()).toBe("2026-10-16T04:30:00.000Z");
    expect(resolveFollowUp("in1Week", null, NOW, "Asia/Dubai")?.toISOString()).toBe("2026-10-20T06:00:00.000Z");
    expect(resolveFollowUp("none", null, NOW, "Asia/Kolkata")).toBeNull();
    expect(resolveFollowUp(null, null, NOW, "Asia/Kolkata")).toBeNull();
  });

  it("custom dates: today or later, within a year", () => {
    expect(resolveFollowUp("custom", "2026-10-13", NOW, "Asia/Kolkata")?.toISOString()).toBe("2026-10-13T04:30:00.000Z");
    expect(() => resolveFollowUp("custom", "2026-10-12", NOW, "Asia/Kolkata")).toThrow(FollowUpError);
    expect(() => resolveFollowUp("custom", "", NOW, "Asia/Kolkata")).toThrow(/Pick a date/);
    expect(() => resolveFollowUp("custom", "2028-01-01", NOW, "Asia/Kolkata")).toThrow(/within a year/);
    expect(() => resolveFollowUp("someday", null, NOW, "Asia/Kolkata")).toThrow(FollowUpError);
  });
});

describe("log helpers", () => {
  it("support defaults to a support issue, others to a call; ?type wins when valid", () => {
    expect(defaultLogType("support")).toBe("support_issue");
    expect(defaultLogType("sales")).toBe("call");
    expect(defaultLogType("support", "note")).toBe("note");
    expect(defaultLogType("sales", "telegram")).toBe("call");
  });

  it("offers Mark lost only for not interested / wrong number", () => {
    expect(suggestedLostReason("not_interested")).toBe("not_interested");
    expect(suggestedLostReason("wrong_number")).toBe("wrong_number");
    expect(suggestedLostReason("connected")).toBeNull();
    expect(suggestedLostReason(null)).toBeNull();
  });

  it("suggests a follow-up from the outcome", () => {
    expect(suggestedFollowUp("no_answer")).toBe("tomorrow");
    expect(suggestedFollowUp("interested")).toBe("in3Days");
    expect(suggestedFollowUp("not_interested")).toBe("none");
  });

  it("only returns to same-site paths, never back into a form", () => {
    expect(safeReturnPath("/today", "/contacts/x")).toBe("/today");
    expect(safeReturnPath("/today?view=team", "/contacts/x")).toBe("/today?view=team");
    expect(safeReturnPath("https://evil.example", "/contacts/x")).toBe("/contacts/x");
    expect(safeReturnPath("//evil.example", "/contacts/x")).toBe("/contacts/x");
    expect(safeReturnPath("/\\evil.example", "/contacts/x")).toBe("/contacts/x");
    expect(safeReturnPath("/contacts/x/log", "/contacts/x")).toBe("/contacts/x");
    expect(safeReturnPath("/contacts/x/rate?a=1", "/contacts/x")).toBe("/contacts/x");
    expect(safeReturnPath(null, "/contacts/x")).toBe("/contacts/x");
  });
});

describe("canActOnTask", () => {
  const sales = { id: "s1", role: "sales" as const };
  it("assignee, managers and admins act; others do not", () => {
    expect(canActOnTask(sales, { userId: "s1" }, { ownerId: "s1" })).toBe(true);
    expect(canActOnTask(sales, { userId: "s2" }, { ownerId: "s2" })).toBe(false);
    expect(canActOnTask({ id: "m", role: "manager" }, { userId: "s2" }, { ownerId: "s2" })).toBe(true);
    expect(canActOnTask({ id: "a", role: "admin" }, { userId: null }, null)).toBe(true);
  });

  it("pool tasks: sales on contacts they can see; support never", () => {
    expect(canActOnTask(sales, { userId: null }, { ownerId: null })).toBe(true);
    expect(canActOnTask(sales, { userId: null }, { ownerId: "s2" })).toBe(false);
    expect(canActOnTask({ id: "x", role: "support" }, { userId: null }, { ownerId: null })).toBe(false);
  });

  it("follow-ups and transfer requests are not dismissible", () => {
    expect(dismissible("follow_up")).toBe(false);
    expect(dismissible("transfer_request")).toBe(false);
    expect(dismissible("at_risk")).toBe(true);
  });
});

describe("rating scales", () => {
  it("keeps the spec's anchors word for word", () => {
    expect(AI_KNOWLEDGE_SCALE.map((a) => [a.value, a.text])).toEqual([
      [0, "Has never used an AI tool"],
      [1, "Tried ChatGPT or similar a few times"],
      [2, "Uses AI now and then for simple tasks"],
      [3, "Uses AI every week in work or business"],
      [4, "Power user: several tools, builds own workflows"],
      [5, "Builds with AI (automations, agents, apps) or works in tech"],
    ]);
    expect(UMER_FAMILIARITY_SCALE.map((a) => [a.value, a.text])).toEqual([
      [0, "Does not know Umer"],
      [1, "Knows the name or saw an ad"],
      [2, "Has watched a few of his videos"],
      [3, "Watches regularly and can recall his ideas"],
      [4, "Follows closely: read his book, or attended his session or keynote"],
      [5, "Personal connection: has met him or is in his network"],
    ]);
    expect(SPENDING_POWER_SCALE.map((b) => [b.value, b.name, b.india, b.gcc])).toEqual([
      [1, "Low", "Under ₹3 lakh", "Under AED 5,000"],
      [2, "Lower-middle", "₹3 to 8 lakh", "AED 5,000 to 10,000"],
      [3, "Middle", "₹8 to 20 lakh", "AED 10,000 to 20,000"],
      [4, "Upper-middle", "₹20 to 50 lakh", "AED 20,000 to 40,000"],
      [5, "High", "Over ₹50 lakh", "Over AED 40,000"],
    ]);
  });

  it("shows GCC bands for GCC contacts (country first, then phone)", () => {
    const gcc = ["AE", "SA", "QA", "KW", "BH", "OM"];
    expect(isGccContact({ country: "AE", phoneCountry: "IN" }, gcc)).toBe(true);
    expect(isGccContact({ country: "UAE", phoneCountry: null }, gcc)).toBe(true);
    expect(isGccContact({ country: null, phoneCountry: "QA" }, gcc)).toBe(true);
    expect(isGccContact({ country: "IN", phoneCountry: "AE" }, gcc)).toBe(false);
    expect(isGccContact({ country: null, phoneCountry: null }, gcc)).toBe(false);
  });
});

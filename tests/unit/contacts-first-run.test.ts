import { describe, expect, it } from "vitest";
import { assigneeLabel, assignReason, autoAssignHint } from "@/lib/contacts/rules";
import { cleanFlash, FLASH_COOKIE, FLASH_MAX_LENGTH, readFlashCookie } from "@/lib/flash-cookie";

// what Next's cookies().set() does to the value
const asSet = (m: string) => encodeURIComponent(cleanFlash(m));

describe("assignReason", () => {
  it("keeps what the manager typed", () => {
    expect(assignReason("  Speaks Arabic ", "u1", "u2")).toBe("Speaks Arabic");
  });
  it("says what kind of move it was when the box is empty", () => {
    expect(assignReason("", null, "u2")).toBe("Assigned from the pool by a manager");
    expect(assignReason(null, "u1", "u2")).toBe("Reassigned by a manager");
    expect(assignReason(undefined, "u1", null)).toBe("Unassigned to the pool by a manager");
  });
});

describe("assigneeLabel", () => {
  it("shows the role and the team", () => {
    expect(assigneeLabel({ name: "Kiran", role: "sales", team: "kerala" })).toBe("Kiran (Sales, Kerala)");
    expect(assigneeLabel({ name: "Dina", role: "sales", team: "dubai" }, () => "Dubai office")).toBe(
      "Dina (Sales, Dubai office)",
    );
    expect(assigneeLabel({ name: "Umer", role: "admin", team: null })).toBe("Umer (Admin)");
  });
});

describe("autoAssignHint", () => {
  const teams = [
    { key: "kerala", label: "Kerala" },
    { key: "dubai", label: "Dubai" },
  ];
  const cfg = { autoAssign: true, gccTeam: "dubai", defaultTeam: "kerala" };
  it("tells a brand-new CRM that leads wait in the pool until there are salespeople", () => {
    expect(autoAssignHint(cfg, teams, false)).toMatch(/No salespeople yet/);
    // teammates are added on the Team page (Settings → Users only redirects there)
    expect(autoAssignHint(cfg, teams, false)).toMatch(/on the Team page\.$/);
  });
  it("names the teams from settings", () => {
    expect(autoAssignHint(cfg, teams, true)).toMatch(/GCC numbers go to the Dubai team, the rest to Kerala/);
  });
  it("says when auto-assign is off", () => {
    expect(autoAssignHint({ ...cfg, autoAssign: false }, teams, true)).toMatch(/off in Settings/);
  });
});

describe("flash cookie", () => {
  it("round-trips a message through document.cookie", () => {
    const v = asSet("Call logged.\n Follow-up set.");
    expect(readFlashCookie(`theme=dark; ${FLASH_COOKIE}=${v}; other=1`)).toBe("Call logged. Follow-up set.");
  });
  it("ignores a missing, empty or malformed cookie", () => {
    expect(readFlashCookie("a=1")).toBeNull();
    expect(readFlashCookie(`${FLASH_COOKIE}=`)).toBeNull();
    expect(readFlashCookie(`${FLASH_COOKIE}=%E0%A4%A`)).toBeNull();
    expect(cleanFlash("   ")).toBe("");
  });
  it("caps the length", () => {
    expect(readFlashCookie(`${FLASH_COOKIE}=${asSet("x".repeat(500))}`)).toHaveLength(FLASH_MAX_LENGTH);
  });
});

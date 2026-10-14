/** vercel.json must deploy on the Hobby plan: at most 2 cron jobs, each running at most once a day. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const config = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")) as {
  crons?: { path: string; schedule: string }[];
};
const crons = config.crons ?? [];

describe("vercel.json crons", () => {
  it("has at most two cron jobs (the Hobby limit)", () => {
    expect(crons.length).toBeLessThanOrEqual(2);
  });

  it.each(crons.map((c) => [c.path, c.schedule]))("%s (%s) runs at most once a day", (_path, schedule) => {
    const fields = schedule.trim().split(/\s+/);
    expect(fields).toHaveLength(5);
    const [minute, hour] = fields;
    // a single fixed minute and hour: no "*", "*/n", ranges or lists
    expect(minute).toMatch(/^\d{1,2}$/);
    expect(hour).toMatch(/^\d{1,2}$/);
  });

  it.each(crons.map((c) => [c.path]))("%s is an existing cron route", (p) => {
    expect(existsSync(path.join(root, "src/app", p, "route.ts"))).toBe(true);
  });
});

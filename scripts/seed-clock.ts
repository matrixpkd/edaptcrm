/**
 * A simulated clock for the demo seeder, so 18 months of history can be built through the real domain services.
 *
 * The services stamp "now" with `new Date()` (stage changes, owner assignments, verifications, follow-up tasks,
 * the ownership log...). While the clock runs, `new Date()` and `Date.now()` return the simulated time instead,
 * advancing in real time from the last `set()`, so every service behaves exactly as it would have on that day.
 *
 * Columns filled by Postgres defaults (`created_at default now()`) still get the real time. `mark()` records which
 * simulated moment each stretch of real time belonged to (using the database's own clock), and
 * `backdateDefaults()` moves those values onto the simulated timeline at the end. Development seeding only.
 */
import { sql } from "drizzle-orm";
import { db, queryRows } from "@/db";

const RealDate = Date;

type Mark = { real: string; sim: number };

export type SimClock = {
  /** jump to a simulated moment (it then advances in real time) */
  set(at: Date): void;
  /** the simulated time now */
  now(): Date;
  /** remember that rows the database stamps from here on belong to the current simulated moment */
  mark(): Promise<void>;
  /** puts the real Date back */
  stop(): void;
  /** the real time when the clock started (database clock) */
  readonly startedAt: string;
};

/** Replaces the global Date with a simulated one. Call stop() when done (also on errors). */
export async function startSimClock(at: Date): Promise<SimClock> {
  const [{ ts }] = await queryRows<{ ts: string }>(sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts`);
  let base = at.getTime();
  let anchor = RealDate.now();
  const simMs = () => base + (RealDate.now() - anchor);

  class SimDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(simMs());
      else super(...(args as [string | number]));
    }
    static now(): number {
      return simMs();
    }
    // dates made before the switch (or by the real Date) are still dates
    static [Symbol.hasInstance](x: unknown): boolean {
      return x instanceof RealDate;
    }
  }
  globalThis.Date = SimDate as unknown as DateConstructor;

  const marks: Mark[] = [];
  clockState.marks = marks;
  clockState.startedAt = ts;
  return {
    startedAt: ts,
    set(next: Date) {
      base = next.getTime();
      anchor = RealDate.now();
    },
    now: () => new RealDate(simMs()),
    async mark() {
      const sim = simMs();
      const [{ real }] = await queryRows<{ real: string }>(
        sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as real`,
      );
      marks.push({ real, sim });
    },
    stop() {
      globalThis.Date = RealDate;
    },
  };
}

const clockState: { marks: Mark[]; startedAt: string | null } = { marks: [], startedAt: null };

/** Columns Postgres fills with now() on insert, by table. */
const DEFAULT_STAMPED: Record<string, string[]> = {
  users: ["created_at", "updated_at"],
  organisations: ["created_at", "updated_at"],
  products: ["created_at", "updated_at"],
  settings: ["updated_at"],
  contacts: ["created_at", "updated_at"],
  enquiries: ["created_at"],
  interactions: ["created_at"],
  ratings: ["created_at"],
  purchases: ["created_at", "updated_at"],
  payments: ["created_at", "updated_at"],
  ownership_log: ["changed_at"],
  tasks: ["created_at"],
  notifications: ["created_at"],
  contact_merges: ["merged_at"],
  duplicate_reviews: ["created_at"],
  audit_log: ["changed_at"],
};

/**
 * Moves every database-stamped time written while the clock ran (real time, at or after the clock started and
 * before `until`) onto the simulated timeline: a row stamped `x` real time after mark M gets M's simulated time
 * plus `x`. Rows stamped before the clock started or from `until` on are left alone. Returns rows changed.
 */
export async function backdateDefaults(until: string): Promise<number> {
  const marks = clockState.marks;
  const since = clockState.startedAt;
  if (!since || !marks.length) return 0;
  let changed = 0;
  await db.transaction(async (t) => {
    await t.execute(sql`create temp table seed_marks (real_at timestamptz primary key, sim_at timestamptz not null) on commit drop`);
    for (let i = 0; i < marks.length; i += 2000) {
      const chunk = marks.slice(i, i + 2000);
      await t.execute(sql`
        insert into seed_marks (real_at, sim_at)
        select r, to_timestamp(s / 1000.0)
        from unnest(${`{${chunk.map((m) => m.real).join(",")}}`}::timestamptz[], ${`{${chunk.map((m) => m.sim).join(",")}}`}::float8[]) as x(r, s)
        on conflict (real_at) do nothing
      `);
    }
    for (const [table, columns] of Object.entries(DEFAULT_STAMPED)) {
      for (const col of columns) {
        const c = sql.identifier(col);
        const res = await t.execute(sql`
          update ${sql.identifier(table)} t
          set ${c} = coalesce(
            (select m.sim_at + (t.${c} - m.real_at) from seed_marks m where m.real_at <= t.${c} order by m.real_at desc limit 1),
            t.${c}
          )
          where t.${c} >= ${since}::timestamptz and t.${c} < ${until}::timestamptz
        `);
        changed += res.rowCount ?? 0;
      }
    }
  });
  return changed;
}

/**
 * Backdates what the database stamped so far, while the clock is still running. Services that compare a
 * database-stamped time with a simulated one (e.g. "was this alert raised before the payment?") then see the
 * simulated timeline too. Cheap enough to run once a simulated week.
 */
export async function backdateSoFar(): Promise<number> {
  return backdateDefaults(await dbNow());
}

/** The database's clock, as an ISO string (for `backdateDefaults(until)`). */
export async function dbNow(): Promise<string> {
  const [{ ts }] = await queryRows<{ ts: string }>(sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts`);
  return ts;
}

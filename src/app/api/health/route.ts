import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { errorCode } from "@/lib/error-code";
import { isAuthorizedCron } from "@/lib/secrets";

export const dynamic = "force-dynamic";

/** The deployed commit, so a deploy can be confirmed from outside (a short git SHA is not a secret). */
const VERSION = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev";

/**
 * Public liveness check. The database error is logged, never sent: it can name hosts, users or the schema.
 * With ?deep=1 and the cron secret it also runs queries the way the app does (many at once, and inside a
 * transaction), to catch pooler problems that a single `select 1` cannot show.
 */
export async function GET(req: Request) {
  const deep = new URL(req.url).searchParams.get("deep") === "1";
  if (deep && !isAuthorizedCron(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const started = Date.now();
  try {
    await db.execute(sql`select 1`);
    if (!deep) return NextResponse.json({ ok: true, version: VERSION }, { headers: { "Cache-Control": "no-store" } });
    const t1 = Date.now();
    await Promise.all(Array.from({ length: 15 }, (_, i) => db.execute(sql`select ${i}::int as i, count(*) from pg_class`)));
    const parallelMs = Date.now() - t1;
    const t2 = Date.now();
    await db.transaction(async (tx) => {
      await Promise.all(Array.from({ length: 5 }, (_, i) => tx.execute(sql`select ${i}::int as i, count(*) from pg_class`)));
      await tx.transaction(async (sp) => {
        await sp.execute(sql`select 1`);
      });
    });
    const transactionMs = Date.now() - t2;
    return NextResponse.json(
      { ok: true, version: VERSION, parallelMs, transactionMs, totalMs: Date.now() - started },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[health] database check failed", e);
    return NextResponse.json(
      { ok: false, version: VERSION, error: "database unavailable", code: errorCode(e), totalMs: Date.now() - started },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

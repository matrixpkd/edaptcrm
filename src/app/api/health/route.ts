import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { errorCode } from "@/lib/error-code";

export const dynamic = "force-dynamic";

/** Public liveness check. The database error is logged, never sent: it can name hosts, users or the schema. */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[health] database check failed", e);
    return NextResponse.json(
      { ok: false, error: "database unavailable", code: errorCode(e) },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

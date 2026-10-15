import "server-only";
import { and, count, eq, gt, lt } from "drizzle-orm";
import { db } from "@/db";
import { appErrors } from "@/db/schema";

export type AppErrorInput = {
  kind: "server" | "client";
  message: string;
  stack?: string | null;
  digest?: string | null;
  path?: string | null;
  method?: string | null;
  source?: string | null;
  userId?: string | null;
  userAgent?: string | null;
  ip?: string | null;
};

const cut = (s: string | null | undefined, n: number) => (s ? String(s).slice(0, n) : null);

/** Records an error. Never throws: error reporting must not cause a second failure. */
export async function recordAppError(e: AppErrorInput): Promise<void> {
  try {
    await db.insert(appErrors).values({
      kind: e.kind,
      message: cut(e.message, 2000) ?? "(no message)",
      stack: cut(e.stack, 8000),
      digest: cut(e.digest, 100),
      path: cut(e.path, 500),
      method: cut(e.method, 10),
      source: cut(e.source, 30),
      userId: e.userId ?? null,
      userAgent: cut(e.userAgent, 300),
      ip: cut(e.ip, 64),
    });
  } catch (err) {
    console.error("[app-errors] could not record an error", err);
  }
}

/** Browser reports per IP per 10 minutes, so a broken page cannot flood the table. */
export const CLIENT_ERROR_LIMIT = 60;

export async function clientErrorAllowed(ip: string, now = new Date()): Promise<boolean> {
  const [{ n }] = await db
    .select({ n: count() })
    .from(appErrors)
    .where(and(eq(appErrors.ip, ip), eq(appErrors.kind, "client"), gt(appErrors.createdAt, new Date(now.getTime() - 10 * 60_000))));
  return n < CLIENT_ERROR_LIMIT;
}

/** Nightly: errors older than 30 days. */
export async function pruneAppErrors(now = new Date()): Promise<{ deleted: number }> {
  const rows = await db
    .delete(appErrors)
    .where(lt(appErrors.createdAt, new Date(now.getTime() - 30 * 24 * 3600_000)))
    .returning({ id: appErrors.id });
  return { deleted: rows.length };
}

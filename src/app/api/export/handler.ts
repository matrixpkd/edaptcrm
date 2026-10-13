import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { AdminForbiddenError } from "@/lib/admin/errors";
import { prepareExport, type ExportKind } from "@/lib/admin/export";
import { getApiUser } from "@/lib/auth/session";

/**
 * GET /api/export/<kind>?<filters>: a CSV download, admin only. A signed-out request gets 401; anyone else who
 * is not the admin gets 403 and the attempt is logged (audit_log "export_denied"). A successful export is logged
 * with its filters and row count before the first byte is sent, then streamed.
 */
export async function exportResponse(kind: ExportKind, req: NextRequest): Promise<Response> {
  const user = await getApiUser();
  if (!user) return NextResponse.json({ error: "Sign in to export." }, { status: 401 });
  try {
    const e = await prepareExport(kind, user, req.nextUrl.searchParams);
    return new Response(e.stream, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${e.fileName}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Export-Rows": String(e.rows),
      },
    });
  } catch (err) {
    if (err instanceof AdminForbiddenError) {
      return NextResponse.json({ error: "Only the admin can export data. This attempt was logged." }, { status: 403 });
    }
    console.error(`[export] ${kind} failed`, err);
    return NextResponse.json({ error: "The export failed. Try again in a minute." }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth/permissions";
import { getApiUser } from "@/lib/auth/session";
import { getBatchView, invalidRowsCsv } from "@/lib/import/batches";
import { isUuid } from "@/lib/utils";

/** The invalid rows of an import as CSV (original columns + "Problems"), for fixing and re-uploading. Admin only. */
export async function GET(_req: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const user = await getApiUser();
  if (!user) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const { batchId } = await params;
  if (!can(user, "import.run")) {
    // refused exports are logged too, like /api/export
    await audit({ table: "import_rows", rowId: isUuid(batchId) ? batchId : null, action: "export_denied", field: "invalid_rows", newValue: { role: user.role }, userId: user.id });
    return NextResponse.json({ error: "Only an admin can download import rows. This attempt was logged." }, { status: 403 });
  }
  if (!isUuid(batchId)) return NextResponse.json({ error: "Import not found" }, { status: 404 });
  const batch = await getBatchView(batchId, user);
  if (!batch) return NextResponse.json({ error: "Import not found" }, { status: 404 });

  const rows = invalidRowsCsv(batchId, user);
  // the first piece (header) is read before responding, so the export is logged before any data leaves
  const first = await rows.next();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!first.done) controller.enqueue(encoder.encode(first.value));
    },
    async pull(controller) {
      const { value, done } = await rows.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
  });
  const base = batch.fileName.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "import";
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${base}-invalid-rows.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

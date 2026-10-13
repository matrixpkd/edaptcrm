import { NextResponse } from "next/server";
import { getApiUser } from "@/lib/auth/session";
import { readStoredFile } from "@/lib/storage";

export async function GET(_req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const user = await getApiUser();
  if (!user) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const { key } = await params;
  const file = await readStoredFile(key.join("/"));
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });
  if ("redirect" in file) return NextResponse.redirect(file.redirect);
  return new NextResponse(Buffer.from(file.bytes), {
    headers: { "Content-Type": file.contentType, "Cache-Control": "private, max-age=300" },
  });
}

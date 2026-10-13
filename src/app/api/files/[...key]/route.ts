import { NextResponse } from "next/server";
import { getApiUser } from "@/lib/auth/session";
import { canReadStoredFile, cleanStoredKey, readStoredFile, storedFileHeaders } from "@/lib/storage";

/**
 * Serves stored files to signed-in users who may see them (canReadStoredFile): a payment proof only to people who
 * can view the contact it belongs to, an import file only to admins. Anything else, or a file the user may not
 * see, is a 404 (it never tells whether the file exists). Keys with "..", backslashes or NULs are refused
 * (cleanStoredKey). Pictures are shown inline, everything else downloads; responses are never sniffed and carry
 * a sandboxing CSP (storedFileHeaders). With Supabase Storage it redirects to a short-lived signed URL.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const user = await getApiUser();
  if (!user) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const key = cleanStoredKey((await params).key);
  const notFound = () => NextResponse.json({ error: "not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!key || !(await canReadStoredFile(user, key))) return notFound();
  const file = await readStoredFile(key);
  if (!file) return notFound();
  if ("redirect" in file) return NextResponse.redirect(file.redirect, { headers: { "Cache-Control": "private, no-store" } });
  return new NextResponse(Buffer.from(file.bytes), { headers: storedFileHeaders(key, file.contentType) });
}

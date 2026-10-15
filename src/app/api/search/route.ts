import { NextResponse } from "next/server";
import { getApiUser } from "@/lib/auth/session";
import { globalSearch } from "@/lib/search/global";

export const dynamic = "force-dynamic";

/**
 * GET /api/search?q=…[&kinds=contact,organisation,page] — the global search box and the task form's contact
 * picker. Signed-in only; contacts come back inside the person's contactScope.
 */
export async function GET(req: Request) {
  const user = await getApiUser();
  if (!user) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const url = new URL(req.url);
  const kinds = (url.searchParams.get("kinds") ?? "")
    .split(",")
    .filter((k): k is "contact" | "organisation" | "page" => k === "contact" || k === "organisation" || k === "page");
  const hits = await globalSearch(user, url.searchParams.get("q") ?? "", { kinds: kinds.length ? kinds : undefined });
  return NextResponse.json({ hits }, { headers: { "Cache-Control": "private, no-store" } });
}

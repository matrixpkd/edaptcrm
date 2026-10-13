import { NextResponse, type NextRequest } from "next/server";
import { getApiUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { checkQuickAddDuplicate } from "@/lib/contacts/identity";
import { phoneCountry } from "@/lib/phone";
import type { PhoneCheckResponse } from "../types";

export const dynamic = "force-dynamic";

/**
 * The live duplicate check behind Quick Add: normalises what was typed and, for a known number, returns the
 * existing contact with its owner, stage and grade before anything is saved.
 */
export async function GET(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return NextResponse.json({ error: "Sign in again" }, { status: 401 });
  if (!can(user, "contacts.create")) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const raw = (req.nextUrl.searchParams.get("phone") ?? "").slice(0, 40);
  const r = await checkQuickAddDuplicate(raw, user);
  const body: PhoneCheckResponse = {
    valid: r.valid,
    e164: r.e164,
    international: r.international,
    country: r.e164 ? phoneCountry(r.e164) : null,
    existing: r.existing
      ? {
          id: r.existing.id,
          name: r.existing.name,
          ownerName: r.existing.ownerName,
          ownerIsMe: r.existing.ownerId === user.id,
          stage: r.existing.stage,
          grade: r.existing.grade,
          visible: r.existing.visible,
        }
      : null,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

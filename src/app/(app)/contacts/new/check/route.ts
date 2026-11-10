import { NextResponse, type NextRequest } from "next/server";
import { getApiUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { RateLimitedError } from "@/lib/auth/rate-limit";
import { checkQuickAddDuplicate } from "@/lib/contacts/identity";
import { phoneCountry } from "@/lib/phone";
import type { PhoneCheckError, PhoneCheckResponse } from "../types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The live duplicate check behind Quick Add: normalises what was typed and, for a known number, returns the
 * existing contact with its owner before anything is saved. Stage and grade only for a contact the user may open;
 * a colleague's contact gives its name and owner only. Rate limited per user (QUICK_ADD_LOOKUP_LIMIT): 429 over it.
 */
export async function GET(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return NextResponse.json<PhoneCheckError>({ error: "Sign in again" }, { status: 401, headers: NO_STORE });
  if (!can(user, "contacts.create")) {
    return NextResponse.json<PhoneCheckError>({ error: "Not allowed" }, { status: 403, headers: NO_STORE });
  }
  const raw = (req.nextUrl.searchParams.get("phone") ?? "").slice(0, 40);
  let r;
  try {
    r = await checkQuickAddDuplicate(raw, user);
  } catch (e) {
    if (!(e instanceof RateLimitedError)) throw e;
    return NextResponse.json<PhoneCheckError>(
      { error: e.message },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(e.retryAfterMinutes * 60) } },
    );
  }
  const x = r.existing;
  const body: PhoneCheckResponse = {
    valid: r.valid,
    e164: r.e164,
    international: r.international,
    country: r.e164 ? phoneCountry(r.e164) : null,
    existing: !x
      ? null
      : x.visible
        ? {
            visible: true,
            id: x.id,
            name: x.name,
            ownerName: x.ownerName,
            ownerIsMe: x.ownerId === user.id,
            stage: x.stage,
            grade: x.grade,
          }
        : { visible: false, id: x.id, name: x.name, ownerName: x.ownerName, ownerIsMe: false },
  };
  return NextResponse.json(body, { headers: NO_STORE });
}

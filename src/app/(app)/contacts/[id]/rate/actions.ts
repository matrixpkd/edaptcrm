"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, str, type ActionResult } from "@/lib/action";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { ContactError } from "@/lib/contacts/errors";
import { applyRating } from "@/lib/contacts/profile";
import type { RatingInput } from "@/lib/contacts/rules";
import { safeReturnPath } from "@/lib/today/rules";
import { rateAccess } from "@/lib/today/screens";

const MAX_NOTES = 2000;
const INT_FIELDS = ["aiLevel", "umerLevel", "spendingBand", "gutStars"] as const;

/** Saves a sales rating (history row + the contact's latest values), recomputes the scores, goes back. */
export async function rateContactAction(contactId: string, _prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "ratings.edit")) return fail("Only sales, managers and admins rate customers");
  const access = await rateAccess(contactId, user);
  if (!access) return fail("This contact is not available to you");
  if (!access.canRate) return fail("You can only rate your own contacts and the pool");

  const rating: RatingInput = {};
  for (const f of INT_FIELDS) {
    const raw = str(fd, f);
    if (raw === null) continue;
    const n = Number(raw);
    if (!Number.isInteger(n)) return fail("Pick a level from the scale", { [f]: "Pick a level" });
    rating[f] = n;
  }
  rating.ageBand = str(fd, "ageBand");
  rating.industry = str(fd, "industry");
  const notes = str(fd, "notes");
  if (notes && notes.length > MAX_NOTES) return fail(`Keep the notes under ${MAX_NOTES} characters`, { notes: "Too long" });
  rating.notes = notes;
  const rated = INT_FIELDS.some((f) => rating[f] !== undefined) || rating.ageBand || rating.industry;
  if (!rated && !notes) return fail("Tap at least one scale, or write a note");

  try {
    await applyRating(access.contactId, rating, "sales", user.id);
  } catch (e) {
    if (e instanceof ContactError) return fail(e.message, e.field ? { [e.field]: e.message } : undefined);
    throw e;
  }
  revalidatePath(`/contacts/${access.contactId}`);
  revalidatePath("/today");
  redirect(safeReturnPath(str(fd, "return"), `/contacts/${access.contactId}`));
}

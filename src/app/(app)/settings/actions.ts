"use server";
import { revalidatePath } from "next/cache";
import { fail, ok, type ActionResult } from "@/lib/action";
import { recalcChunk } from "@/lib/admin/recalc";
import { adminForAction, failFrom, NOT_ADMIN } from "./_lib/guard";
import type { RecalcChunk } from "./_components/recalc-button";

/**
 * One chunk of "Recalculate all scores now" (Settings > Scoring, Products, Next best offer, Locations).
 * The browser calls it with null first, then with each returned `next` until it is null.
 */
export async function recalcScoresChunkAction(cursor: string | null): Promise<ActionResult<RecalcChunk>> {
  const user = await adminForAction();
  if (!user) return fail(NOT_ADMIN);
  try {
    const r = await recalcChunk(typeof cursor === "string" ? cursor : null, user);
    if (!r.next) {
      revalidatePath("/contacts");
      revalidatePath("/today");
    }
    return ok(r);
  } catch (e) {
    return failFrom(e, "recalculate scores");
  }
}

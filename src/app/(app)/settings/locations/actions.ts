"use server";
import { revalidatePath } from "next/cache";
import { fail, ok, str, type ActionResult } from "@/lib/action";
import { saveSettingAudited } from "@/lib/admin/settings";
import { validateLocations } from "@/lib/admin/validate";
import { adminForAction, failFrom, NOT_ADMIN, withWarnings } from "../_lib/guard";

export async function saveLocationsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  const v = validateLocations({
    keralaCities: str(fd, "keralaCities") ?? "",
    indianMetros: str(fd, "indianMetros") ?? "",
    keralaStateNames: str(fd, "keralaStateNames") ?? "",
  });
  if (!v.ok) return fail(v.error);
  try {
    const { changed } = await saveSettingAudited("locations", v.value, admin);
    revalidatePath("/settings/locations");
    return ok(undefined, withWarnings(changed ? "Locations saved. Fit scores use them from each contact's next change, or recalculate everyone now." : "No changes to save.", v.warnings));
  } catch (e) {
    return failFrom(e, "save locations");
  }
}

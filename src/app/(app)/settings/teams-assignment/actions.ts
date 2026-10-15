"use server";
import { revalidatePath } from "next/cache";
import { bool, fail, ok, str, type ActionResult } from "@/lib/action";
import { saveAssignment, saveTeams } from "@/lib/admin/teams";
import { adminForAction, failFrom, jsonField, NOT_ADMIN, withWarnings } from "../_lib/guard";

const PAGE = "/settings/teams-assignment";

export async function saveTeamsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  const j = jsonField(fd);
  if (!j.ok) return fail("Nothing to save. Reload the page and try again.");
  try {
    const { changed } = await saveTeams(j.value, admin);
    revalidatePath(PAGE);
    revalidatePath("/team");
    return ok(undefined, changed ? "Teams saved." : "No changes to save.");
  } catch (e) {
    return failFrom(e, "save teams");
  }
}

export async function saveAssignmentAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  try {
    const { changed, warnings } = await saveAssignment(
      {
        gccCountries: str(fd, "gccCountries") ?? "",
        gccTeam: str(fd, "gccTeam"),
        defaultTeam: str(fd, "defaultTeam"),
        autoAssign: bool(fd, "autoAssign"),
      },
      admin,
    );
    revalidatePath(PAGE);
    return ok(undefined, withWarnings(changed ? "Assignment rules saved. New leads follow them from now on." : "No changes to save.", warnings));
  } catch (e) {
    return failFrom(e, "save assignment");
  }
}

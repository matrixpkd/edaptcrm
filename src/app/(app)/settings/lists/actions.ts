"use server";
import { revalidatePath } from "next/cache";
import { fail, ok, str, type ActionResult } from "@/lib/action";
import { saveList } from "@/lib/admin/lists";
import { LIST_META } from "@/lib/admin/meta";
import { adminForAction, failFrom, jsonField, NOT_ADMIN } from "../_lib/guard";

export async function saveListAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  const meta = LIST_META.find((m) => m.key === str(fd, "list"));
  if (!meta) return fail("That list does not exist.");
  const j = jsonField(fd);
  if (!j.ok) return fail("Nothing to save. Reload the page and try again.");
  try {
    const { changed } = await saveList(meta.key, j.value, admin);
    // the lists feed dropdowns on every screen
    revalidatePath("/", "layout");
    return ok(undefined, changed ? `${meta.title} saved.` : "No changes to save.");
  } catch (e) {
    return failFrom(e, "save list");
  }
}

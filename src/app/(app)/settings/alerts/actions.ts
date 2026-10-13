"use server";
import { revalidatePath } from "next/cache";
import { fail, ok, str, type ActionResult } from "@/lib/action";
import { THRESHOLD_META } from "@/lib/admin/meta";
import { saveSettingAudited } from "@/lib/admin/settings";
import { validateDigest, validateThresholds } from "@/lib/admin/validate";
import { adminForAction, failFrom, NOT_ADMIN, withWarnings } from "../_lib/guard";

const PAGE = "/settings/alerts";

export async function saveThresholdsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  const raw = Object.fromEntries(THRESHOLD_META.map((m) => [m.key, str(fd, m.key) ?? ""]));
  const v = validateThresholds(raw);
  if (!v.ok) return fail(v.error, v.field ? { [v.field]: v.error } : undefined);
  try {
    const { changed } = await saveSettingAudited("thresholds", v.value, admin);
    revalidatePath(PAGE);
    revalidatePath("/today");
    return ok(undefined, withWarnings(changed ? "Thresholds saved. The next alert run uses them." : "No changes to save.", v.warnings));
  } catch (e) {
    return failFrom(e, "save thresholds");
  }
}

export async function saveDigestAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  const [hh, mm] = (str(fd, "dailyTime") ?? "").split(":");
  const others = (str(fd, "otherRecipients") ?? "").split(/[\s,;]+/).filter(Boolean);
  const v = validateDigest({
    dailyHour: hh ?? "",
    dailyMinute: mm ?? "",
    weeklyRecipients: [...fd.getAll("recipientIds").map(String), ...others],
  });
  if (!v.ok) return fail(v.error, v.field ? { [v.field]: v.error } : undefined);
  try {
    const { changed } = await saveSettingAudited("digest", v.value, admin);
    revalidatePath(PAGE);
    return ok(undefined, changed ? "Digest settings saved." : "No changes to save.");
  } catch (e) {
    return failFrom(e, "save digest");
  }
}

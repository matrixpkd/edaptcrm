"use server";
import { revalidatePath } from "next/cache";
import { fail, ok, type ActionResult } from "@/lib/action";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { runAllAlerts, summarizeRun, type RunAllAlertsResult } from "./jobs";

/**
 * "Run alerts now" (Settings, admin only): runs every alert rule immediately instead of waiting for the next
 * scheduled run, and sends pending alert emails. Safe to press twice: every alert is deduplicated.
 * Use with useActionState (it takes no form fields): `const [state, run] = useActionState(runAlertsNowAction, null)`.
 */
export async function runAlertsNowAction(): Promise<ActionResult<RunAllAlertsResult>> {
  const user = await requireUser();
  if (user.role !== "admin" || !can(user, "settings.manage")) return fail("Only an admin can run the alerts by hand");
  let result: RunAllAlertsResult;
  try {
    result = await runAllAlerts(new Date());
  } catch (e) {
    console.error("[alerts] run alerts now failed", e);
    return fail("Some alerts could not run. Try again in a minute: nothing is ever raised twice.");
  }
  revalidatePath("/today");
  revalidatePath("/notifications");
  return ok(result, `Alerts ran: ${summarizeRun(result)}`);
}

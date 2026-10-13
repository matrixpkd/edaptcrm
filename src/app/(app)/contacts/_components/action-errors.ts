import "server-only";
import { fail, type ActionResult } from "@/lib/action";
import { ContactError } from "@/lib/contacts/errors";
import { MoneyError } from "@/lib/money/errors";

/**
 * Turns a service error into a form result. Expected errors (validation, permission, conflicts) carry a
 * user-facing message and, when known, the field they belong to. Anything else is logged and reported
 * as a generic failure — never swallowed silently. Call redirect() outside the try block.
 */
export function actionError(e: unknown): ActionResult<never> {
  if (e instanceof ContactError) return fail(e.message, e.field ? { [e.field]: e.message } : undefined);
  if (e instanceof MoneyError) return fail(e.message);
  console.error("[contacts action]", e);
  return fail("Something went wrong. Please try again.");
}

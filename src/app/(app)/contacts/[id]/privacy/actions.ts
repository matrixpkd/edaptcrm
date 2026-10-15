"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, ok, str, type ActionResult } from "@/lib/action";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { eraseContact, setConsent } from "@/lib/contacts/privacy";
import { flash } from "@/lib/flash";
import { isUuid } from "@/lib/utils";
import { actionError } from "../../_components/action-errors";

/** One-tap marketing consent: yes, no, or not asked. */
export async function consentAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const contactId = str(fd, "contactId");
  if (!contactId || !isUuid(contactId)) return fail("Contact not found");
  const raw = str(fd, "consent");
  if (raw !== "yes" && raw !== "no" && raw !== "unknown") return fail("Choose yes or no");
  try {
    await setConsent(contactId, raw === "unknown" ? null : raw === "yes", user);
  } catch (e) {
    return actionError(e);
  }
  revalidatePath(`/contacts/${contactId}`);
  return ok(undefined, raw === "yes" ? "Consent recorded" : raw === "no" ? "Consent withdrawn" : "Consent cleared");
}

/** Admin: erase the person's data on request (DPDP / UAE PDPL). The page reloads as the anonymised record. */
export async function eraseContactAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "contacts.erase")) return fail("Only an admin can erase a contact's data");
  const contactId = str(fd, "contactId");
  if (!contactId || !isUuid(contactId)) return fail("Contact not found");
  if ((str(fd, "confirm") ?? "").toUpperCase() !== "ERASE") return fail("Type ERASE to confirm", { confirm: "Type ERASE to confirm" });
  try {
    await eraseContact(contactId, user, str(fd, "reason") ?? "");
  } catch (e) {
    return actionError(e);
  }
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${contactId}`);
  await flash("Personal data erased. Money records are kept, anonymised.");
  redirect(`/contacts/${contactId}`);
}

"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Contact, ContactType } from "@/db/schema";
import { fail, list, ok, str, type ActionResult } from "@/lib/action";
import { can, canEditContact } from "@/lib/auth/permissions";
import { requireUser, type SessionUser } from "@/lib/auth/session";
import { ContactNotFoundError } from "@/lib/contacts/errors";
import { findContactByPhone } from "@/lib/contacts/identity";
import { getContact } from "@/lib/contacts/internal";
import { updateContactProfile, type ProfilePatch } from "@/lib/contacts/profile";
import { normalizePhone } from "@/lib/phone";
import { isUuid } from "@/lib/utils";
import { actionError } from "../../_components/action-errors";

/** Loads the contact and checks the viewer may edit it. Returns an error message when not. */
async function loadEditable(
  user: SessionUser,
  contactId: string | null,
): Promise<{ error: string; contact?: undefined } | { error: null; contact: Contact }> {
  if (!contactId || !isUuid(contactId)) return { error: "Contact not found" };
  if (!can(user, "contacts.edit")) return { error: "You cannot edit contacts" };
  let c: Contact;
  try {
    c = await getContact(contactId);
  } catch (e) {
    if (e instanceof ContactNotFoundError) return { error: "Contact not found" };
    throw e;
  }
  if (c.mergedIntoId) return { error: "This contact was merged into another record" };
  if (!canEditContact(user, c)) return { error: "You cannot edit this contact" };
  return { error: null, contact: c };
}

async function editable(user: SessionUser, contactId: string | null): Promise<string | null> {
  return (await loadEditable(user, contactId)).error;
}

function refresh(contactId: string) {
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath(`/contacts/${contactId}/edit`);
  revalidatePath("/contacts");
}

/** The profile form. Every field on the form is sent; empty means "clear it". */
export async function updateProfileAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const contactId = str(fd, "contactId");
  const loaded = await loadEditable(user, contactId);
  if (loaded.error !== null) return fail(loaded.error);
  const consent = str(fd, "consent");
  const country = str(fd, "country");
  const patch: ProfilePatch = {
    name: str(fd, "name") ?? "",
    phone: str(fd, "phone") ?? "",
    email: str(fd, "email"),
    type: (str(fd, "type") ?? "individual") as ContactType,
    organisationId: str(fd, "organisationId"),
    companyName: str(fd, "companyName"),
    designation: str(fd, "designation"),
    city: str(fd, "city"),
    state: str(fd, "state"),
    language: str(fd, "language"),
    ageBand: str(fd, "ageBand"),
    industry: str(fd, "industry"),
    salesNotes: str(fd, "salesNotes"),
    consent: consent === "yes" ? true : consent === "no" ? false : null,
    tags: list(fd, "tags"),
  };
  // only send the country when it changed: re-saving an untouched form must not turn a country guessed from the
  // phone number into one a person chose
  if ((country ?? null) !== (loaded.contact.country ?? null)) patch.country = country;
  const door = str(fd, "firstDoor");
  if (door && user.role === "admin") patch.firstDoor = door;
  try {
    await updateContactProfile(contactId!, patch, user);
  } catch (e) {
    return actionError(e);
  }
  refresh(contactId!);
  redirect(`/contacts/${contactId}?tab=details&saved=1`);
}

/** Adds or removes one alternate phone or email. */
export async function alternateAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const contactId = str(fd, "contactId");
  const denied = await editable(user, contactId);
  if (denied) return fail(denied);
  const kind = str(fd, "kind");
  const op = str(fd, "op");
  const value = str(fd, "value");
  if ((kind !== "phone" && kind !== "email") || (op !== "add" && op !== "remove")) return fail("Unknown change");
  if (!value) return fail(kind === "phone" ? "Enter a phone number" : "Enter an email address", { value: "Required" });
  const change = op === "add" ? { add: [value] } : { remove: [value] };
  try {
    await updateContactProfile(contactId!, kind === "phone" ? { altPhones: change } : { altEmails: change }, user);
  } catch (e) {
    return actionError(e);
  }
  refresh(contactId!);
  return ok(undefined, op === "add" ? "Added" : "Removed");
}

/** Links the referrer found by phone, or clears it (clear=1). */
export async function referrerAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const contactId = str(fd, "contactId");
  const denied = await editable(user, contactId);
  if (denied) return fail(denied);
  let referredById: string | null = null;
  if (str(fd, "clear") !== "1") {
    const raw = str(fd, "phone");
    if (!raw) return fail("Enter the referrer's phone number", { phone: "Enter a phone number" });
    const np = normalizePhone(raw);
    if (!np) return fail("That is not a valid number", { phone: "That is not a valid number" });
    const ref = await findContactByPhone(np.e164);
    if (!ref)
      return fail("Nobody has this number yet. Add them with Quick Add first.", { phone: "Not in the CRM yet" });
    referredById = ref.id;
  }
  try {
    await updateContactProfile(contactId!, { referredById }, user);
  } catch (e) {
    return actionError(e);
  }
  refresh(contactId!);
  return ok(undefined, referredById ? "Referrer linked" : "Referrer removed");
}

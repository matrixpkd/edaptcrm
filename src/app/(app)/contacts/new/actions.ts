"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, list, str, type ActionResult } from "@/lib/action";
import { can, canViewContact } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { captureEnquiry } from "@/lib/contacts/capture";
import { checkQuickAddDuplicate, lookupByEmail } from "@/lib/contacts/identity";
import { userName } from "@/lib/contacts/internal";
import { isManualChannel } from "@/lib/contacts/rules";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { activeItems, getSettings } from "@/lib/settings";
import { isUuid } from "@/lib/utils";
import { actionError } from "../_components/action-errors";

/**
 * Quick Add: phone, name, channel and first door are required; everything else is optional.
 * The duplicate check runs again here (never trust the client): a known number or email is never added twice.
 * A salesperson owns what they add; support adds without owning (auto-assigned); a manager or admin may pick.
 */
export async function quickAddAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "contacts.create")) return fail("You cannot add contacts");

  const lists = await getSettings([
    "lists.channels",
    "lists.firstDoors",
    "lists.campaigns",
    "lists.languages",
    "lists.tags",
  ]);
  const inList = (key: keyof typeof lists, v: string | null) => !!v && activeItems(lists[key]).some((i) => i.key === v);

  const rawPhone = str(fd, "phone");
  const name = str(fd, "name");
  const channel = str(fd, "channel");
  const firstDoor = str(fd, "firstDoor");
  const rawEmail = str(fd, "email");
  const campaign = str(fd, "campaign");
  const city = str(fd, "city");
  const language = str(fd, "language");
  const note = str(fd, "note");
  const referrerPhone = str(fd, "referrerPhone");
  const tags = list(fd, "tags");
  // a known number: the enquiry joins that record (only when the user can open it); name and first door are kept
  const attachTo = str(fd, "attachTo");

  const errors: Record<string, string> = {};
  const np = rawPhone ? normalizePhone(rawPhone) : null;
  if (!rawPhone) errors.phone = "Enter a phone number";
  else if (!np) errors.phone = "That is not a valid number. Add the country code for numbers outside India.";
  if (!name && !attachTo) errors.name = "Enter a name";
  else if (name && name.length > 200) errors.name = "The name is too long";
  if (!inList("lists.channels", channel) || !isManualChannel(channel)) errors.channel = "Choose how this enquiry reached us";
  if (!attachTo && !inList("lists.firstDoors", firstDoor)) errors.firstDoor = "Choose how they first came to know Edapt";
  const email = rawEmail ? normalizeEmail(rawEmail) : null;
  if (rawEmail && !email) errors.email = "Enter a valid email address";
  if (campaign && !inList("lists.campaigns", campaign)) errors.campaign = "Choose a campaign from the list";
  if (language && !inList("lists.languages", language)) errors.language = "Choose a language from the list";
  const refNp = referrerPhone ? normalizePhone(referrerPhone) : null;
  if (referrerPhone && !refNp) errors.referrerPhone = "That is not a valid number";
  if (refNp && np && refNp.e164 === np.e164) errors.referrerPhone = "A contact cannot refer themselves";
  if (note && note.length > 5000) errors.note = "The note is too long";
  if (Object.keys(errors).length || !np) return fail("Check the highlighted fields", errors);

  // one person, one record: a known number or email is shown, never added again
  const dup = await checkQuickAddDuplicate(np.e164, user);
  const attaching = !!attachTo && !!dup.existing && dup.existing.id === attachTo && dup.existing.visible;
  if (attachTo && !attaching) {
    // the number changed hands or was typed differently since the check: never attach to someone else's record
    const msg = dup.existing ? `${dup.existing.name} already has this number` : "This number is not in the CRM yet. Save it as a new contact.";
    return fail(msg, { phone: msg });
  }
  if (dup.existing && !attaching) {
    const owner = dup.existing.ownerName ? `, owned by ${dup.existing.ownerName}` : ", in the pool";
    const msg = `${dup.existing.name} already has this number${owner}`;
    return fail(msg, { phone: msg });
  }
  if (email) {
    const byEmail = await lookupByEmail(email);
    if (byEmail && !(attaching && byEmail.contact.id === dup.existing?.id)) {
      const msg = `This email belongs to ${byEmail.contact.name}. Leave it out, or add this number to their record.`;
      return fail(msg, { email: msg });
    }
  }

  let ownerId: string | null = null;
  if (user.role === "sales") ownerId = user.id;
  else if (user.role === "manager" || user.role === "admin") {
    const chosen = str(fd, "ownerId");
    if (chosen === "me") ownerId = user.id;
    else if (chosen && chosen !== "auto") {
      if (!isUuid(chosen)) return fail("Choose an owner from the list", { ownerId: "Choose an owner from the list" });
      ownerId = chosen;
    }
  }
  // support never owns: their entries are auto-assigned (ownerId stays null)

  let contactId: string;
  let created: boolean;
  try {
    const r = await captureEnquiry({
      phone: np.e164,
      name: attaching ? null : name,
      email,
      channel: channel!,
      firstDoor: attaching ? null : firstDoor,
      campaign,
      createdById: user.id,
      ownerId,
      profile: { city, language },
      tags: tags.filter((t) => inList("lists.tags", t)),
      notes: note,
      referrer: refNp ? { phone: refNp.e164 } : null,
    });
    contactId = r.contact.id;
    created = r.created;
    // someone saved the same number a moment earlier: the enquiry joined that record. A salesperson who cannot
    // open it is told, instead of being sent to a page that would 404.
    if (!created && !canViewContact(user, r.contact)) {
      const owner = r.contact.ownerId ? await userName(r.contact.ownerId) : null;
      return fail(
        `${r.contact.name} already has this number${owner ? `, owned by ${owner}` : ""}. Your enquiry was added to their record.`,
      );
    }
  } catch (e) {
    return actionError(e);
  }
  revalidatePath("/contacts");
  revalidatePath("/today");
  redirect(`/contacts/${contactId}?added=${created ? "1" : "existing"}`);
}

"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, ok, str, type ActionResult } from "@/lib/action";
import { canEditContact } from "@/lib/auth/permissions";
import { ContactNotFoundError } from "@/lib/contacts/errors";
import { getContact } from "@/lib/contacts/internal";
import { flash } from "@/lib/flash";
import { requireUser } from "@/lib/auth/session";
import {
  createOrganisation,
  linkContactToOrganisation,
  updateOrganisation,
  type OrganisationInput,
} from "@/lib/contacts/organisations";
import { canManageOrganisations } from "@/lib/contacts/queries";
import { isUuid } from "@/lib/utils";
import { actionError } from "../contacts/_components/action-errors";

function input(fd: FormData): OrganisationInput {
  return {
    name: str(fd, "name") ?? "",
    kind: str(fd, "kind"),
    city: str(fd, "city"),
    state: str(fd, "state"),
    country: str(fd, "country"),
    phone: str(fd, "phone"),
    notes: str(fd, "notes"),
  };
}

export async function createOrganisationAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageOrganisations(user)) return fail("Only sales, managers and admins can add organisations");
  // opened from a contact's Edit page ("Not listed? Add an organisation"): link that person and go back there
  const forContact = str(fd, "for");
  let id: string;
  let linked = false;
  try {
    id = (await createOrganisation(input(fd), user)).id;
    if (forContact && isUuid(forContact)) {
      // a contact that no longer exists just means there is nobody to link: the organisation page opens instead
      const c = await getContact(forContact).catch((e: unknown) => {
        if (e instanceof ContactNotFoundError) return null;
        throw e;
      });
      if (c && !c.mergedIntoId && canEditContact(user, c)) {
        await linkContactToOrganisation(c.id, id, user);
        linked = true;
      }
    }
  } catch (e) {
    return actionError(e);
  }
  revalidatePath("/organisations");
  if (linked && forContact) {
    revalidatePath(`/contacts/${forContact}`);
    await flash("Organisation added and linked. Check the other details and save.");
    redirect(`/contacts/${forContact}/edit`);
  }
  redirect(`/organisations/${id}?created=1`);
}

export async function updateOrganisationAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageOrganisations(user)) return fail("Only sales, managers and admins can edit organisations");
  const id = str(fd, "id");
  if (!isUuid(id)) return fail("Organisation not found");
  try {
    await updateOrganisation(id, input(fd), user);
  } catch (e) {
    return actionError(e);
  }
  revalidatePath("/organisations");
  revalidatePath(`/organisations/${id}`);
  redirect(`/organisations/${id}?saved=1`);
}

/** Organisation page: link a person (they become a Business contact) or unlink them. */
export async function linkPersonAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!canManageOrganisations(user)) return fail("Only sales, managers and admins can link people");
  const orgId = str(fd, "orgId");
  const contactId = str(fd, "contactId");
  const unlink = str(fd, "unlink") === "1";
  if (!isUuid(orgId) || !isUuid(contactId)) return fail("Choose a person from the list");
  let changed = false;
  try {
    changed = (await linkContactToOrganisation(contactId, unlink ? null : orgId, user)).changed;
  } catch (e) {
    return actionError(e);
  }
  revalidatePath(`/organisations/${orgId}`);
  revalidatePath(`/contacts/${contactId}`);
  if (unlink) return ok(undefined, changed ? "Unlinked" : "Already unlinked");
  return ok(undefined, changed ? "Linked to this organisation" : "Already linked");
}

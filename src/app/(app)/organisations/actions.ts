"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, str, type ActionResult } from "@/lib/action";
import { requireUser } from "@/lib/auth/session";
import { createOrganisation, updateOrganisation, type OrganisationInput } from "@/lib/contacts/organisations";
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
  let id: string;
  try {
    id = (await createOrganisation(input(fd), user)).id;
  } catch (e) {
    return actionError(e);
  }
  revalidatePath("/organisations");
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

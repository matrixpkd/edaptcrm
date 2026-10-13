"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { bool, fail, ok, str, type ActionResult } from "@/lib/action";
import { createUser, deactivateUser, handoverUserContacts, reactivateUser, resetUserPassword, updateUser, type UserInput } from "@/lib/admin/users";
import { adminForAction, failFrom, NOT_ADMIN } from "../_lib/guard";

function input(fd: FormData): UserInput {
  return {
    name: str(fd, "name"),
    email: str(fd, "email"),
    role: str(fd, "role"),
    team: str(fd, "team"),
    timezone: str(fd, "timezone"),
    phone: str(fd, "phone"),
  };
}

function touch(id?: string) {
  revalidatePath("/settings/users");
  revalidatePath("/settings/teams-assignment");
  if (id) revalidatePath(`/settings/users/${id}`);
}

export async function createUserAction(
  _prev: ActionResult,
  fd: FormData,
): Promise<ActionResult<{ id: string; name: string; tempPassword: string }>> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  try {
    const { user, tempPassword } = await createUser(input(fd), admin);
    touch();
    return ok({ id: user.id, name: user.name, tempPassword }, `${user.name} can now sign in with ${user.email}.`);
  } catch (e) {
    return failFrom(e, "create user");
  }
}

export async function updateUserAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  const id = str(fd, "id") ?? "";
  let steppedDown = false;
  try {
    const u = await updateUser(id, input(fd), admin);
    steppedDown = u.id === admin.id && u.role !== "admin";
  } catch (e) {
    return failFrom(e, "update user");
  }
  touch(id);
  // you just gave up the admin role: Settings is no longer yours
  if (steppedDown) redirect("/today");
  return ok(undefined, "Saved.");
}

export async function resetPasswordAction(_prev: ActionResult, fd: FormData): Promise<ActionResult<{ tempPassword: string }>> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  try {
    const { tempPassword, sessionsEnded } = await resetUserPassword(str(fd, "id") ?? "", admin);
    return ok(
      { tempPassword },
      sessionsEnded ? `Password reset. They were signed out on ${sessionsEnded} device${sessionsEnded === 1 ? "" : "s"}.` : "Password reset.",
    );
  } catch (e) {
    return failFrom(e, "reset password");
  }
}

export async function deactivateUserAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  const id = str(fd, "id") ?? "";
  if (!bool(fd, "confirm")) return fail("Tick the box to confirm.", { confirm: "Tick the box to confirm." });
  let moved = 0;
  try {
    ({ moved } = await deactivateUser(id, str(fd, "handoverTo"), admin));
  } catch (e) {
    return failFrom(e, "deactivate user");
  }
  touch(id);
  revalidatePath("/contacts");
  revalidatePath("/today");
  redirect(`/settings/users/${id}?deactivated=${moved}`);
}

export async function reactivateUserAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  const id = str(fd, "id") ?? "";
  try {
    await reactivateUser(id, admin);
  } catch (e) {
    return failFrom(e, "reactivate user");
  }
  touch(id);
  return ok(undefined, "Reactivated. They can sign in again; give them a new password if they need one.");
}

export async function handoverContactsAction(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const admin = await adminForAction();
  if (!admin) return fail(NOT_ADMIN);
  const id = str(fd, "id") ?? "";
  try {
    const moved = await handoverUserContacts(id, str(fd, "handoverTo"), admin);
    touch(id);
    revalidatePath("/contacts");
    revalidatePath("/today");
    return ok(undefined, moved ? `${moved} contact${moved === 1 ? "" : "s"} and their open tasks were handed over.` : "Their open tasks were handed over. They owned no contacts.");
  } catch (e) {
    return failFrom(e, "hand over contacts");
  }
}

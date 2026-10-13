"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { str } from "@/lib/action";
import { canViewContact } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import {
  getNotification,
  markAllNotificationsRead,
  markNotificationsRead,
  notificationHref,
} from "@/lib/today/inbox";

/** The bell count lives in the app layout, so every change revalidates the whole signed-in tree. */
function refresh() {
  revalidatePath("/", "layout");
}

export async function markReadAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  const id = str(fd, "id");
  if (id) await markNotificationsRead(user.id, [id]);
  refresh();
}

export async function markAllReadAction(): Promise<void> {
  const user = await requireUser();
  await markAllNotificationsRead(user.id);
  refresh();
}

/** Opens a notification: marks it read, then goes to its contact (or Today / the contacts list). */
export async function openNotificationAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  const id = str(fd, "id");
  const n = id ? await getNotification(user.id, id) : null;
  if (!n) {
    refresh();
    redirect("/notifications");
  }
  if (!n.readAt) await markNotificationsRead(user.id, [n.id]);
  refresh();
  // the contact may have moved to a colleague since the alert: say so instead of a 404
  // (a merged-away contact is fine: its page forwards to the surviving record)
  if (n.contactId && !n.contactMerged && !canViewContact(user, { ownerId: n.contactOwnerId })) {
    redirect("/notifications?gone=1");
  }
  redirect(notificationHref(n));
}

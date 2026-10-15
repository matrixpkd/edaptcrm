import "server-only";
import { cookies } from "next/headers";
import { cleanFlash, FLASH_COOKIE } from "./flash-cookie";

/**
 * Leaves a one-time message for the page a server action redirects to ("Call logged", "Rating saved"). The
 * Toaster in the signed-in layout shows it and deletes the cookie. Readable by the page script on purpose: it only
 * ever holds the action's own success text.
 */
export async function flash(message: string): Promise<void> {
  const value = cleanFlash(message);
  if (!value) return;
  (await cookies()).set(FLASH_COOKIE, value, {
    path: "/",
    maxAge: 60,
    sameSite: "lax",
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
  });
}

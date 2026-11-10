import { TEMP_PASSWORD_DAYS } from "@/lib/auth/temporary-password";

/**
 * The message an admin sends a new teammate (or someone whose password was reset): where to sign in, with which
 * email and temporary password, how long it works, and that they choose their own password when they sign in.
 * PURE (client and server).
 */
export function inviteMessage(p: { name: string; email: string; password: string; loginUrl: string; reset?: boolean }): string {
  const first = p.name.trim().split(/\s+/)[0] || p.name;
  return [
    p.reset ? `Hi ${first}, your Edapt CRM password was reset.` : `Hi ${first}, your Edapt CRM account is ready.`,
    `Sign in at ${p.loginUrl}`,
    `Email: ${p.email}`,
    `Temporary password: ${p.password}`,
    `It works for ${TEMP_PASSWORD_DAYS} days. When you sign in, you will choose your own password.`,
  ].join("\n");
}

/** A wa.me link that opens WhatsApp with the message (to the number when known, else the contact picker). */
export function whatsappShareLink(message: string, e164?: string | null): string {
  const digits = (e164 ?? "").replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

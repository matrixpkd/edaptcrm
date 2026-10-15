/**
 * The message an admin sends a new teammate (or someone whose password was reset): where to sign in, with which
 * email and temporary password, and to choose their own password afterwards. PURE (client and server).
 */
export function inviteMessage(p: { name: string; email: string; password: string; loginUrl: string; reset?: boolean }): string {
  const first = p.name.trim().split(/\s+/)[0] || p.name;
  return [
    p.reset ? `Hi ${first}, your Edapt CRM password was reset.` : `Hi ${first}, your Edapt CRM account is ready.`,
    `Sign in at ${p.loginUrl}`,
    `Email: ${p.email}`,
    `Temporary password: ${p.password}`,
    "After signing in, open Your account and choose your own password.",
  ].join("\n");
}

/** A wa.me link that opens WhatsApp with the message (to the number when known, else the contact picker). */
export function whatsappShareLink(message: string, e164?: string | null): string {
  const digits = (e164 ?? "").replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

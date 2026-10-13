import "server-only";

export type Email = { to: string | string[]; subject: string; html: string; text?: string };

/** Sends through Resend when RESEND_API_KEY is set; otherwise prints to the server log. */
export async function sendEmail(email: Email): Promise<{ ok: boolean; id?: string; error?: string }> {
  const to = Array.isArray(email.to) ? email.to : [email.to];
  if (!to.length) return { ok: false, error: "no recipients" };
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.info(`[email:dev] to=${to.join(",")} subject=${JSON.stringify(email.subject)}`);
    return { ok: true, id: "dev" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || "Edapt CRM <crm@edapt.in>",
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
  });
  if (!res.ok) return { ok: false, error: `${res.status} ${await res.text()}` };
  const body = (await res.json()) as { id?: string };
  return { ok: true, id: body.id };
}

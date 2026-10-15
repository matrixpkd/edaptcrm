import "server-only";
import { headers } from "next/headers";
import { appBaseUrl } from "@/lib/auth/password-reset";

/**
 * This site's address for text people read (e.g. the sign-in link in an invite message): APP_URL when set, else
 * the address this request came in on. Emailed links use APP_URL only (src/lib/auth/password-reset.ts).
 */
export async function siteOrigin(): Promise<string> {
  const configured = appBaseUrl();
  if (configured) return configured;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
}

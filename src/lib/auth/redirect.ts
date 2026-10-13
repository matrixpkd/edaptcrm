/**
 * Same-site redirect targets from user input (?next= on the login page, ?return= on the Log and Rate screens).
 * PURE: safe in client components, unit tested in tests/integration/security-auth.test.ts.
 *
 * Only a plain path on this site is accepted: it starts with one "/", has no backslash (browsers read "/\evil.com"
 * as "//evil.com"), no control characters (tabs and line breaks are stripped by browsers, so "/\t/evil.com" becomes
 * "//evil.com"), and resolves to the same origin. Anything else gives the fallback.
 */
export function safeNextPath(raw: string | null | undefined, fallback: string): string {
  const v = (raw ?? "").trim();
  if (!v || v.length > 500) return fallback;
  if (!v.startsWith("/") || v.startsWith("//")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(v)) return fallback;
  try {
    const base = "https://same-site.invalid";
    const u = new URL(v, base);
    if (u.origin !== base) return fallback;
  } catch {
    return fallback;
  }
  return v;
}

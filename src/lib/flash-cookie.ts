/**
 * The one-time "flash" message a server action leaves for the next page (shown by the Toaster). Pure helpers,
 * safe on the client and the server; `flash()` in `@/lib/flash` sets it from a server action.
 */
export const FLASH_COOKIE = "edapt_flash";
export const FLASH_MAX_LENGTH = 200;

/**
 * The message as stored: one line, trimmed, capped. Empty for an empty message. Next's `cookies().set()` URI-encodes
 * the value itself, so it is not encoded here (it would arrive double-encoded).
 */
export function cleanFlash(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, FLASH_MAX_LENGTH);
}

/** The message in a `document.cookie` string (URI-encoded by Next), or null. A malformed value is ignored. */
export function readFlashCookie(cookieHeader: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== FLASH_COOKIE) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      const text = decodeURIComponent(raw).trim().slice(0, FLASH_MAX_LENGTH);
      return text || null;
    } catch {
      return null;
    }
  }
  return null;
}

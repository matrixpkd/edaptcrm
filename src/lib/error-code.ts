/**
 * A short, non-identifying error code for operators: a Postgres SQLSTATE (e.g. 28P01 wrong password, XX000 unknown
 * pooler tenant) or a network errno (ENOTFOUND, ECONNREFUSED, ETIMEDOUT). Never the message, host, user or schema.
 */
export function errorCode(e: unknown): string | null {
  for (let cur: unknown = e, depth = 0; cur && depth < 4; cur = (cur as { cause?: unknown }).cause, depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{3,24}$/.test(code)) return code;
  }
  return null;
}

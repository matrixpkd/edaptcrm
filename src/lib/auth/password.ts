import bcrypt from "bcryptjs";

/**
 * bcrypt work factor: about 150 ms per hash with bcryptjs on a serverless CPU. Hashes made with a lower cost are
 * upgraded at the next successful sign-in (needsRehash).
 */
export const BCRYPT_COST = 11;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

let dummyHash: Promise<string> | null = null;

/**
 * Checks a password against a stored hash. With no hash (unknown email, or a user without a password) it still
 * runs one bcrypt comparison against a throwaway hash, so the response time does not tell whether an email exists.
 */
export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) {
    dummyHash ??= bcrypt.hash("edapt-no-such-user", BCRYPT_COST);
    await bcrypt.compare(password, await dummyHash);
    return false;
  }
  return bcrypt.compare(password, hash);
}

/** True when a stored hash was made with a lower work factor than BCRYPT_COST (or cannot be read). */
export function needsRehash(hash: string): boolean {
  try {
    return bcrypt.getRounds(hash) < BCRYPT_COST;
  } catch {
    return false;
  }
}

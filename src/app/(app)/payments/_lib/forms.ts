import "server-only";
/**
 * Form plumbing shared by the payment server actions: reading dates typed in the user's time zone,
 * checking and storing proof files, and turning money-service errors into form results.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, type Role } from "@/db/schema";
import { fail, type ActionResult } from "@/lib/action";
import { canViewContact } from "@/lib/auth/permissions";
import {
  DuplicateReferenceError,
  MoneyError,
  UnknownCurrencyError,
  ValidationError,
} from "@/lib/money/errors";
import { saveFile } from "@/lib/storage";
import { localDateAt, localIsoDate } from "@/lib/today/time";
import { proofExtension, proofProblem } from "@/components/payments/rules";

/** Folder proofs are stored under (see src/lib/storage.ts). */
export const PROOF_FOLDER = "proofs";

/**
 * A date typed on a form ("YYYY-MM-DD", the user's local calendar) as the moment money moved:
 * today -> now (so it is never "in the future"); an earlier day -> noon local time that day.
 * Null when blank or not a real date.
 */
export function moneyDateFromInput(ymd: string | null, timeZone: string, now: Date): Date | null {
  if (!ymd) return null;
  if (ymd === localIsoDate(now, timeZone)) return now;
  return localDateAt(ymd, timeZone, 12, 0);
}

/**
 * An instalment due date ("YYYY-MM-DD") as the last minute of that local day, so an instalment is
 * "due today" all day and becomes overdue the next morning. Null when not a real date.
 */
export function dueDateFromInput(ymd: string | null, timeZone: string): Date | null {
  if (!ymd) return null;
  return localDateAt(ymd, timeZone, 23, 59);
}

export type ProofRead = { file: File | null; error: string | null };

/** The optional proof upload in `key`: null file when nothing was attached, or the reason it is refused. */
export function readProof(fd: FormData, key = "proof"): ProofRead {
  const v = fd.get(key);
  if (!v || typeof v === "string") return { file: null, error: null };
  const file = v as File;
  // an empty file input still submits a zero-byte File (named "", "blob" or "undefined" by different browsers);
  // the picker itself refuses empty files, so zero bytes here means nothing was attached
  if (!file.size) return { file: null, error: null };
  const problem = proofProblem({ size: file.size, type: file.type, name: file.name });
  return problem ? { file: null, error: problem } : { file, error: null };
}

/**
 * Saves a checked proof under "proofs/" and returns its URL (/api/files/...). The stored name always ends
 * in the extension of its real type, so the file server sends the right Content-Type.
 */
export async function storeProof(file: File): Promise<string> {
  const ext = proofExtension(file) ?? "bin";
  const base =
    (file.name || "proof")
      .replace(/\.[^.]*$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "proof";
  const data = new Uint8Array(await file.arrayBuffer());
  return saveFile({ name: `${base}.${ext}`, type: file.type || "application/octet-stream", data }, PROOF_FOLDER);
}

/**
 * A money-service error as a form result. Expected errors carry a user-facing message; when the service names
 * a field, `fieldMap` translates it to the form's field name (unmapped fields keep their own name).
 * Anything unexpected is logged and reported as a generic failure, never swallowed.
 */
export function moneyFailure(e: unknown, fieldMap: Record<string, string> = {}): ActionResult<never> {
  if (e instanceof DuplicateReferenceError) {
    const field = fieldMap.reference ?? "reference";
    return fail(e.message, { [field]: e.message });
  }
  if (e instanceof UnknownCurrencyError) {
    const field = fieldMap.currency ?? "currency";
    return fail(e.message, { [field]: e.message });
  }
  if (e instanceof ValidationError) {
    if (!e.field) return fail(e.message);
    return fail(e.message, { [fieldMap[e.field] ?? e.field]: e.message });
  }
  if (e instanceof MoneyError) return fail(e.message);
  console.error("[payments action]", e);
  return fail("Something went wrong. Nothing was saved. Please try again.");
}

/**
 * moneyFailure for a signed-in viewer. A duplicate UTR / order id names the contact that already holds it; a
 * salesperson must not learn the name of a contact outside their own and the pool, so for them the message
 * only says it is recorded on another customer.
 */
export async function moneyFailureFor(
  viewer: { id: string; role: Role },
  e: unknown,
  fieldMap: Record<string, string> = {},
): Promise<ActionResult<never>> {
  if (e instanceof DuplicateReferenceError && e.contactName) {
    const visible = e.contactId ? await holderVisible(viewer, e.contactId) : false;
    if (!visible) {
      const label = /^This (.+?) \(/.exec(e.message)?.[1] ?? "reference";
      const message = `This ${label} (${e.reference}) is already recorded on another customer. Ask your manager if it looks wrong.`;
      const field = fieldMap.reference ?? "reference";
      return fail(message, { [field]: message });
    }
  }
  return moneyFailure(e, fieldMap);
}

async function holderVisible(viewer: { id: string; role: Role }, contactId: string): Promise<boolean> {
  const [c] = await db
    .select({ ownerId: contacts.ownerId, mergedIntoId: contacts.mergedIntoId })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  return !!c && !c.mergedIntoId && canViewContact(viewer, c);
}

/** The first field error as the form's headline, or a generic one. */
export function failFields(fieldErrors: Record<string, string>, headline?: string): ActionResult<never> {
  const first = Object.values(fieldErrors)[0];
  return fail(headline ?? (Object.keys(fieldErrors).length > 1 ? "Check the highlighted fields." : first), fieldErrors);
}

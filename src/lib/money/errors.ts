/**
 * Errors thrown by the money services. Every one carries a short, user-facing message, so a server action
 * can simply do `if (e instanceof MoneyError) return fail(e.message)`.
 * Pure: safe to import from client components.
 */

/** Base class for every expected (user-facing) money error. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A TagMango order id or UTR that is already recorded. Nothing is ever counted twice. */
export class DuplicateReferenceError extends MoneyError {
  readonly reference: string;
  /** contact the existing row belongs to, when it could be found */
  readonly contactId: string | null;
  readonly contactName: string | null;
  /** which table already holds the reference */
  readonly existingIn: "purchase" | "payment" | null;

  constructor(opts: {
    reference: string;
    /** "TagMango order", "UTR" or "reference" */
    label: string;
    contactId?: string | null;
    contactName?: string | null;
    existingIn?: "purchase" | "payment" | null;
  }) {
    super(
      opts.contactName
        ? `This ${opts.label} (${opts.reference}) is already recorded on ${opts.contactName}.`
        : `This ${opts.label} (${opts.reference}) is already recorded.`,
    );
    this.reference = opts.reference;
    this.contactId = opts.contactId ?? null;
    this.contactName = opts.contactName ?? null;
    this.existingIn = opts.existingIn ?? null;
  }
}

/** Bad input (missing UTR, instalments that do not add up, refund larger than what was paid, ...). */
export class ValidationError extends MoneyError {
  /** form field the message belongs to, when there is one */
  readonly field: string | null;
  constructor(message: string, field: string | null = null) {
    super(message);
    this.field = field;
  }
}

/** A currency with no INR rate in Settings > Currency. */
export class UnknownCurrencyError extends MoneyError {
  readonly currency: string;
  constructor(currency: string) {
    super(`No INR rate is set for ${currency || "this currency"}. Add it in Settings > Currency.`);
    this.currency = currency;
  }
}

/** The signed-in user's role does not allow this action. */
export class PermissionError extends MoneyError {
  readonly permission: string;
  constructor(permission: string, message?: string) {
    super(message ?? "You don't have permission to do this.");
    this.permission = permission;
  }
}

/** A purchase, payment, contact, product or user id that does not exist. */
export class NotFoundError extends MoneyError {
  constructor(what: string) {
    super(`${what} not found.`);
  }
}

export function isMoneyError(e: unknown): e is MoneyError {
  return e instanceof MoneyError;
}

/**
 * Errors thrown by the contacts services. Pure (no server-only imports) so server actions and
 * tests can check them with `instanceof` and show `message` to the user as is.
 * Every message is plain, short, sentence case.
 */

export type ContactErrorCode =
  | "invalid_phone"
  | "invalid_input"
  | "forbidden"
  | "not_found"
  | "merged"
  | "conflict";

export class ContactError extends Error {
  readonly code: ContactErrorCode;
  /** the form field the error belongs to, when there is one */
  readonly field?: string;

  constructor(code: ContactErrorCode, message: string, field?: string) {
    super(message);
    this.name = "ContactError";
    this.code = code;
    this.field = field;
  }
}

/** The phone number cannot be normalised to a valid E.164 number. */
export class InvalidPhoneError extends ContactError {
  readonly raw: string;

  constructor(raw: unknown, field = "phone") {
    const shown = raw === null || raw === undefined ? "" : String(raw);
    super("invalid_phone", shown ? `"${shown}" is not a valid phone number` : "Enter a phone number", field);
    this.name = "InvalidPhoneError";
    this.raw = shown;
  }
}

/** Bad input: a value out of range, a key that is not in the settings list, a missing reason. */
export class ContactValidationError extends ContactError {
  constructor(message: string, field?: string) {
    super("invalid_input", message, field);
    this.name = "ContactValidationError";
  }
}

/** The acting user may not do this. */
export class ContactForbiddenError extends ContactError {
  constructor(message = "You do not have permission to do this") {
    super("forbidden", message);
    this.name = "ContactForbiddenError";
  }
}

export class ContactNotFoundError extends ContactError {
  constructor(what = "Contact") {
    super("not_found", `${what} not found`);
    this.name = "ContactNotFoundError";
  }
}

/** The contact was merged into another record and can no longer be changed. */
export class ContactMergedError extends ContactError {
  readonly mergedIntoId: string;

  constructor(mergedIntoId: string) {
    super("merged", "This contact was merged into another record");
    this.name = "ContactMergedError";
    this.mergedIntoId = mergedIntoId;
  }
}

/** The change clashes with another record (e.g. the phone already belongs to someone else). */
export class ContactConflictError extends ContactError {
  readonly otherContactId?: string;

  constructor(message: string, otherContactId?: string, field?: string) {
    super("conflict", message, field);
    this.name = "ContactConflictError";
    this.otherContactId = otherContactId;
  }
}

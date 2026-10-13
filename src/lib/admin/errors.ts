/**
 * Errors thrown by the admin services (Settings). Each carries a friendly message that the Settings screens show
 * as is, and optionally the form field it belongs to. Pure: safe in client components.
 */
export class AdminError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "AdminError";
    this.field = field;
  }
}

/** The signed-in user is not allowed to do this (only the admin manages settings, users and exports). */
export class AdminForbiddenError extends AdminError {
  constructor(message = "Only an admin can change settings") {
    super(message);
    this.name = "AdminForbiddenError";
  }
}

export function isAdminError(e: unknown): e is AdminError {
  return e instanceof AdminError;
}

/** The existing contact behind a known number, as the live duplicate check returns it. */
export type PhoneCheckExisting =
  | {
      /** the user may open this contact */
      visible: true;
      id: string;
      name: string;
      ownerName: string | null;
      ownerIsMe: boolean;
      stage: string;
      grade: "A" | "B" | "C" | "D" | null;
    }
  | {
      /** a colleague's contact: only its name and owner (spec "One person, one record", rule 5) */
      visible: false;
      /** set only when the user may request a transfer of it (the action re-checks every right) */
      id: string | null;
      name: string;
      ownerName: string | null;
      ownerIsMe: false;
    };

/** The JSON returned by GET /contacts/new/check (the live duplicate check). */
export type PhoneCheckResponse = {
  valid: boolean;
  e164: string | null;
  international: string | null;
  country: string | null;
  existing: null | PhoneCheckExisting;
};

/** The JSON of a refused check (401, 403, or 429 when the user is over the lookup limit). */
export type PhoneCheckError = { error: string };

/** The JSON returned by GET /contacts/new/check (the live duplicate check). */
export type PhoneCheckResponse = {
  valid: boolean;
  e164: string | null;
  international: string | null;
  country: string | null;
  existing: null | {
    id: string;
    name: string;
    ownerName: string | null;
    ownerIsMe: boolean;
    stage: string;
    grade: "A" | "B" | "C" | "D" | null;
    visible: boolean;
  };
};

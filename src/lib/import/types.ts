/**
 * Import wizard: shared types, target fields and source presets. Pure (no server-only imports), so the
 * wizard's client components can use the labels and presets.
 *
 * Spec: "Importing the 50,000 old records", "One person, one record", "Labels", "Purchases".
 */
import type { ImportMatchResult, ImportStatus, PaymentMode } from "@/db/schema";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export const IMPORT_SOURCES = ["tagmango", "zoho", "delegation", "program_sheet", "other"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const SOURCE_INFO: Record<ImportSource, { label: string; short: string; description: string }> = {
  tagmango: {
    label: "TagMango customers & orders",
    short: "TagMango",
    description: "Every row is a real payment: purchases are recorded as verified, with the order id as the reference.",
  },
  zoho: {
    label: "Zoho CRM",
    short: "Zoho",
    description: "Owners are matched to team members by name or email, and notes carry over.",
  },
  delegation: {
    label: "Delegation list",
    short: "Delegation",
    description: "First door Delegation and the tag Legacy: Delegation, so they surface for The AI Office.",
  },
  program_sheet: {
    label: "MLA / constituency program sheet",
    short: "Program sheet",
    description: "First door MLA or constituency program, the program as campaign, and a tag for the program.",
  },
  other: {
    label: "Other sheet or document",
    short: "Other",
    description: "Old sheets and docs. For a doc, Claude pulls the people out of the text.",
  },
};

/** The recommended order (spec "Import order"): payment records first, so they form the backbone. */
export const IMPORT_ORDER: ImportSource[] = ["tagmango", "zoho", "delegation", "program_sheet", "other"];

export function isImportSource(v: unknown): v is ImportSource {
  return typeof v === "string" && (IMPORT_SOURCES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Target fields (step 2)
// ---------------------------------------------------------------------------

export const TARGET_FIELDS = [
  "phone",
  "dial_code",
  "alt_phone",
  "name",
  "email",
  "city",
  "state",
  "country",
  "language",
  "age_band",
  "industry",
  "designation",
  "company_name",
  "first_door",
  "campaign",
  "tags",
  "owner",
  "notes",
  "enquired_at",
  "product",
  "family",
  "amount",
  "currency",
  "purchased_at",
  "order_id",
  "payment_mode",
  "referrer_phone",
  "referrer_name",
  "consent",
  "ignore",
] as const;
export type TargetField = (typeof TARGET_FIELDS)[number];

export function isTargetField(v: unknown): v is TargetField {
  return typeof v === "string" && (TARGET_FIELDS as readonly string[]).includes(v);
}

/** Label and a one-line description (also given to Claude when it proposes the mapping). */
export const FIELD_INFO: Record<TargetField, { label: string; group: string; description: string }> = {
  phone: { label: "Phone", group: "Person", description: "Main phone / mobile / WhatsApp number" },
  dial_code: { label: "Dial code", group: "Person", description: "Separate country dial code such as 91 or +971" },
  alt_phone: { label: "Alternate phone", group: "Person", description: "A second or other phone number" },
  name: { label: "Name", group: "Person", description: "Full name (first and last name columns are joined)" },
  email: { label: "Email", group: "Person", description: "Email address" },
  city: { label: "City", group: "Person", description: "City or town" },
  state: { label: "State", group: "Person", description: "State, province or emirate" },
  country: { label: "Country", group: "Person", description: "Country name or code" },
  language: { label: "Language", group: "Person", description: "Preferred language" },
  age_band: { label: "Age band", group: "Person", description: "Age or age group" },
  industry: { label: "Industry or role", group: "Person", description: "Industry, profession or occupation" },
  designation: { label: "Designation", group: "Person", description: "Job title or designation" },
  company_name: { label: "Company", group: "Person", description: "Company, business or organisation name" },
  first_door: { label: "First door", group: "Labels", description: "How they first came to know Edapt (lead source)" },
  campaign: { label: "Campaign", group: "Labels", description: "Campaign, program or event" },
  tags: { label: "Tags", group: "Labels", description: "Tags or labels, comma separated" },
  owner: { label: "Owner", group: "Labels", description: "Salesperson / lead owner / contact owner (name or email)" },
  notes: { label: "Notes", group: "Labels", description: "Notes, description, remarks or comments" },
  enquired_at: {
    label: "Enquiry date",
    group: "Labels",
    description: "When the person enquired or the record was created (created time, registration, attendance or event date); not a date of birth",
  },
  product: { label: "Product", group: "Purchase", description: "Product, course or TagMango mango bought" },
  family: { label: "Product family", group: "Purchase", description: "Product family or category" },
  amount: { label: "Amount paid", group: "Purchase", description: "Amount paid / price / total" },
  currency: { label: "Currency", group: "Purchase", description: "Currency of the amount (INR, AED, USD)" },
  purchased_at: { label: "Purchase date", group: "Purchase", description: "Order, purchase or payment date" },
  order_id: { label: "Order id", group: "Purchase", description: "Order id, transaction id, payment id or UTR" },
  payment_mode: { label: "Payment mode", group: "Purchase", description: "Payment method or gateway" },
  referrer_phone: { label: "Referrer phone", group: "Referral", description: "Phone of the person or affiliate who referred them" },
  referrer_name: { label: "Referrer name", group: "Referral", description: "Name of the referrer or affiliate" },
  consent: { label: "Marketing consent", group: "Other", description: "Marketing consent / opted in (yes or no)" },
  ignore: { label: "Ignore", group: "Other", description: "Not imported (the raw value is still kept)" },
};

/** Fields several columns may map to at once (values are joined); every other field takes the first value. */
export const MULTI_FIELDS: ReadonlySet<TargetField> = new Set(["name", "alt_phone", "tags", "notes", "phone", "email"]);

/** column header -> target field */
export type ColumnMapping = Record<string, TargetField>;

// ---------------------------------------------------------------------------
// Defaults applied to every row (step 2)
// ---------------------------------------------------------------------------

/** "pool" = leave unassigned; "round_robin" = the usual auto-assignment; otherwise a user id. */
export type OwnerFallback = "pool" | "round_robin" | string;

/** What an unknown product text in the file stands for: a catalogue product or a ladder family. */
export type ProductChoice = { productId?: string | null; family?: string | null };

export type ImportDefaults = {
  source: ImportSource;
  /** first door key for NEW contacts when the row has none; null = decided by capture (Other, or Referral) */
  firstDoor: string | null;
  /** campaign key (or text) when the row has none */
  campaign: string | null;
  tags: string[];
  /** program sheets: tag every row with its campaign's label ("tagged by program") */
  tagWithCampaign: boolean;
  /** ISO country assumed for phone numbers written without a code */
  defaultCountry: string;
  ownerFallback: OwnerFallback;
  /**
   * The owner named in the file replaces the current owner of a contact that already exists (Zoho: "today's
   * salesperson assignments carry over"). Off: existing contacts keep their owner and only pool contacts take it.
   */
  ownerFromFile?: boolean;
  /**
   * "YYYY-MM-DD": when the people in this file were in touch (a program's date), for rows with no date of their
   * own. Null: such rows are dated today. Old records dated today would look like fresh interest, so set it.
   */
  recordsDate?: string | null;
  /** 03/04/2025 is 3 April (Indian) when true, 4 March when false */
  dayFirst: boolean;
  /** currency of amounts written without a symbol or currency column */
  currency: string;
  /** payment mode of imported purchases when the row has none */
  paymentMode: PaymentMode;
  /** imported payments count as verified (TagMango rows always are) */
  verified: boolean;
  /** ladder family for products that are not in the catalogue and not mapped below */
  productFamily: string | null;
  /** looseKey(product text) -> catalogue product or family */
  productMap: Record<string, ProductChoice>;
};

export type FileKind = "csv" | "xlsx" | "docx" | "txt";

/** What the upload step learned about the file. */
export type FileMeta = {
  kind: FileKind;
  /** column headers in file order */
  headers: string[];
  rowCount: number;
  /** xlsx: every sheet name, and the one imported */
  sheets?: string[];
  sheet?: string | null;
  /** docs: how rows were pulled out of the text */
  extractedBy?: "table" | "ai" | "heuristic" | null;
  size: number;
  type: string;
};

/** Progress of the chunked phases, kept in import_batches.defaults.progress. */
export type BatchProgress = {
  /** last row number processed by each phase (rows are processed in row order, so a phase can resume) */
  cleanCursor?: number;
  matchCursor?: number;
  commitCursor?: number;
  undoCursor?: number;
  undoStartedAt?: string;
  undoById?: string;
};

/** The whole `import_batches.defaults` json. */
export type BatchSettings = ImportDefaults & {
  file: FileMeta;
  mappingBy: "ai" | "heuristic";
  /** why the AI was not used, shown in step 2 */
  mappingNote?: string | null;
  progress?: BatchProgress;
};

/** `import_batches.counts` */
export type BatchCounts = Partial<
  Record<
    | "total"
    | "new"
    | "merge"
    | "conflict"
    | "invalid"
    | "skip"
    | "unresolved"
    | "toCommit"
    | "cleaned"
    | "matched"
    | "committed"
    | "created"
    | "updated"
    | "purchases"
    | "purchasesSkipped"
    | "failed"
    | "uniqueContacts"
    | "undone"
    | "deletedContacts"
    | "keptContacts"
    | "revertedContacts"
    | "deletedPurchases",
    number
  >
>;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** A row after column mapping: every target field with the raw text found for it. */
export type MappedRow = Partial<Record<Exclude<TargetField, "ignore">, string>> & {
  /** phones from every phone column (the first is the main one) */
  phones?: string[];
  /** extra columns mapped to notes, as "Header: value" */
};

export type CleanPurchase = {
  productName: string;
  productId: string | null;
  family: string | null;
  amount: number;
  currency: string;
  /** ISO timestamp */
  purchasedAt: string | null;
  orderId: string | null;
  paymentMode: PaymentMode;
};

/** A row after step 3. Missing fields stay null: nothing is guessed. */
export type CleanRow = {
  phone: string | null;
  phoneCountry: string | null;
  altPhones: string[];
  name: string | null;
  email: string | null;
  altEmails: string[];
  city: string | null;
  state: string | null;
  country: string | null;
  language: string | null;
  ageBand: string | null;
  industry: string | null;
  designation: string | null;
  companyName: string | null;
  firstDoor: string | null;
  campaign: string | null;
  tags: string[];
  ownerId: string | null;
  notes: string | null;
  /** ISO: when this touch happened (the enquiry date column, else the batch's records date); null = unknown */
  touchedAt?: string | null;
  consent: boolean | null;
  referrer: { phone: string | null; name: string | null } | null;
  purchase: CleanPurchase | null;
  /** problems that make the row invalid */
  errors: string[];
  /** values that were dropped or replaced by a default (the row still imports) */
  warnings: string[];
  valid: boolean;
};

/** Extra matching facts stored next to the clean row (import_rows.cleaned.match). */
export type MatchInfo = {
  /** how an existing contact was found */
  by?: "phone" | "email" | "name_city";
  /** the earlier row of this file that is the same person (phone or email), or the conflict's other row */
  sameAsRow?: number | null;
  conflictRow?: number | null;
  /** existing contacts with the same name in the same city */
  candidates?: { id: string; name: string; phone: string; city: string | null }[];
  /** the matched contact's name, for review */
  contactName?: string | null;
  /**
   * A payment without an order id that is already recorded (same person, product family, currency, amount and
   * day: in the CRM, or on an earlier row of this file). The row still imports; this payment is not recorded twice.
   */
  duplicatePurchase?: string | null;
};

export type StoredClean = CleanRow & { match?: MatchInfo };

/** The reviewer's decision for a row. */
export type Resolution = "create" | "merge" | "skip";

export const MATCH_LABELS: Record<ImportMatchResult, string> = {
  new: "New",
  merge: "Will merge",
  conflict: "Conflict",
  invalid: "Invalid",
  skip: "Skipped",
};

export const STATUS_LABELS: Record<ImportStatus, string> = {
  uploaded: "Mapping",
  mapped: "Cleaning",
  cleaned: "Matching",
  matched: "Ready to review",
  committing: "Committing",
  committed: "Committed",
  undone: "Undone",
  failed: "Failed",
};

/** What commit changed for one row, for review and for undo (import_rows.applied). */
export type AppliedRow = {
  contactId?: string;
  createdContact?: boolean;
  enquiryId?: string | null;
  purchaseId?: string | null;
  paymentIds?: string[];
  /** the order was already recorded (re-import, or a webhook got there first) */
  purchaseSkipped?: string | null;
  referrerId?: string | null;
  referrerCreated?: boolean;
  /** an existing contact: its columns before and after this row (only the ones that changed) */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  error?: string;
  /** set by undo */
  undone?: boolean;
  /** set by undo: the row merged into a contact this same import created (undone together with it) */
  withCreatedContact?: boolean;
  undoNote?: string | null;
};

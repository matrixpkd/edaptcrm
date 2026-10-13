/**
 * Display labels for stored values that are not settings lists (schema enums and fixed scales).
 * Pure: safe in server and client components.
 */
import type { InteractionType, OrgKind, PaymentMode, PaymentStatus, PurchaseStatus, RatingSource } from "@/db/schema";

export const ORG_KIND_LABELS: Record<OrgKind, string> = {
  school: "School",
  constituency_office: "Constituency office",
  company: "Company",
  partner: "Partner",
};

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  tagmango: "TagMango",
  bank_transfer: "Bank transfer",
  upi_qr: "UPI QR",
  cash: "Cash",
  other: "Other",
};

export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
  pending: "Pending",
  partial: "Part paid",
  paid: "Paid",
  refunded: "Refunded",
  cancelled: "Cancelled",
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  scheduled: "Scheduled",
  unverified: "Unverified",
  verified: "Verified",
  rejected: "Rejected",
};

export const INTERACTION_LABELS: Record<InteractionType, string> = {
  call: "Call",
  whatsapp: "WhatsApp",
  meeting: "Meeting",
  email: "Email",
  note: "Note",
  support_issue: "Support issue",
};

export const RATING_SOURCE_LABELS: Record<RatingSource, string> = {
  sales: "Sales rating",
  self: "Self-rating",
  import: "Imported",
};

/** Spending power bands from the spec's rating scales. */
export const SPENDING_BAND_LABELS: Record<number, string> = {
  1: "1 · Low",
  2: "2 · Lower-middle",
  3: "3 · Middle",
  4: "4 · Upper-middle",
  5: "5 · High",
};

export const CONTACT_TYPE_LABELS = { individual: "Individual", business: "Business" } as const;

export type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

export const PURCHASE_STATUS_TONE: Record<PurchaseStatus, Tone> = {
  pending: "warning",
  partial: "info",
  paid: "success",
  refunded: "danger",
  cancelled: "neutral",
};

export const PAYMENT_STATUS_TONE: Record<PaymentStatus, Tone> = {
  scheduled: "neutral",
  unverified: "warning",
  verified: "success",
  rejected: "danger",
};

let regionNames: Intl.DisplayNames | null = null;

/** "AE" -> "United Arab Emirates"; falls back to the code. */
export function countryName(code: string | null | undefined): string {
  if (!code) return "";
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

const amountFormatters = new Map<string, Intl.NumberFormat>();

/** "₹24,999", "AED 1,500.50": whole amounts without ".00". Falls back to "CUR 1,234" for unknown codes. */
export function formatAmount(amount: number | null | undefined, currency: string): string {
  const n = Number(amount ?? 0);
  try {
    let f = amountFormatters.get(currency);
    if (!f) {
      f = new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      });
      amountFormatters.set(currency, f);
    }
    return f.format(n);
  } catch {
    return `${currency} ${n.toLocaleString("en-IN")}`;
  }
}

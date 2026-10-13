/**
 * Pure helpers for the payment screens: the instalment schedule builder, list price / discount / final amount
 * maths, proof-file checks, the product picker's grouping and the due / waiting labels on the payments desk.
 * No server imports: safe in client components, unit tested in tests/unit/payments-rules.test.ts.
 */
import type { PaymentMode } from "@/db/schema";
import type { ActionResult } from "@/lib/action";
import { roundMoney } from "@/lib/money/fx";
import { localDaysBetween } from "@/lib/today/time";
import type { ProductFamily } from "@/lib/settings/defaults";

export const DAY_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------------------
// Modes and references
// ---------------------------------------------------------------------------

/** The order the Record payment form offers modes in (manual entry: bank and UPI first). */
export const MODE_ORDER: PaymentMode[] = ["bank_transfer", "upi_qr", "cash", "tagmango", "other"];

/** Bank transfer and UPI need the UTR, TagMango the order id. Cash and other never need one. */
export function referenceRequired(mode: PaymentMode | null | undefined): boolean {
  return mode === "bank_transfer" || mode === "upi_qr" || mode === "tagmango";
}

/** The reference field's label for a mode. */
export function referenceFieldLabel(mode: PaymentMode | null | undefined): string {
  if (mode === "tagmango") return "TagMango order id";
  if (mode === "bank_transfer" || mode === "upi_qr") return "UTR (transaction reference)";
  return "Reference";
}

// ---------------------------------------------------------------------------
// Form errors
// ---------------------------------------------------------------------------

/**
 * The failure to show as the form's headline: when it has no field errors, or when one of them belongs to a field
 * this form does not show (otherwise the message would be lost). Null when every error is shown on its field.
 */
export function unshownFailure(state: ActionResult, shownFields: readonly string[]): ActionResult {
  if (!state || state.ok) return null;
  const keys = Object.keys(state.fieldErrors ?? {});
  if (!keys.length || keys.some((k) => !shownFields.includes(k))) return state;
  return null;
}

// ---------------------------------------------------------------------------
// Proof files
// ---------------------------------------------------------------------------

export const MAX_PROOF_MB = 10;
export const MAX_PROOF_BYTES = MAX_PROOF_MB * 1024 * 1024;
/** for <input type="file" accept> */
export const PROOF_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,application/pdf,.heic,.heif";

const TYPE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};
const EXT_OK = /\.(png|jpe?g|webp|gif|heic|heif|pdf)$/i;

/**
 * The file extension to store a proof under, or null when the file is not an image or a PDF.
 * The browser's MIME type wins; when it is missing (some phones send HEIC photos without one) the name decides.
 * SVG and HTML are never accepted: proofs are served back to the team.
 */
export function proofExtension(file: { type: string; name: string }): string | null {
  const type = (file.type || "").toLowerCase().trim();
  if (type) return TYPE_EXT[type] ?? null;
  const m = EXT_OK.exec(file.name || "");
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

/** What is wrong with a proof file, or null when it is fine (image or PDF, up to 10 MB). */
export function proofProblem(file: { size: number; type: string; name: string }): string | null {
  if (!file.size) return "That file is empty. Attach the screenshot again.";
  if (file.size > MAX_PROOF_BYTES) return `The proof must be ${MAX_PROOF_MB} MB or smaller.`;
  if (!proofExtension(file)) return "Attach a screenshot, a photo or a PDF.";
  return null;
}

/** Can the browser show this stored proof as an <img>? (HEIC and PDF get a link instead.) */
export function isPreviewableImage(url: string | null | undefined): boolean {
  return !!url && /\.(png|jpe?g|webp|gif)$/i.test(url.split("?")[0]);
}

export function isPdf(url: string | null | undefined): boolean {
  return !!url && /\.pdf$/i.test(url.split("?")[0]);
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/** Parse a typed amount ("24,999", " 1500.5 ") -> number, or null when blank / not a number. */
export function parseAmount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).replace(/[,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Final amount = list price - discount (never below zero). Null when the list price is unknown. */
export function finalFromDiscount(listPrice: number | null, discount: number | null): number | null {
  if (listPrice == null || !Number.isFinite(listPrice)) return null;
  return Math.max(0, roundMoney(listPrice - (discount ?? 0)));
}

/** Discount implied by a final amount typed by hand (zero when the amount is at or above list). */
export function discountFromFinal(listPrice: number | null, finalAmount: number | null): number {
  if (listPrice == null || finalAmount == null || !Number.isFinite(listPrice) || !Number.isFinite(finalAmount)) return 0;
  return Math.max(0, roundMoney(listPrice - finalAmount));
}

/** A catalogue price in another currency, through INR (`rateFrom`/`rateTo` are INR per unit). */
export function convertPrice(price: number, rateFrom: number, rateTo: number): number {
  if (!(rateTo > 0)) return price;
  return roundMoney((price * rateFrom) / rateTo);
}

// ---------------------------------------------------------------------------
// Instalment schedule
// ---------------------------------------------------------------------------

export const MIN_INSTALMENTS = 2;
export const MAX_INSTALMENTS = 36;

export type ScheduleInterval = "monthly" | "custom";
/** One row of the schedule builder: a local calendar date and an amount in the purchase currency. */
export type ScheduleRow = { dueDate: string; amount: number };

/**
 * Split `total` into `n` instalments that add up exactly: whole units when possible, with the remainder
 * (including any paise) on the first instalment. 25,000 / 3 -> 8,334 + 8,333 + 8,333.
 */
export function splitEvenly(total: number, n: number): number[] {
  if (!Number.isFinite(total) || total <= 0 || !Number.isInteger(n) || n < 1) return [];
  const cents = Math.round(total * 100);
  let base = Math.floor(cents / n / 100) * 100;
  if (base === 0) base = Math.floor(cents / n);
  const first = cents - base * (n - 1);
  return [first, ...Array<number>(n - 1).fill(base)].map((c) => c / 100);
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-01-31" + 1 month -> "2026-02-28" (the day is clamped to the month's length). Null for a bad date. */
export function addMonthsYmd(ymd: string, months: number): string | null {
  const m = YMD.exec(ymd);
  if (!m) return null;
  const y = Number(m[1]);
  const d = Number(m[3]);
  const idx = Number(m[2]) - 1 + months;
  const ty = y + Math.floor(idx / 12);
  const tm = ((idx % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${pad(tm + 1)}-${pad(Math.min(d, last))}`;
}

/** n monthly due dates starting on `first` (each counted from the first date, so 31 Jan -> 28 Feb -> 31 Mar). */
export function monthlyDueDates(first: string, n: number): string[] {
  if (!YMD.test(first) || n < 1) return [];
  return Array.from({ length: n }, (_, i) => addMonthsYmd(first, i) ?? first);
}

/** A fresh schedule: n instalments split evenly, monthly from `firstDue`. */
export function buildSchedule(total: number, n: number, firstDue: string): ScheduleRow[] {
  const amounts = splitEvenly(total, n);
  const dates = monthlyDueDates(firstDue, n);
  return amounts.map((amount, i) => ({ dueDate: dates[i] ?? firstDue, amount }));
}

export function scheduleTotal(rows: { amount: number }[]): number {
  return roundMoney(rows.reduce((s, r) => s + (Number.isFinite(r.amount) ? r.amount : 0), 0));
}

/** Is a valid "YYYY-MM-DD" calendar date. */
export function isYmd(s: string | null | undefined): s is string {
  const m = s ? YMD.exec(s) : null;
  if (!m) return false;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return dt.getUTCFullYear() === Number(m[1]) && dt.getUTCMonth() === Number(m[2]) - 1 && dt.getUTCDate() === Number(m[3]);
}

/**
 * Problems with a schedule, as one friendly sentence (null when it is fine): at least two instalments, every one
 * with a date and an amount above zero, and together exactly the purchase amount.
 */
export function scheduleProblem(rows: ScheduleRow[], total: number | null): string | null {
  if (rows.length < MIN_INSTALMENTS) return `A schedule needs at least ${MIN_INSTALMENTS} instalments.`;
  if (rows.length > MAX_INSTALMENTS) return `Use at most ${MAX_INSTALMENTS} instalments.`;
  const badDate = rows.findIndex((r) => !isYmd(r.dueDate));
  if (badDate >= 0) return `Pick a due date for instalment ${badDate + 1}.`;
  const badAmount = rows.findIndex((r) => !(Number.isFinite(r.amount) && r.amount > 0));
  if (badAmount >= 0) return `Enter an amount above zero for instalment ${badAmount + 1}.`;
  if (total == null || !(total > 0)) return null;
  const sum = scheduleTotal(rows);
  if (Math.abs(sum - roundMoney(total)) > 0.005) {
    const diff = roundMoney(total - sum);
    return diff > 0
      ? `The instalments are ${fmt(diff)} short of the total.`
      : `The instalments are ${fmt(-diff)} more than the total.`;
  }
  return null;
}

/** The schedule sorted by due date (the first instalment is the earliest one). */
export function sortSchedule<T extends { dueDate: string }>(rows: T[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.dueDate < b.r.dueDate ? -1 : a.r.dueDate > b.r.dueDate ? 1 : a.i - b.i))
    .map((x) => x.r);
}

// ---------------------------------------------------------------------------
// Product picker
// ---------------------------------------------------------------------------

export type ProductOption = {
  id: string;
  name: string;
  family: string;
  rung: number | null;
  listPrice: number;
  currency: string;
};

export type ProductGroup = { key: string; label: string; products: ProductOption[] };

/**
 * Active products grouped by ladder family, in ladder order: rung 1 to 4, then the side groups (B2B,
 * delegation), then families no longer in Settings. Group labels read "Rung 1 · Workshops".
 */
export function groupProducts(products: ProductOption[], families: ProductFamily[]): ProductGroup[] {
  const famIndex = new Map(families.map((f, i) => [f.key, i]));
  const byFamily = new Map<string, ProductOption[]>();
  for (const p of products) {
    const list = byFamily.get(p.family) ?? [];
    list.push(p);
    byFamily.set(p.family, list);
  }
  const rungOf = (key: string) => families.find((f) => f.key === key)?.rung ?? null;
  const keys = [...byFamily.keys()].sort((a, b) => {
    const ra = rungOf(a) ?? 99;
    const rb = rungOf(b) ?? 99;
    if (ra !== rb) return ra - rb;
    return (famIndex.get(a) ?? 999) - (famIndex.get(b) ?? 999) || a.localeCompare(b);
  });
  return keys.map((key) => {
    const fam = families.find((f) => f.key === key);
    const rung = fam?.rung ?? null;
    const label = fam
      ? rung != null
        ? `Rung ${rung} · ${fam.label}`
        : `${fam.group ?? "Other"} · ${fam.label}`
      : `Other · ${key}`;
    const list = [...(byFamily.get(key) ?? [])].sort((a, b) => a.listPrice - b.listPrice || a.name.localeCompare(b.name));
    return { key, label, products: list };
  });
}

// ---------------------------------------------------------------------------
// Desk labels
// ---------------------------------------------------------------------------

export type DueState = { text: string; overdue: boolean; tone: "danger" | "warning" | "neutral" };

/**
 * "3 days overdue", "Due today", "Due tomorrow", "Due in 5 days", counted in local calendar days.
 * An instalment is overdue once its due moment has passed (due dates are stored at the end of the local day).
 */
export function dueState(dueAt: Date, now: Date, timeZone: string): DueState {
  const days = localDaysBetween(now, dueAt, timeZone);
  const overdue = dueAt.getTime() < now.getTime();
  if (days < 0) return { text: `${-days} ${-days === 1 ? "day" : "days"} overdue`, overdue: true, tone: "danger" };
  if (days === 0) return { text: overdue ? "Due today, now overdue" : "Due today", overdue, tone: overdue ? "danger" : "warning" };
  if (days === 1) return { text: "Due tomorrow", overdue, tone: "warning" };
  return { text: `Due in ${days} days`, overdue, tone: "neutral" };
}

/** Whole days a claimed payment has waited for verification. */
export function waitingDays(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY_MS));
}

/** "Today", "1 day", "4 days" */
export function waitingText(days: number): string {
  if (days <= 0) return "Today";
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** Waiting at least the alert threshold (thresholds.unverifiedPaymentDays): same rule as the Unverified payment alert. */
export function isStaleClaim(since: Date, now: Date, thresholdDays: number): boolean {
  return now.getTime() - since.getTime() >= thresholdDays * DAY_MS;
}

function fmt(n: number): string {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

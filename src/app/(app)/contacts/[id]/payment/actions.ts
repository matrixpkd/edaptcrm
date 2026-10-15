"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { PAYMENT_MODES, type PaymentMode } from "@/db/schema";
import { bool, fail, num, str, type ActionResult } from "@/lib/action";
import { can, canEditContact, canViewContact } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { recordPurchase, type RecordPurchaseInput } from "@/lib/money";
import { BASE_CURRENCY, normalizeCurrency } from "@/lib/money/fx";
import { getSettings } from "@/lib/settings";
import { validTimeZone } from "@/lib/today/time";
import { isUuid } from "@/lib/utils";
import {
  MAX_INSTALMENTS,
  isYmd,
  referenceRequired,
  scheduleProblem,
  sortSchedule,
  type ScheduleRow,
} from "@/components/payments/rules";
import {
  dueDateFromInput,
  failFields,
  moneyDateFromInput,
  moneyFailureFor,
  readProof,
  storeProof,
} from "@/app/(app)/payments/_lib/forms";
import { getPayableContact } from "@/app/(app)/payments/_lib/queries";

const MAX_NOTES = 2000;
const MAX_NAME = 200;

/** Service field -> form field. */
const FIELD_MAP: Record<string, string> = {
  purchasedAt: "purchaseDate",
  paidAt: "purchaseDate",
  paidAmount: "instalments",
  productId: "productId",
};

/**
 * Record payment: one purchase with what was paid now and, optionally, an instalment schedule.
 * Sales record on their own and pool contacts; managers and admins on anyone, and may mark it verified at once.
 * Bank and UPI money stays unverified (and out of LTV) until a manager verifies it.
 */
export async function recordPaymentAction(contactId: string, _prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!can(user, "payments.record")) return fail("You can't record payments.");
  const contact = await getPayableContact(contactId);
  if (!contact || contact.mergedIntoId || !canViewContact(user, contact)) return fail("This contact is not available to you.");
  if (!canEditContact(user, contact)) return fail("Only the owner or a manager can record a payment for this contact.");

  const settings = await getSettings(["currency", "ladder.families"]);
  const tz = validTimeZone(user.timezone);
  const now = new Date();
  const errors: Record<string, string> = {};

  // Product: from the catalogue, or "Other" with a name and a ladder family.
  const productChoice = str(fd, "productId");
  let productId: string | null = null;
  let productName: string | null = null;
  let family: string | null = null;
  if (!productChoice) errors.productId = "Pick the product, or Other.";
  else if (productChoice === "other") {
    productName = str(fd, "productName");
    family = str(fd, "family");
    if (!productName) errors.productName = "Type the product name.";
    else if (productName.length > MAX_NAME) errors.productName = "Keep the product name short.";
    if (!family || !settings["ladder.families"].some((f) => f.key === family)) errors.family = "Pick the product family.";
  } else if (isUuid(productChoice)) productId = productChoice;
  else errors.productId = "Pick the product, or Other.";

  // Currency: only those switched on in Settings > Currency.
  const enabled = settings.currency.enabled.map(normalizeCurrency);
  const currency = normalizeCurrency(str(fd, "currency")) || "INR";
  if (currency !== BASE_CURRENCY && !enabled.includes(currency)) errors.currency = `${currency} is not switched on in Settings > Currency.`;

  // Amounts
  const listPrice = num(fd, "listPrice");
  const discount = num(fd, "discount");
  const amount = num(fd, "amount");
  // typed but not a number ("abc") is refused, not silently dropped
  if (listPrice === null && str(fd, "listPrice")) errors.listPrice = "Enter the list price as a number, or leave it empty.";
  else if (listPrice !== null && listPrice < 0) errors.listPrice = "The list price can't be negative.";
  if (discount === null && str(fd, "discount")) errors.discount = "Enter the discount as a number, or leave it empty.";
  else if (discount !== null && discount < 0) errors.discount = "The discount can't be negative.";
  if (amount === null || !(amount > 0)) errors.amount = "Enter the final amount.";

  // Date and mode
  const purchasedAt = moneyDateFromInput(str(fd, "purchaseDate"), tz, now);
  if (!purchasedAt) errors.purchaseDate = "Enter the purchase date.";
  const modeRaw = str(fd, "mode");
  const mode = PAYMENT_MODES.includes(modeRaw as PaymentMode) ? (modeRaw as PaymentMode) : null;
  if (!mode) errors.mode = "Pick how they paid.";

  // Instalments
  const useInstalments = bool(fd, "instalments");
  const firstPaidNow = useInstalments ? bool(fd, "firstPaidNow") : true;
  let instalments: { amount: number; dueAt: Date }[] | undefined;
  if (useInstalments) {
    const rows = parseSchedule(str(fd, "schedule"));
    const problem = rows ? scheduleProblem(rows, amount) : "The instalment schedule could not be read. Set it up again.";
    if (problem) errors.instalments = problem;
    else if (rows) {
      instalments = sortSchedule(rows).map((r) => ({ amount: r.amount, dueAt: dueDateFromInput(r.dueDate, tz)! }));
      if (instalments.some((i) => !i.dueAt)) errors.instalments = "Every instalment needs a real due date.";
    }
  }

  // Reference (UTR / TagMango order id) for the money paid now
  const paysNow = !useInstalments || firstPaidNow;
  const reference = paysNow ? str(fd, "reference") : null;
  if (paysNow && mode && referenceRequired(mode) && !reference) {
    errors.reference = mode === "tagmango" ? "Enter the TagMango order id." : "Enter the UTR for this payment.";
  }
  if (reference && reference.length > 100) errors.reference = "That reference is too long.";

  const organisationId = str(fd, "organisationId");
  if (organisationId && !isUuid(organisationId)) errors.organisationId = "Pick the organisation from the list.";
  const notes = str(fd, "notes");
  if (notes && notes.length > MAX_NOTES) errors.notes = `Keep notes under ${MAX_NOTES} characters.`;

  const verifyNow = paysNow && bool(fd, "verifyNow");
  if (verifyNow && !can(user, "payments.verify")) errors.verifyNow = "Only a manager can mark a payment as verified.";

  const proof = paysNow ? readProof(fd) : { file: null, error: null };
  if (proof.error) errors.proof = proof.error;

  if (Object.keys(errors).length) return failFields(errors);

  let purchaseId: string;
  try {
    const proofUrl = proof.file ? await storeProof(proof.file) : null;
    const input: RecordPurchaseInput = {
      contactId: contact.id,
      productId,
      productName: productId ? null : productName,
      family: productId ? null : family,
      listPrice,
      discount,
      amount: amount!,
      currency,
      purchasedAt: purchasedAt!,
      mode: mode!,
      organisationId: organisationId || null,
      proofUrl,
      notes,
      source: "manual",
      instalments,
      paidNow: paysNow
        ? { amount: instalments ? instalments[0].amount : amount!, reference, proofUrl }
        : null,
      ...(verifyNow ? { verified: true } : {}),
    };
    ({ purchaseId } = await recordPurchase(input, user));
  } catch (e) {
    return moneyFailureFor(user, e, FIELD_MAP);
  }

  revalidatePath(`/contacts/${contact.id}`);
  revalidatePath("/payments");
  redirect(`/payments/${purchaseId}?recorded=1`);
}

/** The schedule builder's hidden JSON: [{ dueDate: "YYYY-MM-DD", amount: 1234.5 }, ...]. */
function parseSchedule(raw: string | null): ScheduleRow[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v) || v.length > MAX_INSTALMENTS * 2) return null;
    const rows: ScheduleRow[] = [];
    for (const item of v) {
      if (!item || typeof item !== "object") return null;
      const { dueDate, amount } = item as { dueDate?: unknown; amount?: unknown };
      const n = typeof amount === "number" ? amount : typeof amount === "string" ? Number(amount.replace(/,/g, "")) : NaN;
      rows.push({ dueDate: typeof dueDate === "string" && isYmd(dueDate) ? dueDate : "", amount: n });
    }
    return rows.length >= 1 ? rows : null;
  } catch {
    return null;
  }
}

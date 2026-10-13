/**
 * "What we read": the values the extractors find in a stored payload with the current field paths, for the event
 * viewer in Settings > Integrations. PURE (no server-only imports).
 */
import type { IntegrationFieldPaths, SelfRatingConfig } from "./config";
import {
  extractPabblyLead,
  extractTagMango,
  extractWhatsApp,
  LIBROMI_FIELDS,
  matchButtonReply,
  matchSelfRatings,
  PABBLY_FIELDS,
  TAGMANGO_FIELDS,
  type Answer,
  type FieldTable,
  type SelfRatingMatch,
} from "./extract";
import type { WebhookSource } from "./sources";

export type ExplainRow = { field: string; label: string; value: string | null; path: string | null };
export type Explanation = {
  /** what the pipe will do with it, in one line */
  verdict: string;
  rows: ExplainRow[];
  answers: Answer[];
  /** self-ratings found, as "Umer familiarity: 3 (from "How well do you know Umer?")" */
  selfRatings: string[];
};

type Ctx = {
  paths: IntegrationFieldPaths;
  selfRatings: SelfRatingConfig;
  firstDoors: readonly { key: string; label: string }[];
  /** integrations.options.timeZone: zone for date-times written without one */
  timeZone?: string;
};

/** A refund only needs the order, its status and the money: the buyer fields are not read for it. */
const REFUND_ROWS = new Set(["orderId", "status", "amount", "currency", "refundAmount", "refundId", "refundReason"]);

const FIELD_LABEL: Record<string, string> = { firstDoor: "First door", umerLevel: "Umer familiarity", aiLevel: "AI knowledge" };

function fmt(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function rowsOf(table: FieldTable, values: Record<string, unknown>, used: Record<string, string>): ExplainRow[] {
  return Object.keys(values).map((field) => ({
    field,
    label: table[field]?.label ?? field,
    value: fmt(values[field]),
    path: used[field] ?? null,
  }));
}

function ratingLines(m: SelfRatingMatch, doors: Ctx["firstDoors"]): string[] {
  return m.matched.map((x) => {
    const shown = x.field === "firstDoor" ? (doors.find((d) => d.key === x.value)?.label ?? String(x.value)) : String(x.value);
    return `${FIELD_LABEL[x.field] ?? x.field}: ${shown} (from "${x.question}")`;
  });
}

export function explainPayload(source: WebhookSource, payload: unknown, ctx: Ctx): Explanation {
  if (source === "tagmango") {
    const o = extractTagMango(payload, ctx.paths.tagmango, { timeZone: ctx.timeZone });
    const m = matchSelfRatings(o.answers, ctx.selfRatings, ctx.firstDoors);
    const verdict = !o.orderId
      ? "No order id found: this event cannot be processed until the orderId path is set."
      : !o.checkout
        ? `Status "${o.status ?? "missing"}" is not a started, failed, completed or refunded order: skipped.`
        : o.checkout === "refunded"
          ? "Refund: a refund payment on the recorded order (LTV drops by it)."
          : o.checkout === "completed"
          ? o.amount === null
            ? "Completed order, but no amount found: set the amount path."
            : "Completed order: contact, verified purchase, referral and self-ratings."
          : o.checkout === "started"
            ? "Checkout started: a call task after an hour unless the order is paid."
            : "Payment failed: a call task after an hour unless the order is paid.";
    return {
      verdict: o.phone || o.checkout !== "completed" || !o.email ? verdict : `${verdict} No phone: matched by email.`,
      rows: rowsOf(
        TAGMANGO_FIELDS,
        {
          orderId: o.orderId,
          status: o.status ? `${o.status} → ${o.checkout ?? "not handled"}` : null,
          phone: o.phone,
          dialCode: o.dialCode ?? o.country,
          name: o.name,
          email: o.email,
          amount: o.amount,
          currency: o.currency,
          productName: o.productName,
          productId: o.productId,
          purchasedAt: o.purchasedAt,
          affiliateName: o.affiliate?.name,
          affiliatePhone: o.affiliate?.phone,
          campaign: o.campaign,
          city: o.city,
          ...(o.checkout === "refunded" ? { refundAmount: o.refundAmount, refundId: o.refundId, refundReason: o.refundReason } : {}),
        },
        o.used,
      ).filter((r) => o.checkout !== "refunded" || REFUND_ROWS.has(r.field)),
      answers: o.answers,
      selfRatings: ratingLines(m, ctx.firstDoors),
    };
  }

  if (source === "libromi" || source === "pabbly_whatsapp") {
    const w = extractWhatsApp(payload, ctx.paths.libromi, { timeZone: ctx.timeZone });
    const reply = w.button ? matchButtonReply(w.button, ctx.selfRatings, ctx.firstDoors) : null;
    const verdict =
      w.kind === "status"
        ? "A delivery status update: skipped."
        : w.kind === "outgoing"
          ? "A message sent from Edapt's number: skipped."
          : !w.phone
            ? "No sender phone found: set the phone path."
            : "Inbound message: a new enquiry, or a logged reply inside the conversation window.";
    return {
      verdict,
      rows: rowsOf(
        LIBROMI_FIELDS,
        {
          messageId: w.messageId,
          phone: w.phone,
          name: w.name,
          text: w.text,
          messageType: w.messageType,
          timestamp: w.timestamp,
          buttonId: w.button?.id,
          buttonTitle: w.button?.title,
          campaign: w.referral?.campaign,
          adId: w.referral?.adId,
          referralSource: w.referral ? `${w.referral.sourceType ?? "?"}${w.referral.fromAd ? " (ad)" : ""}` : null,
        },
        w.used,
      ),
      answers: [],
      selfRatings: reply ? [`${FIELD_LABEL[reply.field]}: ${reply.value} (button "${w.button?.title ?? w.button?.id}")`] : [],
    };
  }

  const l = extractPabblyLead(payload, ctx.paths.pabbly, { timeZone: ctx.timeZone });
  const m = matchSelfRatings(l.answers, ctx.selfRatings, ctx.firstDoors);
  return {
    verdict: l.phone ? `${source === "pabbly_meta" ? "Meta lead" : "Website form"}: a new enquiry.` : "No phone found: map the phone field in Pabbly.",
    rows: rowsOf(
      PABBLY_FIELDS,
      {
        leadId: l.leadId,
        phone: l.phone,
        dialCode: l.dialCode ?? l.country,
        name: l.name,
        email: l.email,
        campaign: l.campaign,
        formName: l.formName,
        adName: l.adName,
        productInterest: l.productInterest,
        city: l.city,
        language: l.language,
        firstDoor: l.firstDoor,
        consent: l.consent === null ? null : l.consent ? "yes" : "no",
        submittedAt: l.submittedAt,
      },
      l.used,
    ),
    answers: l.answers,
    selfRatings: ratingLines(m, ctx.firstDoors),
  };
}

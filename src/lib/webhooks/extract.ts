/**
 * Tolerant readers for the capture pipes: TagMango order webhooks, Libromi WhatsApp messages (Meta Cloud API
 * envelope, flat payloads and Pabbly-forwarded variants) and the Pabbly lead contract. PURE and unit tested
 * (tests/unit/webhooks-extract.test.ts against tests/fixtures/webhooks/*.json).
 *
 * TagMango's and Libromi's exact field names are not documented to us, so every value is looked up through a
 * list of candidate paths (FIELDS below). An admin can put their own paths in front of the candidates in
 * Settings > Integrations (settings key `integrations.fieldPaths`), so a payload change never needs a code change.
 */
import { listKeyFor } from "@/lib/contacts/rules";
import type { SelfRatingConfig, SelfRatingField } from "./config";
import {
  asBool,
  asCurrency,
  asDate,
  asNumber,
  asPhoneText,
  asText,
  containsPhrase,
  findFirst,
  getPath,
  isObject,
  isPresent,
  looseEquals,
  type Found,
  type JsonObject,
} from "./paths";

// ---------------------------------------------------------------------------
// Candidate paths
// ---------------------------------------------------------------------------

export type FieldSpec = { label: string; paths: readonly string[] };
export type FieldTable = Record<string, FieldSpec>;
/** field -> admin paths, tried before the built-in candidates */
export type PathOverrides = Record<string, string[] | string | undefined> | undefined;

export const TAGMANGO_FIELDS = {
  orderId: {
    label: "Order id",
    paths: ["orderId", "order_id", "order.orderId", "order.id", "order._id", "data.orderId", "data.order_id", "data.order.id", "data.order._id", "data._id", "data.id", "_id", "id"],
  },
  status: {
    label: "Status",
    paths: [
      "orderStatus", "order_status", "status", "paymentStatus", "payment_status", "order.status", "order.orderStatus",
      "payment.status", "data.orderStatus", "data.status", "data.paymentStatus", "data.order.status", "event", "eventType",
      "event_type", "type", "data.event", "data.type",
    ],
  },
  phone: {
    label: "Phone",
    paths: [
      "phone", "phoneNumber", "phone_number", "mobile", "mobileNumber", "mobile_number", "contactNumber", "whatsapp",
      "customer.phone", "customer.mobile", "customer.phoneNumber", "user.phone", "user.mobile", "user.phoneNumber",
      "buyer.phone", "buyer.mobile", "fan.phone", "fan.mobile", "data.phone", "data.mobile", "data.customer.phone",
      "data.user.phone", "data.buyer.phone", "data.fan.phone",
    ],
  },
  dialCode: {
    label: "Dial code",
    paths: [
      "dialCode", "dial_code", "countryCode", "country_code", "phoneCountryCode", "phone_country_code",
      "customer.dialCode", "customer.dial_code", "customer.countryCode", "user.dialCode", "user.countryCode",
      "buyer.dialCode", "fan.dialCode", "fan.countryCode", "data.dialCode", "data.countryCode", "data.customer.dialCode",
      "data.user.dialCode", "data.user.countryCode", "data.fan.dialCode", "data.fan.countryCode",
    ],
  },
  name: {
    label: "Name",
    paths: [
      "name", "fullName", "full_name", "customerName", "customer_name", "buyerName", "userName", "customer.name",
      "customer.fullName", "user.name", "user.fullName", "buyer.name", "fan.name", "data.name", "data.customer.name",
      "data.user.name", "data.fan.name",
    ],
  },
  firstName: { label: "First name", paths: ["firstName", "first_name", "customer.firstName", "user.firstName", "data.firstName"] },
  lastName: { label: "Last name", paths: ["lastName", "last_name", "customer.lastName", "user.lastName", "data.lastName"] },
  email: {
    label: "Email",
    paths: [
      "email", "emailId", "email_id", "emailAddress", "customerEmail", "customer_email", "customer.email", "user.email",
      "buyer.email", "fan.email", "data.email", "data.customer.email", "data.user.email", "data.fan.email",
    ],
  },
  amount: {
    label: "Amount paid",
    paths: [
      "amountPaid", "amount_paid", "paidAmount", "finalAmount", "final_amount", "amount", "totalAmount", "total_amount",
      "total", "price", "order.amount", "order.amountPaid", "order.total", "payment.amount", "data.amountPaid",
      "data.finalAmount", "data.amount", "data.total", "data.order.amount",
    ],
  },
  currency: {
    label: "Currency",
    paths: ["currency", "currencyCode", "currency_code", "order.currency", "payment.currency", "data.currency", "data.order.currency", "mango.currency"],
  },
  productName: {
    label: "Product",
    paths: [
      "mangoName", "mango_name", "mango.title", "mango.name", "productName", "product_name", "product.name",
      "product.title", "courseName", "course_name", "course.title", "course.name", "offeringName", "items[0].name",
      "items[0].title", "data.mangoName", "data.mango.title", "data.mango.name", "data.productName", "data.product.name",
      "title",
    ],
  },
  productId: {
    label: "Product id",
    paths: [
      "mangoId", "mango_id", "mango._id", "mango.id", "productId", "product_id", "product._id", "product.id", "courseId",
      "course_id", "items[0].id", "items[0]._id", "data.mangoId", "data.mango._id", "data.mango.id", "data.productId",
    ],
  },
  purchasedAt: {
    label: "Order time",
    paths: [
      "paidAt", "paid_at", "completedAt", "completed_at", "orderDate", "order_date", "createdAt", "created_at",
      "order.paidAt", "order.createdAt", "data.paidAt", "data.createdAt", "data.created_at", "data.order.paidAt",
      "data.order.createdAt", "date", "timestamp", "time",
    ],
  },
  affiliateName: {
    label: "Affiliate name",
    paths: [
      "affiliate.name", "affiliate.fullName", "affiliateName", "affiliate_name", "affiliate.user.name", "referrer.name",
      "referrerName", "referrer_name", "referredBy.name", "data.affiliate.name", "data.affiliateName",
    ],
  },
  affiliatePhone: {
    label: "Affiliate phone",
    paths: [
      "affiliate.phone", "affiliate.mobile", "affiliate.phoneNumber", "affiliatePhone", "affiliate_phone",
      "affiliate.user.phone", "referrer.phone", "referrerPhone", "referrer_phone", "referredBy.phone",
      "data.affiliate.phone", "data.affiliatePhone",
    ],
  },
  affiliateDialCode: {
    label: "Affiliate dial code",
    paths: ["affiliate.dialCode", "affiliate.dial_code", "affiliate.countryCode", "affiliateDialCode", "referrer.dialCode", "data.affiliate.dialCode"],
  },
  campaign: {
    label: "Campaign",
    paths: ["utm_campaign", "utmCampaign", "utm.campaign", "utm.utm_campaign", "utmParams.utm_campaign", "campaign", "campaignName", "data.utm_campaign", "data.campaign"],
  },
  city: { label: "City", paths: ["city", "customer.city", "user.city", "address.city", "billingAddress.city", "data.city", "data.customer.city"] },
  refundAmount: {
    label: "Refund amount",
    paths: [
      "refundAmount", "refund_amount", "refundedAmount", "refunded_amount", "amountRefunded", "amount_refunded",
      "refund.amount", "order.refundAmount", "data.refundAmount", "data.refund_amount", "data.refund.amount",
      "data.order.refundAmount",
    ],
  },
  refundId: {
    label: "Refund id",
    paths: ["refundId", "refund_id", "refund.id", "refund._id", "data.refundId", "data.refund_id", "data.refund.id", "data.refund._id"],
  },
  refundReason: {
    label: "Refund reason",
    paths: ["refundReason", "refund_reason", "refund.reason", "reason", "data.refundReason", "data.refund.reason", "data.reason"],
  },
  customFields: {
    label: "Custom checkout fields",
    paths: [
      "customFields", "custom_fields", "additionalFields", "additional_fields", "formAnswers", "form_answers",
      "checkoutFields", "checkout_fields", "extraFields", "answers", "questions", "customQuestions", "data.customFields",
      "data.additionalFields", "data.formAnswers", "data.answers", "order.customFields",
    ],
  },
} as const satisfies FieldTable;

export const LIBROMI_FIELDS = {
  messageId: {
    label: "Message id",
    paths: ["_wa.message.id", "messageId", "message_id", "msgId", "msg_id", "wamid", "message.id", "data.messageId", "data.message_id", "data.message.id", "data.id", "id"],
  },
  phone: {
    label: "Sender phone",
    paths: [
      "_wa.message.from", "_wa.contact.wa_id", "from", "phone", "phone_number", "phoneNumber", "mobile", "waId", "wa_id",
      "sender", "senderPhone", "sender_phone", "customer.phone", "contact.phone", "contact.wa_id", "contact.mobile",
      "message.from", "user.phone", "data.from", "data.phone", "data.mobile", "data.waId", "data.contact.phone",
      "data.customer.phone",
    ],
  },
  dialCode: { label: "Dial code", paths: ["dialCode", "dial_code", "countryCode", "country_code", "contact.countryCode", "data.countryCode"] },
  name: {
    label: "Sender name",
    paths: [
      "_wa.contact.profile.name", "name", "profileName", "profile_name", "senderName", "sender_name", "pushName",
      "contact.name", "contact.profile.name", "customer.name", "user.name", "data.name", "data.profileName",
      "data.contact.name", "data.customer.name",
    ],
  },
  text: {
    label: "Message text",
    paths: [
      "_wa.message.text.body", "_wa.message.button.text", "_wa.message.interactive.button_reply.title",
      "_wa.message.interactive.list_reply.title", "_wa.message.image.caption", "_wa.message.video.caption",
      "_wa.message.document.caption", "text", "text.body", "message", "message.text", "message.text.body", "message.body",
      "body", "content", "data.text", "data.message", "data.body", "data.message.text", "data.message.body",
    ],
  },
  messageType: { label: "Message type", paths: ["_wa.message.type", "messageType", "message_type", "message.type", "data.messageType", "data.type", "type"] },
  event: { label: "Event", paths: ["event", "eventType", "event_type", "webhookType", "topic", "data.event", "data.eventType", "type"] },
  deliveryStatus: { label: "Delivery status", paths: ["_wa.status.status", "messageStatus", "message_status", "deliveryStatus", "status", "ack", "data.status", "data.messageStatus"] },
  direction: {
    label: "Direction",
    paths: ["direction", "message.direction", "data.direction", "fromMe", "from_me", "isOutgoing", "is_outgoing", "message.fromMe", "data.fromMe", "data.message.fromMe"],
  },
  timestamp: {
    label: "Sent at",
    paths: [
      "_wa.message.timestamp", "timestamp", "time", "receivedAt", "received_at", "createdAt", "created_at",
      "message.timestamp", "data.timestamp", "data.time", "data.createdAt",
    ],
  },
  buttonId: {
    label: "Button id",
    paths: [
      "_wa.message.interactive.button_reply.id", "_wa.message.interactive.list_reply.id", "_wa.message.button.payload",
      "buttonId", "button_id", "buttonPayload", "button_payload", "button_reply.id", "buttonReply.id",
      "interactive.button_reply.id", "interactive.list_reply.id", "button.payload", "message.button.payload",
      "message.interactive.button_reply.id", "postbackText", "postback", "data.buttonId", "data.button_id",
      "data.buttonPayload",
    ],
  },
  buttonTitle: {
    label: "Button title",
    paths: [
      "_wa.message.interactive.button_reply.title", "_wa.message.interactive.list_reply.title", "_wa.message.button.text",
      "buttonText", "button_text", "buttonTitle", "button_title", "button_reply.title", "buttonReply.title",
      "interactive.button_reply.title", "interactive.list_reply.title", "button.text", "message.button.text",
      "message.interactive.button_reply.title", "data.buttonText", "data.button_text",
    ],
  },
  campaign: {
    label: "Campaign or ad",
    paths: [
      "_wa.message.referral.headline", "campaign", "campaignName", "campaign_name", "utm_campaign", "referral.headline",
      "ctwa.headline", "ad_name", "adName", "ad.name", "message.referral.headline", "data.campaign",
      "data.referral.headline",
    ],
  },
  adId: { label: "Ad id", paths: ["_wa.message.referral.source_id", "referral.source_id", "ad_id", "adId", "ad.id", "ctwa.source_id", "message.referral.source_id", "data.referral.source_id"] },
  referralSource: {
    label: "Referral source",
    paths: ["_wa.message.referral.source_type", "referral.source_type", "source_type", "referral_source", "ctwa.source_type", "message.referral.source_type", "data.referral.source_type"],
  },
  ctwaClid: { label: "Click-to-WhatsApp id", paths: ["_wa.message.referral.ctwa_clid", "referral.ctwa_clid", "ctwa_clid", "ctwaClid", "ctwa.ctwa_clid", "message.referral.ctwa_clid"] },
} as const satisfies FieldTable;

export const PABBLY_FIELDS = {
  leadId: {
    label: "Lead id",
    paths: ["lead_id", "leadId", "leadgen_id", "leadgenId", "submission_id", "submissionId", "entry_id", "entryId", "response_id", "id", "data.lead_id", "data.id"],
  },
  phone: {
    label: "Phone",
    paths: [
      "phone", "phone_number", "phoneNumber", "mobile", "mobile_number", "mobileNumber", "whatsapp", "whatsapp_number",
      "contact_number", "contactNumber", "tel", "data.phone", "data.phone_number", "lead.phone",
    ],
  },
  dialCode: { label: "Dial code", paths: ["dial_code", "dialCode", "country_code", "countryCode", "phone_country_code"] },
  name: { label: "Name", paths: ["name", "full_name", "fullName", "your_name", "data.name", "data.full_name", "lead.name"] },
  firstName: { label: "First name", paths: ["first_name", "firstName", "fname"] },
  lastName: { label: "Last name", paths: ["last_name", "lastName", "lname"] },
  email: { label: "Email", paths: ["email", "email_address", "emailAddress", "your_email", "work_email", "data.email", "lead.email"] },
  campaign: { label: "Campaign", paths: ["campaign", "campaign_name", "campaignName", "utm_campaign", "utmCampaign"] },
  formName: { label: "Form name", paths: ["form_name", "formName", "form", "form_title", "formTitle", "page_name"] },
  adName: { label: "Ad name", paths: ["ad_name", "adName", "ad", "adset_name", "adsetName"] },
  productInterest: {
    label: "Product interest",
    paths: ["product_interest", "productInterest", "product", "interest", "interested_in", "course", "program", "service"],
  },
  city: { label: "City", paths: ["city", "your_city", "location", "district", "town"] },
  language: { label: "Language", paths: ["language", "preferred_language", "preferredLanguage"] },
  firstDoor: { label: "First door", paths: ["first_door", "firstDoor"] },
  consent: { label: "Consent", paths: ["consent", "whatsapp_consent", "whatsappConsent", "opt_in", "optin", "optIn", "marketing_consent"] },
  submittedAt: { label: "Submitted at", paths: ["created_time", "createdTime", "submitted_at", "submittedAt", "created_at", "createdAt", "timestamp", "date"] },
  answers: {
    label: "Form answers",
    paths: ["answers", "form_answers", "formAnswers", "questions", "custom_questions", "customQuestions", "field_data", "custom_fields", "customFields"],
  },
} as const satisfies FieldTable;

export const FIELD_TABLES = { tagmango: TAGMANGO_FIELDS, libromi: LIBROMI_FIELDS, pabbly: PABBLY_FIELDS } as const;

/** Admin paths first, then the built-in candidates (no repeats). */
export function pathsFor(spec: FieldSpec, override: string[] | string | undefined): string[] {
  const own = (Array.isArray(override) ? override : override ? [override] : []).map((p) => String(p).trim()).filter(Boolean);
  return [...new Set([...own, ...spec.paths])];
}

/** Reads fields of one table from one payload, remembering which path supplied each value. */
class Reader<T extends FieldTable> {
  readonly used: Record<string, string> = {};
  constructor(
    private readonly root: unknown,
    private readonly table: T,
    private readonly overrides: PathOverrides,
  ) {}

  paths(field: keyof T & string): string[] {
    return pathsFor(this.table[field], this.overrides?.[field]);
  }

  read<V>(field: keyof T & string, convert: (v: unknown) => V | null): V | null {
    const hit: Found<V> | null = findFirst(this.root, this.paths(field), convert);
    if (!hit) return null;
    this.used[field] = hit.path;
    return hit.value;
  }

  text(field: keyof T & string, max = 500): string | null {
    const v = this.read(field, asText);
    return v === null ? null : v.slice(0, max);
  }
}

function joinName(first: string | null, last: string | null): string | null {
  const s = [first, last].filter(Boolean).join(" ").trim();
  return s || null;
}

/** "+91", "91", 91 -> "91"; "IN" -> country instead. */
function splitDialCode(raw: string | null): { dialCode: string | null; country: string | null } {
  if (!raw) return { dialCode: null, country: null };
  const s = raw.trim();
  if (/^[A-Za-z]{2}$/.test(s)) return { dialCode: null, country: s.toUpperCase() };
  const digits = s.replace(/\D/g, "");
  return { dialCode: digits && digits.length <= 4 ? digits : null, country: null };
}

// ---------------------------------------------------------------------------
// Answers (custom checkout fields, form answers)
// ---------------------------------------------------------------------------

export type Answer = { question: string; answer: string };

const QUESTION_KEYS = ["question", "label", "title", "name", "key", "field", "fieldName", "field_name", "q", "questionText"];
const ANSWER_KEYS = ["answer", "value", "response", "values", "answers", "selected", "selectedOption", "text", "a"];
const MAX_ANSWERS = 50;

function answerText(v: unknown): string | null {
  if (Array.isArray(v)) {
    const parts = v.map((x) => asText(x)).filter((x): x is string => !!x);
    return parts.length ? parts.join(", ").slice(0, 500) : null;
  }
  if (isObject(v)) {
    for (const k of ["label", "value", "text", "title", "name"]) {
      const t = asText(getPath(v, k));
      if (t) return t.slice(0, 500);
    }
    return null;
  }
  return asText(v)?.slice(0, 500) ?? null;
}

function pickFrom(o: JsonObject, keys: string[], convert: (v: unknown) => string | null): string | null {
  for (const k of keys) {
    const v = getPath(o, k);
    if (!isPresent(v)) continue;
    const t = convert(v);
    if (t) return t;
  }
  return null;
}

/**
 * Question/answer pairs from whatever shape a form or checkout sends: an array of {question|label|name, answer|value}
 * (Meta's field_data {name, values[]} included), an array of [question, answer] pairs, or an object {question: answer}.
 */
export function extractAnswers(input: unknown): Answer[] {
  let v = input;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  const out: Answer[] = [];
  const push = (q: string | null, a: string | null) => {
    if (q && a && out.length < MAX_ANSWERS) out.push({ question: q.slice(0, 300), answer: a });
  };
  if (Array.isArray(v)) {
    for (const item of v) {
      if (Array.isArray(item) && item.length >= 2) push(asText(item[0]), answerText(item[1]));
      else if (isObject(item)) push(pickFrom(item, QUESTION_KEYS, asText), pickFrom(item, ANSWER_KEYS, answerText));
    }
  } else if (isObject(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (isObject(val)) push(pickFrom(val, QUESTION_KEYS, asText) ?? k, pickFrom(val, ANSWER_KEYS, answerText));
      else push(k, answerText(val));
    }
  }
  return out;
}

/** Top-level keys that read like questions ("How did you hear about us?"), for payloads that flatten custom fields. */
export function questionLikeEntries(root: unknown): Answer[] {
  const out: Answer[] = [];
  const scan = (o: unknown) => {
    if (!isObject(o)) return;
    for (const [k, v] of Object.entries(o)) {
      if (!/[\s?]/.test(k.trim())) continue;
      const a = answerText(v);
      if (a) out.push({ question: k.trim().slice(0, 300), answer: a });
    }
  };
  scan(root);
  if (isObject(root)) scan(root.data);
  return out.slice(0, MAX_ANSWERS);
}

function mergeAnswers(...lists: Answer[][]): Answer[] {
  const seen = new Set<string>();
  const out: Answer[] = [];
  for (const a of lists.flat()) {
    const k = `${a.question.toLowerCase()}\u0000${a.answer.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out.slice(0, MAX_ANSWERS);
}

// ---------------------------------------------------------------------------
// Self-ratings at the door
// ---------------------------------------------------------------------------

export type SelfRatings = { firstDoor?: string; umerLevel?: number; aiLevel?: number };
export type SelfRatingMatch = SelfRatings & {
  matched: { field: SelfRatingField; question: string; answer: string; value: string | number }[];
};
type ListLike = readonly { key: string; label: string; active?: boolean }[];

/** Which self-rated field a question belongs to, from the configured question matchers. */
export function questionField(question: string, cfg: SelfRatingConfig): SelfRatingField | null {
  for (const q of cfg.questions ?? []) {
    if ((q.match ?? []).some((m) => containsPhrase(question, m))) return q.field;
  }
  return null;
}

function levelOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : null;
}

/** The value an answer gives a field, or null when nothing matches. */
export function answerValue(field: SelfRatingField, answer: string, cfg: SelfRatingConfig, firstDoors: ListLike): string | number | null {
  const text = answer.trim();
  if (!text) return null;
  if (field === "firstDoor") {
    const direct = listKeyFor(firstDoors, text);
    if (direct) return direct;
    for (const a of cfg.answers ?? []) {
      if (a.field !== "firstDoor") continue;
      if (!firstDoors.some((d) => d.key === a.value)) continue;
      if ((a.match ?? []).some((m) => containsPhrase(text, m))) return a.value;
    }
    return null;
  }
  // "3", "3 - watches regularly", "Level 3", "3/5"
  const lead = /^(?:level\s*)?([0-5])(?!\d)(?:\s*\/\s*5)?/i.exec(text);
  if (lead) return Number(lead[1]);
  for (const a of cfg.answers ?? []) {
    if (a.field !== field) continue;
    const n = levelOf(a.value);
    if (n === null) continue;
    if ((a.match ?? []).some((m) => containsPhrase(text, m))) return n;
  }
  return null;
}

/** Maps question/answer pairs to self-ratings; the first answer for each field wins. */
export function matchSelfRatings(answers: Answer[], cfg: SelfRatingConfig, firstDoors: ListLike): SelfRatingMatch {
  const out: SelfRatingMatch = { matched: [] };
  for (const a of answers) {
    const field = questionField(a.question, cfg);
    if (!field || out[field] !== undefined) continue;
    const value = answerValue(field, a.answer, cfg, firstDoors);
    if (value === null) continue;
    if (field === "firstDoor") out.firstDoor = String(value);
    else out[field] = Number(value);
    out.matched.push({ field, question: a.question, answer: a.answer, value });
  }
  return out;
}

const BUTTON_PREFIX: Record<string, SelfRatingField> = { door: "firstDoor", firstdoor: "firstDoor", first_door: "firstDoor", umer: "umerLevel", ai: "aiLevel" };

/**
 * A WhatsApp one-tap reply -> the self-rating it gives. Self-describing ids ("door:youtube", "umer:3", "ai_2") work
 * without configuration; otherwise the id or title must equal a configured button (case-insensitive).
 */
export function matchButtonReply(
  button: { id?: string | null; title?: string | null },
  cfg: SelfRatingConfig,
  firstDoors: ListLike,
): { field: SelfRatingField; value: string | number } | null {
  const id = button.id?.trim() ?? "";
  const m = /^(first_?door|door|umer|ai)[\s:_\-.=]+(.+)$/i.exec(id);
  if (m) {
    const field = BUTTON_PREFIX[m[1].toLowerCase()];
    if (field === "firstDoor") {
      const key = listKeyFor(firstDoors, m[2].replace(/[-]/g, "_")) ?? listKeyFor(firstDoors, m[2]);
      if (key) return { field, value: key };
    } else if (field) {
      const n = levelOf(m[2]);
      if (n !== null) return { field, value: n };
    }
  }
  for (const b of cfg.buttons ?? []) {
    if (!looseEquals(b.match, button.id) && !looseEquals(b.match, button.title)) continue;
    if (b.field === "firstDoor") {
      if (firstDoors.some((d) => d.key === b.value)) return { field: b.field, value: b.value };
    } else {
      const n = levelOf(b.value);
      if (n !== null) return { field: b.field, value: n };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// TagMango
// ---------------------------------------------------------------------------

/** completed / started / failed checkouts, and refunds of a recorded order. */
export type CheckoutClass = "completed" | "started" | "failed" | "refunded";

const FAILED_WORDS = new Set([
  "failed", "failure", "fail", "cancelled", "canceled", "cancel", "declined", "rejected", "error", "errored",
  "expired", "abandoned", "dropped", "unsuccessful", "timeout", "timedout", "aborted",
]);
const COMPLETED_WORDS = new Set([
  "completed", "complete", "paid", "success", "successful", "succeeded", "captured", "confirmed", "settled",
  "purchased", "fulfilled",
]);
const STARTED_WORDS = new Set([
  "initiated", "initiate", "started", "start", "pending", "attempted", "attempt", "processing", "progress",
  "checkout", "begin", "began", "awaiting", "unpaid", "incomplete", "open",
]);

const REFUND_WORDS = new Set(["refund", "refunded", "refunds", "chargeback", "reversed", "reversal"]);
/** "not paid", "payment_not_completed", "non paid": a completed word that is negated means it was not paid. */
const NEGATIONS = new Set(["not", "no", "non", "never"]);

/**
 * completed/paid -> completed; initiated/started/pending -> started; failed/cancelled -> failed;
 * refunded -> refunded; else null. A negated completed word ("not paid", "payment_not_completed") is a checkout
 * that has not been paid (started), never a purchase.
 */
export function classifyCheckoutStatus(raw: string | null | undefined): CheckoutClass | null {
  const tokens = (raw ?? "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (!tokens.length) return null;
  const refund = tokens.some((t) => REFUND_WORDS.has(t));
  if (tokens.some((t) => FAILED_WORDS.has(t))) return refund ? null : "failed";
  if (refund) return "refunded";
  const negatedPaid = tokens.some((t, i) => COMPLETED_WORDS.has(t) && i > 0 && NEGATIONS.has(tokens[i - 1]));
  if (negatedPaid) return "started";
  if (tokens.some((t) => COMPLETED_WORDS.has(t))) return "completed";
  if (tokens.some((t) => STARTED_WORDS.has(t))) return "started";
  return null;
}

export type TagMangoOrder = {
  orderId: string | null;
  /** the raw status text that decided the class (or the first status found when none classify) */
  status: string | null;
  checkout: CheckoutClass | null;
  phone: string | null;
  dialCode: string | null;
  /** ISO country when the dial code was sent as letters ("IN") */
  country: string | null;
  name: string | null;
  email: string | null;
  amount: number | null;
  currency: string | null;
  productName: string | null;
  productId: string | null;
  purchasedAt: Date | null;
  affiliate: { name: string | null; phone: string | null; dialCode: string | null } | null;
  campaign: string | null;
  city: string | null;
  /** refund events: the amount refunded (null: use the order amount), the refund's own id and reason */
  refundAmount: number | null;
  refundId: string | null;
  refundReason: string | null;
  answers: Answer[];
  /** field -> the path that supplied it */
  used: Record<string, string>;
};

/** Options for every extractor. */
export type ExtractOptions = {
  /** zone for date-times written without one ("2026-10-13 10:00"); default UTC (integrations.options.timeZone) */
  timeZone?: string;
};

export function extractTagMango(payload: unknown, overrides?: PathOverrides, opts: ExtractOptions = {}): TagMangoOrder {
  const root = Array.isArray(payload) ? payload[0] : payload;
  const r = new Reader(root, TAGMANGO_FIELDS, overrides);
  const date = (v: unknown) => asDate(v, opts.timeZone);

  // status: the first candidate whose value classifies wins (a generic "event" must not hide a real status).
  // Money safety: "completed" records a verified purchase, so when another status field of the same payload says
  // the payment failed (an envelope {"status": "success", "data": {"status": "failed"}}), the failure wins.
  let status: string | null = null;
  let checkout: CheckoutClass | null = null;
  let failedAt: { status: string; path: string } | null = null;
  for (const path of r.paths("status")) {
    const t = asText(getPath(root, path));
    if (!t) continue;
    if (status === null) {
      status = t;
      r.used.status = path;
    }
    const c = classifyCheckoutStatus(t);
    if (c === "failed" && !failedAt) failedAt = { status: t, path };
    if (c && !checkout) {
      status = t;
      checkout = c;
      r.used.status = path;
    }
  }
  if (checkout === "completed" && failedAt) {
    status = failedAt.status;
    checkout = "failed";
    r.used.status = failedAt.path;
  }

  const dial = splitDialCode(r.text("dialCode", 10));
  const affDial = splitDialCode(r.text("affiliateDialCode", 10));
  const affName = r.text("affiliateName", 200);
  const affPhone = r.read("affiliatePhone", asPhoneText);
  const answers = mergeAnswers(extractAnswers(r.read("customFields", (v) => v)), questionLikeEntries(root));

  return {
    orderId: r.text("orderId", 200),
    status: status?.slice(0, 100) ?? null,
    checkout,
    phone: r.read("phone", asPhoneText),
    dialCode: dial.dialCode,
    country: dial.country,
    name: r.text("name", 200) ?? joinName(r.text("firstName", 100), r.text("lastName", 100)),
    email: r.text("email", 200),
    amount: r.read("amount", asNumber),
    currency: r.read("currency", asCurrency),
    productName: r.text("productName", 300),
    productId: r.text("productId", 200),
    purchasedAt: r.read("purchasedAt", date),
    affiliate: affName || affPhone ? { name: affName, phone: affPhone, dialCode: affDial.dialCode } : null,
    campaign: r.text("campaign", 200),
    city: r.text("city", 100),
    refundAmount: checkout === "refunded" ? r.read("refundAmount", asNumber) : null,
    refundId: checkout === "refunded" ? r.text("refundId", 200) : null,
    refundReason: checkout === "refunded" ? r.text("refundReason", 300) : null,
    answers,
    used: r.used,
  };
}

// ---------------------------------------------------------------------------
// Libromi (WhatsApp)
// ---------------------------------------------------------------------------

export type WhatsAppKind = "message" | "status" | "outgoing" | "unknown";

export type WhatsAppMessage = {
  kind: WhatsAppKind;
  messageId: string | null;
  phone: string | null;
  dialCode: string | null;
  name: string | null;
  text: string | null;
  messageType: string | null;
  timestamp: Date | null;
  button: { id: string | null; title: string | null } | null;
  referral: { campaign: string | null; adId: string | null; sourceType: string | null; fromAd: boolean } | null;
  used: Record<string, string>;
};

function first(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : undefined;
}

/**
 * The payload plus `_wa`: the first message / contact / status of a Meta WhatsApp Cloud API envelope
 * (entry[0].changes[0].value), wherever it sits, so candidate paths can stay short.
 */
export function whatsappView(payload: unknown): JsonObject {
  const root = Array.isArray(payload) ? payload[0] : payload;
  const base: JsonObject = isObject(root) ? root : {};
  const candidates = [
    getPath(base, "entry[0].changes[0].value"),
    getPath(base, "data.entry[0].changes[0].value"),
    getPath(base, "payload.entry[0].changes[0].value"),
    getPath(base, "value"),
    base,
  ];
  const value = candidates.find((c) => isObject(c) && (Array.isArray(c.messages) || Array.isArray(c.statuses))) as JsonObject | undefined;
  if (!value) return { ...base, _wa: {} };
  return {
    ...base,
    _wa: { message: first(value.messages), contact: first(value.contacts), status: first(value.statuses), metadata: value.metadata },
  };
}

const OUTGOING = /\b(out|outbound|outgoing|sent|send|agent|business|echo)\b/i;
const OUTGOING_EVENTS = /\b(outgoing|outbound)\b|\bmessage sent\b|\bsent message\b/i;
const STATUS_WORDS = /\b(status|statuses|delivered|delivery|read|ack|seen|sent|failed|undelivered)\b/i;

export function extractWhatsApp(payload: unknown, overrides?: PathOverrides, opts: ExtractOptions = {}): WhatsAppMessage {
  const view = whatsappView(payload);
  const r = new Reader(view, LIBROMI_FIELDS, overrides);
  const wa = (view._wa ?? {}) as JsonObject;

  const buttonId = r.text("buttonId", 200);
  const buttonTitle = r.text("buttonTitle", 200);
  const text = r.text("text", 2000);
  const event = r.text("event", 100);
  const direction = r.read("direction", (v) => (typeof v === "boolean" ? (v ? "out" : "in") : asText(v)));
  const campaign = r.text("campaign", 200);
  const adId = r.text("adId", 200);
  const sourceType = r.text("referralSource", 50);
  const ctwa = r.text("ctwaClid", 300);
  const phone = r.read("phone", asPhoneText);

  // what kind of delivery this is: an inbound message, a delivery status, or a message Edapt sent
  let kind: WhatsAppKind;
  const hasContent = !!(text || buttonId || buttonTitle);
  const ev = (event ?? "").replace(/[_.\-]+/g, " ");
  const delivery = r.text("deliveryStatus", 50);
  if (isObject(wa.status) && !isObject(wa.message)) kind = "status";
  else if (direction && OUTGOING.test(direction) && !/\bin(bound|coming)?\b/i.test(direction)) kind = "outgoing";
  else if (isObject(wa.message)) kind = "message";
  else if (OUTGOING_EVENTS.test(ev)) kind = "outgoing";
  else if (!hasContent && (STATUS_WORDS.test(ev) || (delivery !== null && STATUS_WORDS.test(delivery)))) kind = "status";
  else kind = phone ? "message" : "unknown";

  const referralPresent = !!(campaign || adId || sourceType || ctwa);
  const dial = splitDialCode(r.text("dialCode", 10));
  return {
    kind,
    messageId: r.text("messageId", 300),
    phone,
    dialCode: dial.dialCode,
    name: r.text("name", 200),
    text,
    messageType: r.text("messageType", 50),
    timestamp: r.read("timestamp", (v) => asDate(v, opts.timeZone)),
    button: buttonId || buttonTitle ? { id: buttonId, title: buttonTitle } : null,
    referral: referralPresent
      ? { campaign, adId, sourceType, fromAd: !!(ctwa || adId || (sourceType && /\bad/i.test(sourceType))) }
      : null,
    used: r.used,
  };
}

// ---------------------------------------------------------------------------
// Pabbly lead contract (Meta lead forms, website forms)
// ---------------------------------------------------------------------------

export type PabblyLead = {
  leadId: string | null;
  phone: string | null;
  dialCode: string | null;
  country: string | null;
  name: string | null;
  email: string | null;
  campaign: string | null;
  formName: string | null;
  adName: string | null;
  productInterest: string | null;
  city: string | null;
  language: string | null;
  firstDoor: string | null;
  consent: boolean | null;
  submittedAt: Date | null;
  /** the `answers` object plus any extra top-level fields we do not read otherwise */
  answers: Answer[];
  used: Record<string, string>;
};

/** Keys that never carry an answer (tokens, tracking, form plumbing). */
const IGNORED_KEY = /^(_|utm_)|token|secret|password|recaptcha|captcha|nonce|^(submit|key|api_?key|ip|user_?agent|url|page_?url|referr?er|form_?id|page_?id|ad_?id|adset_?id|campaign_?id|platform|is_?organic|source)$/i;

export function extractPabblyLead(payload: unknown, overrides?: PathOverrides, opts: ExtractOptions = {}): PabblyLead {
  const root = Array.isArray(payload) ? payload[0] : payload;
  const r = new Reader(root, PABBLY_FIELDS, overrides);
  const dial = splitDialCode(r.text("dialCode", 10));
  const lead: PabblyLead = {
    leadId: r.text("leadId", 200),
    phone: r.read("phone", asPhoneText),
    dialCode: dial.dialCode,
    country: dial.country,
    name: r.text("name", 200) ?? joinName(r.text("firstName", 100), r.text("lastName", 100)),
    email: r.text("email", 200),
    campaign: r.text("campaign", 200),
    formName: r.text("formName", 200),
    adName: r.text("adName", 200),
    productInterest: r.text("productInterest", 200),
    city: r.text("city", 100),
    language: r.text("language", 50),
    firstDoor: r.text("firstDoor", 100),
    consent: r.read("consent", asBool),
    submittedAt: r.read("submittedAt", (v) => asDate(v, opts.timeZone)),
    answers: [],
    used: r.used,
  };

  // every top-level key some field path starts with is "ours"; the rest are extra answers
  const known = new Set<string>();
  for (const field of Object.keys(PABBLY_FIELDS) as (keyof typeof PABBLY_FIELDS)[]) {
    for (const p of r.paths(field)) known.add(p.split(/[.[]/)[0].toLowerCase().replace(/[^a-z0-9]/g, ""));
  }
  const extras: Answer[] = [];
  if (isObject(root)) {
    for (const [k, v] of Object.entries(root)) {
      if (known.has(k.toLowerCase().replace(/[^a-z0-9]/g, "")) || IGNORED_KEY.test(k)) continue;
      const a = answerText(v);
      if (a && !isObject(v)) extras.push({ question: k.slice(0, 300), answer: a });
    }
  }
  let answers = mergeAnswers(extractAnswers(r.read("answers", (v) => v)), extras);

  // Meta's raw field_data puts the contact details among the answers ({name: "phone_number", values: [...]})
  const fromAnswers = (keys: string[]): string | null => {
    const hit = answers.find((a) => keys.includes(a.question.toLowerCase().replace(/[^a-z0-9]/g, "")));
    if (!hit) return null;
    answers = answers.filter((a) => a !== hit);
    return hit.answer;
  };
  if (!lead.phone) lead.phone = fromAnswers(["phone", "phonenumber", "mobile", "mobilenumber", "whatsapp", "whatsappnumber", "contactnumber"]);
  if (!lead.name) {
    lead.name =
      fromAnswers(["name", "fullname", "yourname"]) ?? joinName(fromAnswers(["firstname"]), fromAnswers(["lastname"]));
  }
  if (!lead.email) lead.email = fromAnswers(["email", "emailaddress", "workemail"]);
  if (!lead.city) lead.city = fromAnswers(["city", "yourcity", "location", "district"]);
  lead.answers = answers;
  return lead;
}

// ---------------------------------------------------------------------------
// Batches: one delivery carrying several events
// ---------------------------------------------------------------------------

/** The most events one delivery may carry. */
export const MAX_EVENTS_PER_DELIVERY = 200;

/** A WhatsApp Cloud API envelope with several messages -> one envelope per message (statuses kept together). */
function splitCloudEnvelope(o: JsonObject): JsonObject[] {
  if (!Array.isArray(o.entry)) return [o];
  const pieces: JsonObject[] = [];
  for (const e of o.entry) {
    if (!isObject(e) || !Array.isArray(e.changes)) continue;
    for (const c of e.changes) {
      if (!isObject(c) || !isObject(c.value)) continue;
      const { messages, statuses, contacts, ...rest } = c.value;
      const people = Array.isArray(contacts) ? contacts : [];
      const piece = (value: JsonObject): JsonObject => ({ ...o, entry: [{ ...e, changes: [{ ...c, value: { ...rest, ...value } }] }] });
      for (const m of Array.isArray(messages) ? messages : []) {
        const from = isObject(m) ? asText(m.from) : null;
        const who = people.find((p) => isObject(p) && from !== null && asText(p.wa_id) === from) ?? (people.length === 1 ? people[0] : undefined);
        pieces.push(piece({ messages: [m], ...(who ? { contacts: [who] } : {}) }));
      }
      if (Array.isArray(statuses) && statuses.length) pieces.push(piece({ statuses }));
    }
  }
  return pieces.length > 1 ? pieces : [o];
}

/**
 * The events in one delivery. A JSON list (Pabbly and some senders batch) gives one event per object, and a
 * WhatsApp Cloud API envelope with several messages gives one event per message, so each is stored, keyed and
 * processed on its own and none is silently dropped. A single event is returned unchanged.
 */
export function splitWebhookPayload(source: string, payload: unknown): unknown[] {
  const items = Array.isArray(payload) ? payload.filter(isObject) : [payload];
  if (!items.length) return [payload];
  const whatsapp = source === "libromi" || source === "pabbly_whatsapp";
  return items.flatMap((item) => (whatsapp && isObject(item) ? splitCloudEnvelope(item) : [item]));
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export type CatalogueProduct = { id: string; name: string; family: string; externalIds: string[]; active?: boolean };

function globMatches(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return looseEquals(pattern, value);
  const parts = pattern.toLowerCase().split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`, "i").test(value.trim());
}

/**
 * The catalogue product of a TagMango order: by TagMango id in products.external_ids, else by name (the product's
 * own name, or an external id / `*` pattern such as "Claude Mastery*"). Active products win over inactive ones.
 */
export function matchProduct<P extends CatalogueProduct>(products: readonly P[], ref: { id?: string | null; name?: string | null }): P | null {
  const ordered = [...products].sort((a, b) => Number(b.active !== false) - Number(a.active !== false));
  const id = ref.id?.trim();
  if (id) {
    const hit = ordered.find((p) => p.externalIds.some((e) => e.trim() === id || looseEquals(e, id)));
    if (hit) return hit;
  }
  const name = ref.name?.trim();
  if (name) {
    return (
      ordered.find((p) => looseEquals(p.name, name)) ??
      ordered.find((p) => p.externalIds.some((e) => globMatches(e, name))) ??
      null
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation of admin settings (used by the settings screen's actions)
// ---------------------------------------------------------------------------

/** Cleans the field path overrides JSON; returns an error message for anything that is not usable. */
export function validateFieldPaths(input: unknown): { ok: true; value: Record<"tagmango" | "libromi" | "pabbly", Record<string, string[]>> } | { ok: false; error: string } {
  if (!isObject(input)) return { ok: false, error: "Field paths must be a JSON object such as {\"tagmango\": {\"phone\": [\"buyer.mobile\"]}}." };
  const out = { tagmango: {}, libromi: {}, pabbly: {} } as Record<"tagmango" | "libromi" | "pabbly", Record<string, string[]>>;
  for (const [source, fields] of Object.entries(input)) {
    if (!Object.hasOwn(FIELD_TABLES, source)) return { ok: false, error: `"${source}" is not a source. Use tagmango, libromi or pabbly.` };
    if (!isObject(fields)) return { ok: false, error: `"${source}" must be an object of field: [paths].` };
    const table = FIELD_TABLES[source as keyof typeof FIELD_TABLES] as FieldTable;
    for (const [field, paths] of Object.entries(fields)) {
      if (!Object.hasOwn(table, field)) {
        return { ok: false, error: `"${field}" is not a ${source} field. Fields: ${Object.keys(table).join(", ")}.` };
      }
      const list = (Array.isArray(paths) ? paths : [paths]).map((p) => (typeof p === "string" ? p.trim() : ""));
      if (list.some((p) => !p)) return { ok: false, error: `${source}.${field}: every path must be non-empty text.` };
      if (list.length > 20) return { ok: false, error: `${source}.${field}: at most 20 paths.` };
      if (list.length) out[source as keyof typeof out][field] = [...new Set(list)];
    }
  }
  return { ok: true, value: out };
}

const FIELDS_OK = new Set<string>(["firstDoor", "umerLevel", "aiLevel"]);

/** Cleans the self-rating matcher JSON. */
export function validateSelfRatingConfig(input: unknown, firstDoors: ListLike): { ok: true; value: SelfRatingConfig } | { ok: false; error: string } {
  if (!isObject(input)) return { ok: false, error: "Self-rating matchers must be a JSON object with questions, answers and buttons." };
  const strings = (v: unknown) => (Array.isArray(v) ? v : [v]).map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
  const value: SelfRatingConfig = { questions: [], answers: [], buttons: [] };
  const checkValue = (field: string, v: unknown, where: string): string | null => {
    const s = asText(v);
    if (!s) return `${where}: value is missing.`;
    if (field === "firstDoor" && !firstDoors.some((d) => d.key === s)) return `${where}: "${s}" is not a first door key (${firstDoors.map((d) => d.key).join(", ")}).`;
    if (field !== "firstDoor" && levelOf(s) === null) return `${where}: the level must be 0 to 5.`;
    return null;
  };
  for (const [name, list] of [["questions", input.questions], ["answers", input.answers], ["buttons", input.buttons]] as const) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) return { ok: false, error: `"${name}" must be a list.` };
    for (const [i, item] of list.entries()) {
      const where = `${name}[${i}]`;
      if (!isObject(item)) return { ok: false, error: `${where} must be an object.` };
      const field = asText(item.field);
      if (!field || !FIELDS_OK.has(field)) return { ok: false, error: `${where}: field must be firstDoor, umerLevel or aiLevel.` };
      if (name === "buttons") {
        const match = asText(item.match);
        if (!match) return { ok: false, error: `${where}: match (the button id or title) is missing.` };
        const err = checkValue(field, item.value, where);
        if (err) return { ok: false, error: err };
        value.buttons.push({ match, field: field as SelfRatingField, value: asText(item.value)! });
        continue;
      }
      const match = strings(item.match);
      if (!match.length) return { ok: false, error: `${where}: match needs at least one phrase.` };
      if (name === "questions") {
        value.questions.push({ field: field as SelfRatingField, match });
      } else {
        const err = checkValue(field, item.value, where);
        if (err) return { ok: false, error: err };
        value.answers.push({ field: field as SelfRatingField, value: asText(item.value)!, match });
      }
    }
  }
  return { ok: true, value };
}

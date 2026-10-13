import "server-only";
/**
 * The automatic capture pipes (spec "Capture: every way in", "One person, one record", "Purchases", "Rating
 * scales: self-rating at the door", "Data model": webhook handlers are idempotent).
 *
 * Every delivery is stored raw in webhook_events (event_key unique) BEFORE it is processed, then marked
 * processed (processed_at) or failed (error). The same event twice changes nothing: the event key, the enquiry
 * source_ref, the purchase reference (TagMango order id) and the interaction external_ref all dedupe. A failed
 * event can be reprocessed from Settings > Integrations, or by the sender delivering it again.
 *
 * Pipes call the domain services (captureEnquiry, recordPurchase, logInteraction, applyRating); no domain rule is
 * re-implemented here. The one thing added is the self-reported first door for a contact whose first door is
 * still unknown ("other"), see fillSelfReportedFirstDoor.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, lte } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { contacts, enquiries, interactions, payments, products, purchases, webhookEvents, type Role } from "@/db/schema";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth/permissions";
import { captureEnquiry, type CaptureInput } from "@/lib/contacts/capture";
import { ContactError, InvalidPhoneError } from "@/lib/contacts/errors";
import { findContactByEmail, lookupByPhone } from "@/lib/contacts/identity";
import { logInteraction } from "@/lib/contacts/interactions";
import { applyRating } from "@/lib/contacts/profile";
import { listKeyFor } from "@/lib/contacts/rules";
import { recomputeContact } from "@/lib/metrics/recompute";
import { DuplicateReferenceError, MoneyError } from "@/lib/money/errors";
import { normalizeReference } from "@/lib/money/rules";
import { recordPurchase, recordRefund } from "@/lib/money/purchases";
import { normalizePhone } from "@/lib/phone";
import { isAuthorizedWebhook } from "@/lib/secrets";
import { getSettings, type ListItem, type ProductFamily } from "@/lib/settings";
import { formatMoney } from "@/lib/utils";
import { readWebhookBody } from "./body";
import type { IntegrationFieldPaths, IntegrationOptions, SelfRatingConfig } from "./config";
import {
  extractPabblyLead,
  extractTagMango,
  extractWhatsApp,
  MAX_EVENTS_PER_DELIVERY,
  matchButtonReply,
  matchProduct,
  matchSelfRatings,
  splitWebhookPayload,
  type Answer,
  type PabblyLead,
  type SelfRatingMatch,
  type TagMangoOrder,
  type WhatsAppMessage,
} from "./extract";
import { stableStringify } from "./paths";
import { SKIP_PREFIX, STUCK_EVENT_MS, WEBHOOK_SOURCE_INFO, type WebhookSource } from "./sources";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the sender gets back (always 200 once the payload is stored). */
export type IngestOutcome = {
  ok: boolean;
  /** this event key was seen before */
  duplicate: boolean;
  eventId: string | null;
  contactId?: string | null;
  /** short description of what happened */
  result?: string;
  /** a "Skipped: ..." note when there was nothing to do */
  note?: string;
  error?: string;
};

type ProcessResult = { contactId: string | null; summary: string; note?: string | null };

/** An expected processing failure with a message an admin can act on. */
export class WebhookError extends Error {
  constructor(
    message: string,
    readonly contactId: string | null = null,
  ) {
    super(message);
    this.name = "WebhookError";
  }
}

export type IntegrationContext = {
  paths: IntegrationFieldPaths;
  selfRatings: SelfRatingConfig;
  options: IntegrationOptions;
  firstDoors: ListItem[];
  campaigns: ListItem[];
  families: ProductFamily[];
};

type WebhookEventRow = typeof webhookEvents.$inferSelect;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function loadIntegrationContext(tx: Tx = db): Promise<IntegrationContext> {
  const s = await getSettings(
    ["integrations.fieldPaths", "integrations.selfRatings", "integrations.options", "lists.firstDoors", "lists.campaigns", "ladder.families"],
    tx,
  );
  return {
    paths: s["integrations.fieldPaths"],
    selfRatings: s["integrations.selfRatings"],
    options: s["integrations.options"],
    firstDoors: s["lists.firstDoors"],
    campaigns: s["lists.campaigns"],
    families: s["ladder.families"],
  };
}

// ---------------------------------------------------------------------------
// Event keys
// ---------------------------------------------------------------------------

export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex").slice(0, 32);
}

function slug(s: string | null | undefined): string | null {
  const v = (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return v || null;
}

function keyPart(s: string): string {
  return s.trim().slice(0, 200);
}

/**
 * The idempotency key of a delivery, computed before processing:
 * tagmango:order:<id>:<completed|started|failed>, libromi:msg:<id>, meta:lead:<id>, website:form:<id>, or the
 * source plus a hash of the payload when it carries no id.
 */
export function eventKeyFor(source: WebhookSource, payload: unknown, ctx: Pick<IntegrationContext, "paths" | "options">): string {
  try {
    return eventKeyOf(source, payload, ctx);
  } catch (e) {
    // the payload must be stored whatever it holds: a reader that trips over it falls back to the payload hash
    console.error("[webhooks] could not compute the event key", e);
    return `${source}:hash:${payloadHash(payload)}`;
  }
}

function eventKeyOf(source: WebhookSource, payload: unknown, ctx: Pick<IntegrationContext, "paths" | "options">): string {
  const opts = { timeZone: ctx.options.timeZone };
  switch (source) {
    case "tagmango": {
      const o = extractTagMango(payload, ctx.paths.tagmango, opts);
      const ref = normalizeReference(o.orderId, "tagmango");
      // a refund carries its own id when the order is refunded in parts
      const refund = o.checkout === "refunded" && o.refundId ? `:${keyPart(o.refundId)}` : "";
      if (ref) return `tagmango:order:${keyPart(ref)}:${o.checkout ?? slug(o.status) ?? "unknown"}${refund}`;
      return `tagmango:hash:${payloadHash(payload)}`;
    }
    case "libromi":
    case "pabbly_whatsapp": {
      const m = extractWhatsApp(payload, ctx.paths.libromi, opts);
      if (m.kind === "message" && m.messageId) return `libromi:msg:${keyPart(m.messageId)}`;
      return `libromi:hash:${payloadHash(payload)}`;
    }
    case "pabbly_meta": {
      const l = extractPabblyLead(payload, ctx.paths.pabbly, opts);
      return `meta:lead:${l.leadId ? keyPart(l.leadId) : `h-${payloadHash(payload)}`}`;
    }
    case "pabbly_website": {
      const l = extractPabblyLead(payload, ctx.paths.pabbly, opts);
      return `website:form:${l.leadId ? keyPart(l.leadId) : `h-${payloadHash(payload)}`}`;
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const NO_STORE = { "cache-control": "no-store" };

/**
 * The POST handler of every webhook route: 401 for a wrong secret, 400 for a body that is not JSON or form data,
 * otherwise 200 with {ok, duplicate, error?} — a payload we could store never fails the response, so the sender
 * does not retry it forever; failed events are reprocessed from Settings > Integrations.
 */
export async function handleWebhookPost(req: Request, source: WebhookSource): Promise<Response> {
  if (!isAuthorizedWebhook(req, WEBHOOK_SOURCE_INFO[source].secretEnv)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }
  const body = await readWebhookBody(req);
  if (!body.ok) return Response.json({ ok: false, error: body.error }, { status: body.status, headers: NO_STORE });
  const items = splitWebhookPayload(source, body.payload);
  if (items.length > MAX_EVENTS_PER_DELIVERY) {
    return Response.json(
      { ok: false, error: `Send at most ${MAX_EVENTS_PER_DELIVERY} events per delivery.` },
      { status: 413, headers: NO_STORE },
    );
  }
  if (items.length === 1) {
    return Response.json(await ingestWebhook(source, items[0]), { status: 200, headers: NO_STORE });
  }
  // several events in one delivery (a JSON list, or a WhatsApp envelope with several messages): each is stored
  // and processed on its own, in order
  const results: IngestOutcome[] = [];
  for (const item of items) results.push(await ingestWebhook(source, item));
  const failed = results.find((r) => !r.ok);
  return Response.json(
    {
      ok: !failed,
      duplicate: results.every((r) => r.duplicate),
      eventId: results[0]?.eventId ?? null,
      result: `${results.length} events`,
      ...(failed ? { error: failed.error } : {}),
      events: results,
    },
    { status: 200, headers: NO_STORE },
  );
}

/**
 * GET on a webhook URL: a connection check for the admin ("ready"), and the Meta-style verification handshake
 * (hub.challenge with hub.verify_token = the secret) that some WhatsApp providers use.
 */
export async function handleWebhookGet(req: Request, source: WebhookSource): Promise<Response> {
  const url = new URL(req.url);
  const verifyToken = url.searchParams.get("hub.verify_token");
  let check = req;
  if (verifyToken && !url.searchParams.get("token")) {
    const u = new URL(url);
    u.searchParams.set("token", verifyToken);
    check = new Request(u, { headers: req.headers });
  }
  if (!isAuthorizedWebhook(check, WEBHOOK_SOURCE_INFO[source].secretEnv)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }
  const challenge = url.searchParams.get("hub.challenge");
  if (challenge) return new Response(challenge, { status: 200, headers: { ...NO_STORE, "content-type": "text/plain" } });
  return Response.json(
    { ok: true, source, message: `Ready. Send ${WEBHOOK_SOURCE_INFO[source].label} events here with POST.` },
    { headers: NO_STORE },
  );
}

// ---------------------------------------------------------------------------
// Ingest and process
// ---------------------------------------------------------------------------

/**
 * Stores the raw payload (unique event key), then processes it. A repeat of an event that was processed (or is
 * being processed) changes nothing; a repeat of one that FAILED processes it again (every step is idempotent).
 */
export async function ingestWebhook(source: WebhookSource, payload: unknown, opts: { now?: Date } = {}): Promise<IngestOutcome> {
  const ctx = await loadIntegrationContext();
  const eventKey = eventKeyFor(source, payload, ctx);
  const [row] = await db
    .insert(webhookEvents)
    .values({ source, eventKey, payload: payload as object, receivedAt: opts.now ?? new Date() })
    .onConflictDoNothing({ target: webhookEvents.eventKey })
    .returning();
  if (row) return runEvent(row, ctx);

  const [existing] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventKey, eventKey)).limit(1);
  // a failed event, or one whose processing was interrupted (still pending well after it arrived), runs again
  if (existing && !existing.processedAt && (existing.error || isStuck(existing, opts.now ?? new Date()))) {
    return { ...(await runEvent(existing, ctx)), duplicate: true };
  }
  return {
    ok: true,
    duplicate: true,
    eventId: existing?.id ?? null,
    contactId: existing?.contactId ?? null,
    result: "Already received",
  };
}

/** Pending (no outcome yet) for longer than processing ever takes: the run was interrupted. */
function isStuck(ev: Pick<WebhookEventRow, "processedAt" | "error" | "receivedAt">, now: Date): boolean {
  return !ev.processedAt && !ev.error && now.getTime() - ev.receivedAt.getTime() > STUCK_EVENT_MS;
}

/**
 * Processes a stored event again (Settings > Integrations "Reprocess"). Admins only. An event that was processed
 * without error is not run twice, and one that is still being processed is left alone.
 */
export async function reprocessWebhookEvent(
  eventId: string,
  actor: { id: string; role: Role },
  opts: { now?: Date } = {},
): Promise<IngestOutcome> {
  if (!can(actor, "settings.manage")) throw new WebhookError("Only an admin can reprocess webhook events.");
  const [ev] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, eventId)).limit(1);
  if (!ev) throw new WebhookError("That webhook event no longer exists.");
  if (ev.processedAt && !ev.error) {
    return { ok: true, duplicate: true, eventId: ev.id, contactId: ev.contactId, result: "Already processed" };
  }
  if (!ev.processedAt && !ev.error && !isStuck(ev, opts.now ?? new Date())) {
    throw new WebhookError("This event is still being processed. Try again in a few minutes if it does not finish.");
  }
  const outcome = await runEvent(ev, await loadIntegrationContext());
  await audit({
    table: "webhook_events",
    rowId: ev.id,
    action: "reprocess",
    oldValue: { error: ev.error },
    newValue: { ok: outcome.ok, error: outcome.error ?? null, note: outcome.note ?? null },
    userId: actor.id,
  });
  return outcome;
}

async function runEvent(ev: WebhookEventRow, ctx: IntegrationContext): Promise<IngestOutcome> {
  try {
    const r = await processEvent(ev, ctx);
    await db
      .update(webhookEvents)
      .set({ processedAt: new Date(), error: r.note ?? null, contactId: r.contactId ?? ev.contactId })
      .where(eq(webhookEvents.id, ev.id));
    return {
      ok: true,
      duplicate: false,
      eventId: ev.id,
      contactId: r.contactId,
      result: r.summary,
      ...(r.note ? { note: r.note } : {}),
    };
  } catch (e) {
    const message = errorText(e);
    const contactId = e instanceof WebhookError ? e.contactId : null;
    await db
      .update(webhookEvents)
      .set({ processedAt: null, error: message, contactId: contactId ?? ev.contactId })
      .where(eq(webhookEvents.id, ev.id));
    return { ok: false, duplicate: false, eventId: ev.id, contactId: contactId ?? ev.contactId, error: message };
  }
}

function errorText(e: unknown): string {
  if (e instanceof WebhookError || e instanceof ContactError || e instanceof MoneyError) return e.message;
  console.error("[webhooks] processing failed", e);
  const msg = e instanceof Error ? e.message : String(e);
  return `Unexpected error: ${msg}`.slice(0, 500);
}

function processEvent(ev: WebhookEventRow, ctx: IntegrationContext): Promise<ProcessResult> {
  const source = ev.source as WebhookSource;
  switch (source) {
    case "tagmango":
      return processTagMango(ev.payload, ctx, ev.receivedAt);
    case "libromi":
    case "pabbly_whatsapp":
      return processWhatsApp(ev.payload, ctx, ev.receivedAt, ev.eventKey);
    case "pabbly_meta":
      return processLead("meta", ev.payload, ctx, ev.receivedAt, ev.eventKey);
    case "pabbly_website":
      return processLead("website", ev.payload, ctx, ev.receivedAt, ev.eventKey);
    default:
      throw new WebhookError(`Unknown webhook source "${ev.source}".`);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const EARLIEST = Date.UTC(2015, 0, 1);

/** A time from the payload when it is believable (not in the future, not before 2015), else the fallback. */
function believableTime(d: Date | null, fallback: Date): Date {
  if (!d || Number.isNaN(d.getTime()) || d.getTime() < EARLIEST) return fallback;
  const now = Date.now();
  return d.getTime() > now ? new Date(Math.min(fallback.getTime(), now)) : d;
}

function ratingsOnly(m: SelfRatingMatch): CaptureInput["selfRatings"] {
  const out: NonNullable<CaptureInput["selfRatings"]> = {};
  if (m.umerLevel !== undefined) out.umerLevel = m.umerLevel;
  if (m.aiLevel !== undefined) out.aiLevel = m.aiLevel;
  return out;
}

function answersNote(title: string, answers: Answer[]): string | null {
  if (!answers.length) return null;
  return [title, ...answers.map((a) => `${a.question}: ${a.answer}`)].join("\n").slice(0, 2000);
}

function knownDoor(ctx: IntegrationContext, key: string | null | undefined): string | null {
  return key && ctx.firstDoors.some((d) => d.key === key) ? key : null;
}

/** The product family for TagMango orders whose product is not in the catalogue (settings, else rung 1). */
function defaultFamily(ctx: IntegrationContext): string {
  const want = ctx.options.tagmangoDefaultFamily;
  if (ctx.families.some((f) => f.key === want)) return want;
  return (ctx.families.find((f) => f.rung === 1) ?? ctx.families[0])?.key ?? "workshop";
}

async function purchaseIdByReference(reference: string): Promise<string | null> {
  const [p] = await db.select({ id: purchases.id }).from(purchases).where(eq(purchases.reference, reference)).limit(1);
  return p?.id ?? null;
}

/**
 * Self-rating at the door for the first door. The first door is set once and never overwritten, so a self-reported
 * answer only fills a contact whose first door is still unknown ("other") and was never self-reported before.
 * Recorded in field_sources.first_door = "self", audited, recomputed. Returns true when it changed the contact.
 */
export async function fillSelfReportedFirstDoor(contactId: string, door: string, tx: Tx = db): Promise<boolean> {
  if (!door || door === "other") return false;
  return tx.transaction(async (t) => {
    const [c] = await t
      .select({ id: contacts.id, firstDoor: contacts.firstDoor, fieldSources: contacts.fieldSources, mergedIntoId: contacts.mergedIntoId })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1)
      .for("update");
    if (!c || c.mergedIntoId || c.firstDoor !== "other" || c.fieldSources?.first_door) return false;
    await t
      .update(contacts)
      .set({ firstDoor: door, fieldSources: { ...(c.fieldSources ?? {}), first_door: "self" }, updatedAt: new Date() })
      .where(eq(contacts.id, c.id));
    await audit({ table: "contacts", rowId: c.id, field: "firstDoor", oldValue: c.firstDoor, newValue: door, userId: null }, t);
    await recomputeContact(c.id, t);
    return true;
  });
}

// ---------------------------------------------------------------------------
// TagMango
// ---------------------------------------------------------------------------

function affiliateReferrer(o: TagMangoOrder, defaultCountry: string): CaptureInput["referrer"] {
  const a = o.affiliate;
  if (!a) return null;
  // the referrer's number is normalised here because TagMango may send its dial code separately
  const np = a.phone ? normalizePhone(a.phone, { dialCode: a.dialCode, defaultCountry }) : null;
  return { name: a.name, phone: np?.e164 ?? a.phone };
}

async function processTagMango(payload: unknown, ctx: IntegrationContext, receivedAt: Date): Promise<ProcessResult> {
  const o = extractTagMango(payload, ctx.paths.tagmango, { timeZone: ctx.options.timeZone });
  const reference = normalizeReference(o.orderId, "tagmango");
  if (!reference) {
    throw new WebhookError("No order id found in the payload. Add its path under tagmango.orderId in the field paths.");
  }
  if (!o.checkout) {
    return {
      contactId: null,
      summary: "Nothing to do",
      note: `${SKIP_PREFIX} order status "${o.status ?? "missing"}" is not a started, failed, completed or refunded order.`,
    };
  }
  if (o.checkout === "refunded") return processTagMangoRefund(o, reference, receivedAt);
  const self = matchSelfRatings(o.answers, ctx.selfRatings, ctx.firstDoors);
  const alreadyPaid = await purchaseIdByReference(reference);
  const defaultCountry = o.country ?? ctx.options.defaultCountry;
  const product = o.productName ?? "an order";

  let contactId: string | null = null;
  let phoneProblem: string | null = o.phone ? null : "No phone number";
  // phone is the identity key, but a paid order must not be lost: without a usable phone it goes to the contact
  // holding its email
  const byEmail = async () => (o.checkout === "completed" && o.email ? ((await findContactByEmail(o.email))?.id ?? null) : null);
  if (o.phone) {
    let cap;
    try {
      cap = await captureEnquiry({
        phone: o.phone,
        dialCode: o.dialCode,
        defaultCountry,
        name: o.name,
        email: o.email,
        channel: "tagmango_checkout",
        firstDoor: knownDoor(ctx, self.firstDoor),
        campaign: o.campaign,
        productInterest: o.productName,
        sourceRef: `tagmango:order:${reference}:${o.checkout}`,
        rawPayload: payload,
        receivedAt,
        // a paid order needs no follow-up; a started or failed one waits for the abandoned-checkout rule
        enquiryStatus: o.checkout === "completed" || alreadyPaid ? "handled" : o.checkout === "started" ? "checkout_started" : "checkout_failed",
        referrer: affiliateReferrer(o, defaultCountry),
        profile: { city: o.city },
        selfRatings: ratingsOnly(self),
        notes: answersNote("Checkout answers", o.answers),
      });
    } catch (e) {
      if (!(e instanceof InvalidPhoneError)) throw e;
      phoneProblem = e.message;
    }
    if (cap) {
      contactId = cap.contact.id;
      if (!cap.created && !cap.duplicateEnquiry && self.firstDoor) await fillSelfReportedFirstDoor(contactId, self.firstDoor);
    }
  }
  if (!contactId) contactId = await byEmail();
  if (!contactId) {
    throw new WebhookError(
      o.checkout === "completed" && o.email
        ? `${phoneProblem} in order ${reference}, and no contact has the email ${o.email}.`
        : o.phone
          ? `${phoneProblem} (order ${reference}).`
          : `No phone number in order ${reference}. Add its path under tagmango.phone in the field paths.`,
    );
  }

  if (o.checkout === "started") return { contactId, summary: `Checkout started for ${product} (order ${reference})` };
  if (o.checkout === "failed") return { contactId, summary: `Payment failed for ${product} (order ${reference})` };
  if (alreadyPaid) return { contactId, summary: `Order ${reference} was already recorded` };
  if (o.amount === null) {
    throw new WebhookError(`No amount found in order ${reference}. Add its path under tagmango.amount in the field paths.`, contactId);
  }
  if (o.amount <= 0) {
    return {
      contactId,
      summary: `Free order ${reference}`,
      note: `${SKIP_PREFIX} free order (amount 0): recorded as an enquiry, no purchase.`,
    };
  }

  const catalogue = await db
    .select({ id: products.id, name: products.name, family: products.family, externalIds: products.externalIds, active: products.active })
    .from(products);
  const hit = matchProduct(catalogue, { id: o.productId, name: o.productName });
  const productName = o.productName ?? hit?.name ?? "TagMango order";
  const currency = o.currency ?? ctx.options.defaultCurrency;
  try {
    await recordPurchase(
      {
        contactId,
        productId: hit?.id ?? null,
        productName,
        family: hit ? null : defaultFamily(ctx),
        amount: o.amount,
        currency,
        purchasedAt: believableTime(o.purchasedAt, receivedAt),
        mode: "tagmango",
        reference,
        source: "tagmango",
        verified: true,
        campaign: o.campaign ? (listKeyFor(ctx.campaigns, o.campaign) ?? o.campaign) : null,
        rawPayload: payload,
        notes: hit
          ? null
          : `Not in the catalogue: add "${o.productId ?? productName}" to a product's TagMango ids in Settings so it counts on the right rung.`,
      },
      null,
    );
  } catch (e) {
    if (e instanceof DuplicateReferenceError) return { contactId, summary: `Order ${reference} was already recorded` };
    throw new WebhookError(errorText(e), contactId);
  }
  return { contactId, summary: `Recorded order ${reference}: ${formatMoney(o.amount, currency)} for ${productName}` };
}

/**
 * A TagMango refund: a refund payment on the recorded order (spec "Purchases": a refund is a negative payment with a
 * reason, LTV drops by it). Idempotent on the refund reference "<order id>:refund[:<refund id>]". A refund for an
 * order we have not recorded fails, so it can be reprocessed once the order is in.
 */
async function processTagMangoRefund(o: TagMangoOrder, reference: string, receivedAt: Date): Promise<ProcessResult> {
  const [p] = await db
    .select({ id: purchases.id, contactId: purchases.contactId, currency: purchases.currency })
    .from(purchases)
    .where(eq(purchases.reference, reference))
    .limit(1);
  if (!p) {
    throw new WebhookError(`Order ${reference} is not recorded, so its refund cannot be applied yet. Reprocess this event once the order is in.`);
  }
  const refundRef = `${reference}:refund${o.refundId ? `:${keyPart(o.refundId)}` : ""}`;
  const [done] = await db.select({ id: payments.id }).from(payments).where(eq(payments.reference, refundRef)).limit(1);
  if (done) return { contactId: p.contactId, summary: `The refund on order ${reference} was already recorded` };
  const amount = o.refundAmount ?? o.amount;
  if (amount === null || amount <= 0) {
    throw new WebhookError(`No refund amount found for order ${reference}. Add its path under tagmango.refundAmount in the field paths.`, p.contactId);
  }
  const currency = o.currency ?? p.currency;
  try {
    await recordRefund(
      p.id,
      {
        amount,
        currency,
        reason: o.refundReason ? `Refunded on TagMango: ${o.refundReason}` : "Refunded on TagMango",
        reference: refundRef,
        refundedAt: believableTime(null, receivedAt),
        mode: "tagmango",
      },
      null,
    );
  } catch (e) {
    if (e instanceof DuplicateReferenceError) return { contactId: p.contactId, summary: `The refund on order ${reference} was already recorded` };
    throw new WebhookError(errorText(e), p.contactId);
  }
  return { contactId: p.contactId, summary: `Refund of ${formatMoney(amount, currency)} recorded on order ${reference}` };
}

// ---------------------------------------------------------------------------
// Libromi WhatsApp (direct or forwarded by Pabbly)
// ---------------------------------------------------------------------------

/** The contact an inbound message was already recorded on (as an enquiry or an interaction), if any. */
async function alreadyRecorded(ref: string): Promise<string | null> {
  const [e] = await db.select({ contactId: enquiries.contactId }).from(enquiries).where(eq(enquiries.sourceRef, ref)).limit(1);
  if (e) return e.contactId;
  const [i] = await db
    .select({ contactId: interactions.contactId })
    .from(interactions)
    .where(eq(interactions.externalRef, ref))
    .limit(1);
  return i?.contactId ?? null;
}

/** True when the contact's last inbound WhatsApp touch (enquiry or message) is within the conversation window. */
async function conversationOpen(contactId: string, at: Date, windowHours: number): Promise<boolean> {
  const hours = Number(windowHours);
  if (!Number.isFinite(hours) || hours <= 0) return false;
  const [lastEnquiry] = await db
    .select({ at: enquiries.receivedAt })
    .from(enquiries)
    .where(and(eq(enquiries.contactId, contactId), eq(enquiries.channel, "whatsapp_api"), lte(enquiries.receivedAt, at)))
    .orderBy(desc(enquiries.receivedAt))
    .limit(1);
  const [lastMessage] = await db
    .select({ at: interactions.occurredAt })
    .from(interactions)
    .where(
      and(
        eq(interactions.contactId, contactId),
        eq(interactions.type, "whatsapp"),
        eq(interactions.direction, "in"),
        lte(interactions.occurredAt, at),
      ),
    )
    .orderBy(desc(interactions.occurredAt))
    .limit(1);
  const last = Math.max(lastEnquiry?.at.getTime() ?? 0, lastMessage?.at.getTime() ?? 0);
  return last > 0 && at.getTime() - last < hours * 3600_000;
}

function messageSummary(m: WhatsAppMessage): string {
  if (m.button) {
    const tapped = m.button.title ?? m.button.id;
    return `Tapped "${tapped}"`;
  }
  if (m.text) return m.text.slice(0, 1000);
  return m.messageType ? `[${m.messageType}]` : "[message]";
}

async function processWhatsApp(payload: unknown, ctx: IntegrationContext, receivedAt: Date, eventKey: string): Promise<ProcessResult> {
  const m = extractWhatsApp(payload, ctx.paths.libromi, { timeZone: ctx.options.timeZone });
  if (m.kind === "status") return { contactId: null, summary: "Nothing to do", note: `${SKIP_PREFIX} a delivery status update, not a message.` };
  if (m.kind === "outgoing") return { contactId: null, summary: "Nothing to do", note: `${SKIP_PREFIX} a message sent from Edapt's number.` };
  if (m.kind === "unknown" && !m.phone && !m.text && !m.button) {
    // account or template notices: nothing a contact said
    return { contactId: null, summary: "Nothing to do", note: `${SKIP_PREFIX} not a WhatsApp message (no sender and no text).` };
  }
  if (!m.phone) throw new WebhookError("No sender phone number found. Add its path under libromi.phone in the field paths.");
  const np = normalizePhone(m.phone, { dialCode: m.dialCode, defaultCountry: ctx.options.defaultCountry });
  if (!np) throw new WebhookError(`"${m.phone}" is not a valid phone number.`);

  const ref = m.messageId ? `libromi:msg:${keyPart(m.messageId)}` : eventKey;
  const seen = await alreadyRecorded(ref);
  if (seen) return { contactId: seen, summary: "This message was already recorded" };

  const at = believableTime(m.timestamp, receivedAt);
  const reply = m.button ? matchButtonReply(m.button, ctx.selfRatings, ctx.firstDoors) : null;
  const selfDoor = reply?.field === "firstDoor" ? String(reply.value) : null;
  const selfLevels: NonNullable<CaptureInput["selfRatings"]> = {};
  if (reply && reply.field !== "firstDoor") selfLevels[reply.field] = Number(reply.value);
  const summary = messageSummary(m);

  const found = await lookupByPhone(np.e164);
  if (found && (await conversationOpen(found.contact.id, at, ctx.options.libromiWindowHours))) {
    const contactId = found.contact.id;
    await logInteraction(contactId, { type: "whatsapp", direction: "in", summary, occurredAt: at, externalRef: ref }, null);
    if (Object.keys(selfLevels).length) await applyRating(contactId, selfLevels, "self", null);
    if (selfDoor) await fillSelfReportedFirstDoor(contactId, selfDoor);
    return { contactId, summary: reply ? `Reply logged, self-rating from "${m.button?.title ?? m.button?.id}"` : "Reply logged on the contact" };
  }

  const cap = await captureEnquiry({
    phone: np.e164,
    name: m.name,
    channel: "whatsapp_api",
    // a click-to-WhatsApp ad is a Meta ad door; a tapped answer says it better
    firstDoor: knownDoor(ctx, selfDoor) ?? (m.referral?.fromAd ? knownDoor(ctx, "meta_ad") : null),
    campaign: m.referral?.campaign ?? null,
    sourceRef: ref,
    rawPayload: payload,
    receivedAt: at,
    notes: summary,
    selfRatings: selfLevels,
  });
  if (!cap.created && !cap.duplicateEnquiry && selfDoor) await fillSelfReportedFirstDoor(cap.contact.id, selfDoor);
  return {
    contactId: cap.contact.id,
    summary: cap.duplicateEnquiry ? "This message was already recorded" : cap.created ? "New chat: contact created" : "New conversation: enquiry added",
  };
}

// ---------------------------------------------------------------------------
// Pabbly: Meta lead forms and website forms
// ---------------------------------------------------------------------------

function leadNotes(l: PabblyLead): string | null {
  const head = [l.formName ? `Form: ${l.formName}` : null, l.adName ? `Ad: ${l.adName}` : null].filter(Boolean).join(" · ");
  const body = l.answers.map((a) => `${a.question}: ${a.answer}`);
  const text = [head || null, ...body].filter(Boolean).join("\n");
  return text ? text.slice(0, 2000) : null;
}

async function processLead(
  kind: "meta" | "website",
  payload: unknown,
  ctx: IntegrationContext,
  receivedAt: Date,
  eventKey: string,
): Promise<ProcessResult> {
  const l = extractPabblyLead(payload, ctx.paths.pabbly, { timeZone: ctx.options.timeZone });
  if (!l.phone) throw new WebhookError("No phone number in the lead. Map the phone field in the Pabbly webhook action.");
  const self = matchSelfRatings(l.answers, ctx.selfRatings, ctx.firstDoors);
  const prefix = kind === "meta" ? "meta:lead:" : "website:form:";
  const sourceRef = l.leadId ? `${prefix}${keyPart(l.leadId)}` : eventKey;
  // campaign as given (stored as its settings key when it matches a label); else the ad or form name when that
  // names a known campaign
  const campaign = l.campaign ?? listKeyFor(ctx.campaigns, l.adName) ?? listKeyFor(ctx.campaigns, l.formName);
  const cap = await captureEnquiry({
    phone: l.phone,
    dialCode: l.dialCode,
    defaultCountry: l.country ?? ctx.options.defaultCountry,
    name: l.name,
    email: l.email,
    channel: kind === "meta" ? "meta_lead_form" : "website_form",
    // the channel default (Meta ad / Search or website) applies when neither the payload nor an answer says
    firstDoor: knownDoor(ctx, listKeyFor(ctx.firstDoors, l.firstDoor)) ?? knownDoor(ctx, self.firstDoor),
    campaign,
    productInterest: l.productInterest ?? (kind === "website" ? l.formName : null),
    sourceRef,
    rawPayload: payload,
    receivedAt: believableTime(l.submittedAt, receivedAt),
    profile: { city: l.city, language: l.language, ...(l.consent === null ? {} : { consent: l.consent }) },
    selfRatings: ratingsOnly(self),
    notes: leadNotes(l),
  });
  if (!cap.created && !cap.duplicateEnquiry && self.firstDoor) await fillSelfReportedFirstDoor(cap.contact.id, self.firstDoor);
  const what = kind === "meta" ? "Meta lead" : "Website form";
  return {
    contactId: cap.contact.id,
    summary: cap.duplicateEnquiry ? `${what} was already recorded` : cap.created ? `${what}: contact created` : `${what}: enquiry added to an existing contact`,
  };
}

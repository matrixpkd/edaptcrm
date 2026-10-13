import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";
import { formEntriesToObject, parseWebhookText, readWebhookBody } from "@/lib/webhooks/body";
import { DEFAULT_SELF_RATING_CONFIG } from "@/lib/webhooks/config";
import {
  answerValue,
  classifyCheckoutStatus,
  extractAnswers,
  extractPabblyLead,
  extractTagMango,
  extractWhatsApp,
  matchButtonReply,
  matchProduct,
  matchSelfRatings,
  pathsFor,
  questionField,
  splitWebhookPayload,
  TAGMANGO_FIELDS,
  validateFieldPaths,
  validateSelfRatingConfig,
} from "@/lib/webhooks/extract";
import { explainPayload } from "@/lib/webhooks/explain";
import { asDate, asNumber, containsPhrase, getPath, stableStringify } from "@/lib/webhooks/paths";
import { webhookEventState } from "@/lib/webhooks/sources";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(__dirname, "../fixtures/webhooks", `${name}.json`), "utf8"));

const doors = DEFAULT_SETTINGS["lists.firstDoors"];
const cfg = DEFAULT_SELF_RATING_CONFIG;

describe("paths", () => {
  it("reads dot paths, indexes, literal dotted keys, loose keys and JSON strings", () => {
    const o = {
      a: { b: [{ c: 1 }, { c: 2 }] },
      "x.y": "literal",
      "Phone Number": "98470",
      nested: '{"inner": {"v": "ok"}}',
      list: [{ name: "first" }],
    };
    expect(getPath(o, "a.b[1].c")).toBe(2);
    expect(getPath(o, "a.b.1.c")).toBe(2);
    expect(getPath(o, "x.y")).toBe("literal");
    expect(getPath(o, "phone_number")).toBe("98470");
    expect(getPath(o, "nested.inner.v")).toBe("ok");
    expect(getPath(o, "list.name")).toBe("first");
    expect(getPath(o, "missing.path")).toBeUndefined();
    expect(getPath(o, "__proto__")).toBeUndefined();
  });

  it("parses amounts and dates the way payloads write them", () => {
    expect(asNumber("₹14,999.00")).toBe(14999);
    expect(asNumber("Rs.1499")).toBe(1499);
    expect(asNumber("INR 699")).toBe(699);
    expect(asNumber(249)).toBe(249);
    expect(asNumber("2 x 499")).toBeNull();
    expect(asNumber("free")).toBeNull();
    expect(asDate(1791849600)?.toISOString()).toBe("2026-10-13T00:00:00.000Z");
    expect(asDate("1791849600000")?.toISOString()).toBe("2026-10-13T00:00:00.000Z");
    expect(asDate("2026-10-13 08:15:00")?.toISOString()).toBe("2026-10-13T08:15:00.000Z");
    expect(asDate("not a date")).toBeNull();
  });

  it("matches whole-word phrases only and hashes payloads stably", () => {
    expect(containsPhrase("I saw an ad on Instagram", "ad")).toBe(true);
    expect(containsPhrase("Already a member", "ad")).toBe(false);
    expect(containsPhrase("Don't know him", "don't know")).toBe(true);
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(stableStringify({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });

  it("puts admin paths in front of the built-in candidates", () => {
    const paths = pathsFor(TAGMANGO_FIELDS.phone, ["buyer.whatsappNumber", "phone"]);
    expect(paths[0]).toBe("buyer.whatsappNumber");
    expect(paths.filter((p) => p === "phone")).toHaveLength(1);
  });
});

describe("classifyCheckoutStatus", () => {
  it.each([
    ["completed", "completed"],
    ["PAID", "completed"],
    ["payment_success", "completed"],
    ["order.completed", "completed"],
    ["initiated", "started"],
    ["checkout_started", "started"],
    ["pending", "started"],
    ["unpaid", "started"],
    ["failed", "failed"],
    ["payment.failed", "failed"],
    ["cancelled", "failed"],
    ["refunded", "refunded"],
    ["order.refund", "refunded"],
    ["refund_failed", null],
    ["not paid", "started"],
    ["payment_not_completed", "started"],
    ["PAYMENT_SUCCESS", "completed"],
    ["order.created", null],
    ["", null],
  ])("%s -> %s", (raw, want) => {
    expect(classifyCheckoutStatus(raw)).toBe(want);
  });
});

describe("extractTagMango", () => {
  it("reads a flat completed order with affiliate and custom fields", () => {
    const o = extractTagMango(fixture("tagmango-completed-flat"));
    expect(o).toMatchObject({
      orderId: "TM-ORD-1001",
      checkout: "completed",
      phone: "9847012345",
      dialCode: "91",
      name: "Ayesha Rahman",
      email: "Ayesha.Rahman@Example.com",
      amount: 999,
      currency: "INR",
      productName: "Claude Mastery Workshop",
      productId: "mango_cm_01",
      affiliate: { name: "Rafeeq K", phone: "9846098460", dialCode: "91" },
    });
    expect(o.purchasedAt?.toISOString()).toBe("2026-10-12T09:30:00.000Z");
    expect(o.answers).toHaveLength(3);
    expect(o.used.amount).toBe("amountPaid");
  });

  it("reads a nested order (data.order / data.fan / data.mango) with a numeric phone and AED", () => {
    const o = extractTagMango(fixture("tagmango-completed-nested"));
    expect(o).toMatchObject({
      orderId: "65f0c0ffee1234567890abcd",
      status: "paid",
      checkout: "completed",
      phone: "501234567",
      dialCode: "971",
      name: "Shameer P",
      amount: 249,
      currency: "AED",
      productName: "The AI Office Dubai",
      productId: "mango_office_dxb",
      affiliate: null,
    });
    expect(o.purchasedAt?.toISOString()).toBe("2026-10-13T00:00:00.000Z");
    expect(o.answers.map((a) => a.answer)).toEqual(["Instagram ad", "2"]);
  });

  it("reads a started checkout in snake_case with the customer nested", () => {
    const o = extractTagMango(fixture("tagmango-initiated"));
    expect(o).toMatchObject({
      orderId: "TM-ORD-2002",
      checkout: "started",
      phone: "+91 98470 22222",
      name: "VINOD kumar",
      city: "Kochi",
      amount: 14999,
      productName: "Applied AI Mastery",
      productId: "mango_aam",
      campaign: "Claude Mastery Meta ads",
    });
  });

  it("reads a failed payment and answers sent as [question, answer] pairs", () => {
    const o = extractTagMango(fixture("tagmango-failed"));
    expect(o).toMatchObject({ orderId: "TM-ORD-3003", status: "FAILED", checkout: "failed", phone: "9847033333", amount: 699 });
    const self = matchSelfRatings(o.answers, cfg, doors);
    expect(self).toMatchObject({ firstDoor: "referral", umerLevel: 0 });
  });

  it("lets an admin path override the candidates", () => {
    const payload = { order: { ref: "X-9" }, orderId: "WRONG", status: "completed", phone: "9847012345" };
    expect(extractTagMango(payload).orderId).toBe("WRONG");
    expect(extractTagMango(payload, { orderId: ["order.ref"] }).orderId).toBe("X-9");
  });

  it("takes the first status that classifies, so a generic event name does not hide it", () => {
    const o = extractTagMango({ id: "1", event: "order.created", orderStatus: "initiated" });
    expect(o.checkout).toBe("started");
    const u = extractTagMango({ id: "1", status: "shipped" });
    expect(u).toMatchObject({ checkout: null, status: "shipped" });
  });

  it("reads dial codes written as ISO letters as the country", () => {
    const o = extractTagMango({ id: "1", status: "paid", phone: "501234567", countryCode: "AE" });
    expect(o).toMatchObject({ dialCode: null, country: "AE" });
  });
});

describe("self-ratings at the door", () => {
  it("maps checkout questions by text, and answers by label, synonym or leading number", () => {
    const o = extractTagMango(fixture("tagmango-completed-flat"));
    const m = matchSelfRatings(o.answers, cfg, doors);
    expect(m).toMatchObject({ firstDoor: "youtube", umerLevel: 3 });
    expect(m.aiLevel).toBeUndefined();
    expect(m.matched).toHaveLength(2);

    const nested = matchSelfRatings(extractTagMango(fixture("tagmango-completed-nested")).answers, cfg, doors);
    expect(nested).toMatchObject({ firstDoor: "meta_ad", umerLevel: 2 });
  });

  it("checks 'does not know' before anything else mentioning knowing", () => {
    expect(answerValue("umerLevel", "I don't know him at all", cfg, doors)).toBe(0);
    expect(answerValue("umerLevel", "Met him personally at a keynote", cfg, doors)).toBe(5);
    expect(answerValue("umerLevel", "4 - read his book", cfg, doors)).toBe(4);
    expect(answerValue("umerLevel", "something else", cfg, doors)).toBeNull();
    expect(answerValue("aiLevel", "I build automations", cfg, doors)).toBe(5);
    expect(answerValue("firstDoor", "Search or website", cfg, doors)).toBe("search_website");
    expect(answerValue("firstDoor", "Nothing useful", cfg, doors)).toBeNull();
  });

  it("only uses questions the matchers recognise", () => {
    expect(questionField("How did you first hear about Edapt?", cfg)).toBe("firstDoor");
    expect(questionField("How well do you know Umer?", cfg)).toBe("umerLevel");
    expect(questionField("How often do you use AI?", cfg)).toBe("aiLevel");
    expect(questionField("Your profession", cfg)).toBeNull();
  });

  it("reads WhatsApp button replies: self-describing ids, configured titles, or nothing", () => {
    expect(matchButtonReply({ id: "umer:3", title: "Watch him regularly" }, cfg, doors)).toEqual({ field: "umerLevel", value: 3 });
    expect(matchButtonReply({ id: "door:meta-ad" }, cfg, doors)).toEqual({ field: "firstDoor", value: "meta_ad" });
    expect(matchButtonReply({ id: "ai_4" }, cfg, doors)).toEqual({ field: "aiLevel", value: 4 });
    expect(matchButtonReply({ id: "btn_17", title: "friend or family" }, cfg, doors)).toEqual({ field: "firstDoor", value: "referral" });
    expect(matchButtonReply({ id: "btn_18", title: "Tell me more" }, cfg, doors)).toBeNull();
    expect(matchButtonReply({ id: "umer:9" }, cfg, doors)).toBeNull();
  });
});

describe("extractAnswers", () => {
  it("accepts lists of {label, value}, Meta field_data, pairs and plain objects", () => {
    expect(extractAnswers([{ label: "City", value: "Kochi" }])).toEqual([{ question: "City", answer: "Kochi" }]);
    expect(extractAnswers([{ name: "interests", values: ["AI", "Sales"] }])).toEqual([{ question: "interests", answer: "AI, Sales" }]);
    expect(extractAnswers([["Q", "A"]])).toEqual([{ question: "Q", answer: "A" }]);
    expect(extractAnswers({ Q1: "A1", Q2: { answer: "A2" } })).toEqual([
      { question: "Q1", answer: "A1" },
      { question: "Q2", answer: "A2" },
    ]);
    expect(extractAnswers('[{"question":"Q","answer":"A"}]')).toEqual([{ question: "Q", answer: "A" }]);
    expect(extractAnswers("not json")).toEqual([]);
  });
});

describe("extractWhatsApp", () => {
  it("reads a Meta Cloud API envelope with a click-to-WhatsApp ad referral", () => {
    const m = extractWhatsApp(fixture("libromi-cloud-text"));
    expect(m).toMatchObject({
      kind: "message",
      messageId: "wamid.HBgMOTE5ODQ3MDU1NTU1FQIAEhgUM0E",
      phone: "919847055555",
      name: "Nisha Menon",
      text: "Hi, I want to know about the Claude workshop",
      button: null,
      referral: { campaign: "Claude Mastery Meta ads", adId: "120200000000001", sourceType: "ad", fromAd: true },
    });
    expect(m.timestamp?.toISOString()).toBe("2026-10-13T00:00:00.000Z");
  });

  it("reads an interactive button reply", () => {
    const m = extractWhatsApp(fixture("libromi-cloud-button"));
    expect(m).toMatchObject({ kind: "message", messageId: "wamid.BUTTON0001", button: { id: "umer:3", title: "Watch him regularly" } });
  });

  it("recognises delivery statuses and outgoing messages", () => {
    expect(extractWhatsApp(fixture("libromi-status")).kind).toBe("status");
    expect(extractWhatsApp({ event: "message_status", status: "delivered", messageId: "x", phone: "9847012345" }).kind).toBe("status");
    expect(extractWhatsApp({ direction: "outbound", phone: "9847012345", message: "Hi from Edapt" }).kind).toBe("outgoing");
    expect(extractWhatsApp({ fromMe: true, phone: "9847012345", message: "Hi" }).kind).toBe("outgoing");
    expect(extractWhatsApp({ hello: "world" }).kind).toBe("unknown");
  });

  it("reads a flat Libromi payload and the Pabbly-forwarded variant", () => {
    expect(extractWhatsApp(fixture("libromi-flat"))).toMatchObject({
      kind: "message",
      messageId: "lb_msg_9001",
      phone: "9847044444",
      name: "Arun Das",
      text: "Hello, is there a batch in November?",
      referral: { campaign: "Koduvally AI Literacy Mission", fromAd: false },
    });
    expect(extractWhatsApp(fixture("pabbly-whatsapp-forward"))).toMatchObject({
      kind: "message",
      messageId: "lb_msg_9100",
      phone: "+971 50 765 4321",
      button: { id: "door:youtube", title: "YouTube" },
    });
  });
});

describe("extractPabblyLead", () => {
  it("reads our contract, with consent and answers", () => {
    const l = extractPabblyLead(fixture("pabbly-meta-lead"));
    expect(l).toMatchObject({
      leadId: "1209876543210",
      phone: "98470 66666",
      dialCode: "91",
      name: "Sreejith V",
      campaign: "claude mastery meta ads",
      formName: "Claude Mastery Oct",
      adName: "Claude carousel 3",
      productInterest: "Claude Mastery Workshop",
      city: "Thrissur",
      consent: true,
    });
    expect(matchSelfRatings(l.answers, cfg, doors)).toMatchObject({ umerLevel: 2, aiLevel: 3 });
  });

  it("collects unknown top-level fields as answers and ignores form plumbing", () => {
    const l = extractPabblyLead(fixture("pabbly-website-form"));
    expect(l).toMatchObject({ leadId: null, phone: "+971 55 123 4567", name: "Meera Joseph", formName: "The AI Office call-back" });
    expect(l.answers).toEqual([
      { question: "Company", answer: "Joseph Trading LLC" },
      { question: "Best time to call", answer: "Evening" },
    ]);
  });

  it("finds the contact details inside Meta's raw field_data", () => {
    const l = extractPabblyLead(fixture("pabbly-meta-field-data"));
    expect(l).toMatchObject({ leadId: "777000111222", phone: "+919847077777", name: "Rahul R", city: "Kozhikode" });
    expect(l.submittedAt?.toISOString()).toBe("2026-10-12T18:20:00.000Z");
    expect(matchSelfRatings(l.answers, cfg, doors).firstDoor).toBe("mla_program");
  });
});

describe("matchProduct", () => {
  const products = [
    { id: "p1", name: "Claude Mastery Workshop", family: "workshop", externalIds: ["mango_cm_01"], active: true },
    { id: "p2", name: "Old workshop", family: "workshop", externalIds: ["Prompt Engineering*"], active: false },
    { id: "p3", name: "Applied AI Mastery", family: "applied_ai_mastery", externalIds: [], active: true },
  ];
  it("matches by TagMango id, then name, then an external id pattern", () => {
    expect(matchProduct(products, { id: "mango_cm_01", name: "Renamed" })?.id).toBe("p1");
    expect(matchProduct(products, { name: "applied ai mastery" })?.id).toBe("p3");
    expect(matchProduct(products, { name: "Prompt Engineering Workshop" })?.id).toBe("p2");
    expect(matchProduct(products, { id: "unknown", name: "Unknown" })).toBeNull();
  });
});

describe("settings validation", () => {
  it("accepts known sources and fields, rejects anything else with a clear message", () => {
    expect(validateFieldPaths({ tagmango: { phone: ["buyer.whatsapp", " phone "] } })).toEqual({
      ok: true,
      value: { tagmango: { phone: ["buyer.whatsapp", "phone"] }, libromi: {}, pabbly: {} },
    });
    expect(validateFieldPaths({ shopify: {} })).toMatchObject({ ok: false });
    expect(validateFieldPaths({ tagmango: { colour: ["x"] } })).toMatchObject({ ok: false });
    expect(validateFieldPaths({ tagmango: { constructor: ["x"] } })).toMatchObject({ ok: false });
    expect(validateFieldPaths([])).toMatchObject({ ok: false });
  });

  it("validates self-rating matchers against the first door list and the 0 to 5 scale", () => {
    expect(validateSelfRatingConfig(cfg, doors)).toEqual({ ok: true, value: cfg });
    expect(validateSelfRatingConfig({ buttons: [{ match: "X", field: "firstDoor", value: "tiktok" }] }, doors)).toMatchObject({ ok: false });
    expect(validateSelfRatingConfig({ answers: [{ field: "umerLevel", value: "7", match: ["x"] }] }, doors)).toMatchObject({ ok: false });
    expect(validateSelfRatingConfig({ questions: [{ field: "gutStars", match: ["x"] }] }, doors)).toMatchObject({ ok: false });
  });
});

describe("body parsing", () => {
  it("parses JSON, double-encoded JSON and form bodies", () => {
    expect(parseWebhookText('{"a":1}', "application/json")).toEqual({ ok: true, payload: { a: 1 } });
    expect(parseWebhookText(JSON.stringify('{"a":1}'), "application/json")).toEqual({ ok: true, payload: { a: 1 } });
    expect(parseWebhookText("phone=9847012345&answers%5BCity%5D=Kochi&tags=a&tags=b", "application/x-www-form-urlencoded")).toEqual({
      ok: true,
      payload: { phone: "9847012345", answers: { City: "Kochi" }, tags: ["a", "b"] },
    });
    // a form body sent without its content type
    expect(parseWebhookText("phone=9847012345&name=Ali", "text/plain")).toEqual({ ok: true, payload: { phone: "9847012345", name: "Ali" } });
  });

  it("rejects empty, malformed and non-object bodies", () => {
    expect(parseWebhookText("", "application/json")).toMatchObject({ ok: false, status: 400 });
    expect(parseWebhookText("{not json", "application/json")).toMatchObject({ ok: false, status: 400 });
    expect(parseWebhookText("42", "application/json")).toMatchObject({ ok: false, status: 400 });
  });

  it("unwraps a single JSON field and drops unsafe keys and NUL characters", () => {
    expect(formEntriesToObject([["payload", '{"phone":"1"}']])).toEqual({ phone: "1" });
    expect(formEntriesToObject([["__proto__[x]", "1"], ["ok", "1"]])).toEqual({ ok: "1" });
    expect(parseWebhookText('{"a":"x\\u0000y"}', "application/json")).toEqual({ ok: true, payload: { a: "xy" } });
  });

  it("reads multipart bodies and enforces the size cap", async () => {
    const fd = new FormData();
    fd.set("phone", "9847012345");
    fd.set("answers[Q]", "A");
    const r = await readWebhookBody(new Request("http://x/", { method: "POST", body: fd }));
    expect(r).toEqual({ ok: true, payload: { phone: "9847012345", answers: { Q: "A" } } });
    const big = await readWebhookBody(new Request("http://x/", { method: "POST", body: JSON.stringify({ a: "x".repeat(200) }) }), 100);
    expect(big).toMatchObject({ ok: false, status: 413 });
  });
});

describe("webhookEventState", () => {
  it("tells processed, skipped, failed and pending apart", () => {
    expect(webhookEventState({ processedAt: new Date(), error: null })).toBe("processed");
    expect(webhookEventState({ processedAt: new Date(), error: "Skipped: a delivery status update" })).toBe("skipped");
    expect(webhookEventState({ processedAt: null, error: "No phone" })).toBe("failed");
    expect(webhookEventState({ processedAt: null, error: null })).toBe("pending");
  });
});

describe("explainPayload", () => {
  const ctx = { paths: { tagmango: {}, libromi: {}, pabbly: {} }, selfRatings: cfg, firstDoors: doors };

  it("says what a TagMango order will do and where each value came from", () => {
    const ex = explainPayload("tagmango", fixture("tagmango-completed-flat"), ctx);
    expect(ex.verdict).toMatch(/^Completed order/);
    expect(ex.rows.find((r) => r.field === "amount")).toEqual({ field: "amount", label: "Amount paid", value: "999", path: "amountPaid" });
    expect(ex.rows.find((r) => r.field === "status")?.value).toBe("completed → completed");
    expect(ex.selfRatings).toEqual([
      'First door: YouTube (from "How did you first hear about Edapt?")',
      'Umer familiarity: 3 (from "How well do you know Umer?")',
    ]);
    const skipped = explainPayload("tagmango", { orderId: "1", status: "shipped" }, ctx);
    expect(skipped.verdict).toMatch(/skipped/);
    expect(skipped.rows.find((r) => r.field === "status")).toMatchObject({ value: "shipped → not handled", path: "status" });
    const refund = explainPayload("tagmango", { orderId: "1", status: "refunded", refundAmount: 499 }, ctx);
    expect(refund.verdict).toMatch(/^Refund/);
    expect(refund.rows.find((r) => r.field === "refundAmount")).toMatchObject({ value: "499", path: "refundAmount" });
  });

  it("explains WhatsApp statuses, button replies and Pabbly leads", () => {
    expect(explainPayload("libromi", fixture("libromi-status"), ctx).verdict).toMatch(/delivery status/);
    expect(explainPayload("libromi", fixture("libromi-cloud-button"), ctx).selfRatings).toEqual(['Umer familiarity: 3 (button "Watch him regularly")']);
    const lead = explainPayload("pabbly_website", { name: "No phone" }, ctx);
    expect(lead.verdict).toMatch(/No phone/);
  });
});

describe("review fixes", () => {
  it("reads date-times without a zone in the given time zone, never the server's", () => {
    expect(asDate("2026-10-13 08:15:00", "Asia/Kolkata")?.toISOString()).toBe("2026-10-13T02:45:00.000Z");
    expect(asDate("2026-10-13T08:15:00", "Asia/Kolkata")?.toISOString()).toBe("2026-10-13T02:45:00.000Z");
    expect(asDate("2026-10-13T08:15", "Asia/Dubai")?.toISOString()).toBe("2026-10-13T04:15:00.000Z");
    expect(asDate("2026-10-13T08:15:00.5")?.toISOString()).toBe("2026-10-13T08:15:00.500Z");
    // a time that says its zone is exact
    expect(asDate("2026-10-13T08:15:00Z", "Asia/Kolkata")?.toISOString()).toBe("2026-10-13T08:15:00.000Z");
    expect(asDate("2026-10-13T08:15:00+04:00", "Asia/Kolkata")?.toISOString()).toBe("2026-10-13T04:15:00.000Z");
    expect(asDate("2026-13-45 10:00:00", "Asia/Kolkata")).toBeNull();
    // an unknown zone falls back to UTC rather than failing
    expect(asDate("2026-10-13 08:15:00", "Mars/Olympus")?.toISOString()).toBe("2026-10-13T08:15:00.000Z");
    const o = extractTagMango(fixture("tagmango-initiated"), undefined, { timeZone: "Asia/Kolkata" });
    expect(o.purchasedAt?.toISOString()).toBe("2026-10-13T02:45:00.000Z");
  });

  it("a failed payment anywhere in the payload beats a generic success", () => {
    const o = extractTagMango({ status: "success", data: { orderId: "A1", status: "failed", phone: "9847012345", amount: 100 } });
    expect(o).toMatchObject({ checkout: "failed", status: "failed" });
    expect(o.used.status).toBe("data.status");
    // a consistent completed order is unchanged
    expect(extractTagMango({ id: "1", status: "completed", paymentStatus: "captured" }).checkout).toBe("completed");
  });

  it("reads refund events with their amount, id and reason", () => {
    const o = extractTagMango({ data: { orderId: "A1", status: "refunded", refund: { id: "rf_9", amount: "₹500", reason: "Duplicate payment" } } });
    expect(o).toMatchObject({ checkout: "refunded", refundAmount: 500, refundId: "rf_9", refundReason: "Duplicate payment" });
    expect(extractTagMango({ id: "1", status: "completed", reason: "x" })).toMatchObject({ refundAmount: null, refundReason: null });
  });

  it("splits a delivery into its events", () => {
    const single = fixture("libromi-cloud-text");
    expect(splitWebhookPayload("libromi", single)[0]).toBe(single);
    expect(splitWebhookPayload("tagmango", [{ id: 1 }, { id: 2 }, "junk"])).toEqual([{ id: 1 }, { id: 2 }]);
    expect(splitWebhookPayload("tagmango", { id: 1 })).toEqual([{ id: 1 }]);

    const env = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "e1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "1" },
                contacts: [{ wa_id: "911", profile: { name: "One" } }, { wa_id: "912", profile: { name: "Two" } }],
                messages: [{ from: "911", id: "m1" }, { from: "912", id: "m2" }],
                statuses: [{ id: "s1", status: "read" }],
              },
            },
          ],
        },
      ],
    };
    const parts = splitWebhookPayload("libromi", env);
    expect(parts).toHaveLength(3);
    const two = extractWhatsApp(parts[1]);
    expect(two).toMatchObject({ kind: "message", messageId: "m2", phone: "912", name: "Two" });
    expect(extractWhatsApp(parts[2]).kind).toBe("status");
    // only WhatsApp envelopes are split by message
    expect(splitWebhookPayload("pabbly_meta", env)).toHaveLength(1);
  });

  it("recognises 'AI level' questions", () => {
    expect(questionField("What is your AI level?", cfg)).toBe("aiLevel");
  });
});

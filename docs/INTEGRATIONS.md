# Integrations: automatic capture

Four channels flow into the CRM without anyone typing (spec "Capture: every way in"):

| Pipe | URL | Secret | What it creates |
| --- | --- | --- | --- |
| TagMango orders | `/api/webhooks/tagmango` | `TAGMANGO_WEBHOOK_SECRET` | Completed order: contact + verified purchase + referral + self-ratings. Started or failed checkout: a checkout enquiry that becomes a call task after an hour unless the order is paid. |
| Libromi WhatsApp | `/api/webhooks/libromi` | `LIBROMI_WEBHOOK_SECRET` | First message of a conversation: a WhatsApp API enquiry. Later messages in the same conversation: an inbound WhatsApp interaction on the contact. One-tap answers: self-ratings. |
| WhatsApp via Pabbly | `/api/webhooks/pabbly/whatsapp` | `PABBLY_WEBHOOK_SECRET` | The same as Libromi, for messages a Pabbly Connect workflow forwards. |
| Meta lead forms via Pabbly | `/api/webhooks/pabbly/meta-lead` | `PABBLY_WEBHOOK_SECRET` | A Meta lead form enquiry (first door Meta ad), with campaign and form answers. |
| Website forms via Pabbly | `/api/webhooks/pabbly/website-form` | `PABBLY_WEBHOOK_SECRET` | A website form enquiry (first door Search or website), such as an AI Office call-back. |

**Settings > Integrations** (admins) shows every URL ready to copy, the latest 50 events with their raw payloads, what
the CRM read from each one, and a **Reprocess** button for failed ones. Code: `src/lib/webhooks/`, routes in
`src/app/api/webhooks/`.

> TagMango's and Libromi's payload documentation could not be checked when this was built, so the readers are
> tolerant: each value is looked up under many likely field names, and you can point any value at the right field
> without a code change (see [Field paths](#field-paths)). Send a test event after setting up each tool and check
> what the CRM read.

## 1. Secrets

Each pipe checks a shared secret. Generate one per tool and set it in the server environment (Vercel project
settings, and `.env.local` for development):

```bash
openssl rand -hex 24   # run three times: TagMango, Libromi, Pabbly
```

```
TAGMANGO_WEBHOOK_SECRET=...
LIBROMI_WEBHOOK_SECRET=...
PABBLY_WEBHOOK_SECRET=...
```

The secret can travel three ways; use whichever the tool supports:

- in the URL: `https://crm.edapt.in/api/webhooks/tagmango?token=<secret>` (what Settings > Integrations copies),
- a header `x-webhook-secret: <secret>`,
- a header `Authorization: Bearer <secret>`.

In production a pipe whose secret is not set refuses every call. In development it is open, so you can test with
curl. To rotate a secret, change it on the server, redeploy, and paste the new URL into the tool.

## 2. How a delivery is handled

1. **Auth**: a wrong or missing secret gets `401` and nothing is stored.
2. **Body**: JSON (any content type), `application/x-www-form-urlencoded` or `multipart/form-data`. Form keys with
   brackets expand (`answers[City]=Kochi` becomes `{"answers": {"City": "Kochi"}}`), and a single form field holding
   JSON (`payload={...}`) is unwrapped. A body that is not JSON or form data gets `400` and nothing is stored.
   Bodies over 1 MB get `413`. A body holding several events (a JSON list of orders or leads, or a WhatsApp Cloud
   API envelope with several messages) is split: each event is stored, keyed and processed on its own, and the
   answer lists every event's outcome under `events` (at most 200 events per delivery).
3. **Stored first**: the raw payload goes into `webhook_events` with a unique event key, before any processing:
   - TagMango: `tagmango:order:<order id>:<completed|started|failed|refunded>` (a refund with its own id adds
     `:<refund id>`, so part refunds of one order are kept apart)
   - WhatsApp: `libromi:msg:<message id>` (the same message through Libromi and Pabbly is recorded once)
   - Meta lead: `meta:lead:<lead id>`; website form: `website:form:<submission id>`
   - no id in the payload: the source plus a hash of the payload.
4. **Processed**: the domain services do the work (`captureEnquiry`, `recordPurchase`, `logInteraction`,
   `applyRating`), then the event is marked processed, skipped (with a note) or failed (with the error).
5. **Answer**: always `200` once the payload is stored, so the tool does not retry forever:

   ```json
   { "ok": true, "duplicate": false, "eventId": "…", "contactId": "…", "result": "Recorded order TM-1001: ₹999.00 for Claude Mastery Workshop" }
   { "ok": true, "duplicate": true, "eventId": "…", "result": "Already received" }
   { "ok": true, "duplicate": false, "eventId": "…", "note": "Skipped: a delivery status update, not a message." }
   { "ok": false, "duplicate": false, "eventId": "…", "error": "No amount found in order TM-4004. Add its path under tagmango.amount in the field paths." }
   ```

**Nothing is counted twice.** A repeated delivery changes nothing: the event key, the enquiry `source_ref`, the
purchase reference (the TagMango order id) and the interaction `external_ref` are all unique. A repeated delivery of
an event that **failed** is processed again, which is also how Reprocess works; every step is safe to repeat. The
stored payload is what runs again. An event whose processing was interrupted (still pending 5 minutes after it
arrived, for example after a server restart) is also run again by a redelivery or by Reprocess; a younger pending
event is left alone because it is still being processed.

`GET` on any webhook URL with the secret answers `{"ok": true, "message": "Ready…"}`, and answers the Meta-style
handshake (`hub.challenge` with `hub.verify_token=<secret>`) for providers that verify URLs that way.

## 3. TagMango

### Set up

1. In TagMango, open **Automations > Platform Integrations** and generate an **API key** if your account asks for
   one to register webhooks.
2. Register a webhook for **order events** (TagMango's "Order created (all)" event reports checkouts that start,
   fail and complete, see [TagMango webhooks](https://docs.tagmango.com/docs/webhooks/order-created-all)). Paste the
   **TagMango orders** URL from Settings > Integrations. If the dashboard has no webhook form, register the URL with
   TagMango's webhook API using the key from step 1, as their docs describe.
3. Place a test order (a ₹1 test product, or TagMango's test event) and open Settings > Integrations > Recent
   events > **View**. Check that order id, status, phone, amount and product were read. Fix anything missing with a
   [field path](#field-paths), then **Reprocess**.

### What each order does

| Status in the payload | Result |
| --- | --- |
| completed, paid, success, captured | Contact found or created (phone first, then email), enquiry on channel *TagMango checkout*, then a **verified purchase** with mode TagMango, the order id as its reference, the payload's currency and order time. LTV, scores and stage recompute. A checkout started earlier for the same contact is marked handled (paid within the hour) or recovered (after the abandoned-checkout alert), and its alert closes. |
| initiated, started, pending | Enquiry with status `checkout_started` and the product as its interest. After `thresholds.abandonedCheckoutMinutes` (60 by default) with no paid order, the alerts engine turns it into a call task at the top of Today. |
| failed, cancelled, declined | The same, with status `checkout_failed`. |
| not paid, payment not completed | A negated "paid" is never a purchase: treated as a started checkout. |
| refunded, refund, chargeback | A **refund payment** on the recorded order (mode TagMango, reference `<order id>:refund[:<refund id>]`, the refund reason kept), so LTV drops by it. The amount is the payload's refund amount, else the order amount. A refund for an order that is not recorded yet fails; Reprocess it once the order is in. |
| anything else (created, shipped…) | Stored and skipped with a note. |

When two status fields of one payload disagree, a failure wins over a success (an envelope such as
`{"status": "success", "data": {"status": "failed"}}` is a failed payment), so a purchase is only recorded for money
that was really received.

- **Phone**: TagMango sends the dial code separately; it is joined back on (`dialCode` 91 + `9847012345` =
  `+919847012345`). A paid order with no phone is attached to the contact that has its email; with neither, it fails.
- **Referrals**: the affiliate's name and phone (when the order came through an affiliate link) become the buyer's
  referrer. A referrer phone nobody has yet becomes a new contact. The buyer's first door becomes Referral unless they
  said otherwise.
- **Product**: matched to the catalogue by the TagMango product (mango) id in the product's *external ids*, else by
  name; an external id may be a pattern such as `Claude Mastery*`. An order for a product that is not in the catalogue
  is still recorded, in the family set under Options (Workshops by default), with a note on the purchase saying which
  id to add.
- **Currency**: from the payload, else the default under Options. A currency with no INR rate in Settings > Currency
  fails the event; add the rate and Reprocess.
- **Free orders** (amount 0) record the enquiry and no purchase.
- **Order time**: a time with a zone (`2026-10-13T09:30:00Z`, `+05:30`) or an epoch number is exact. A time written
  without a zone (`2026-10-13 15:00:00`) is read in the time zone under Options (India by default), never in the
  server's zone.

### Self-ratings at checkout

Add two optional **custom checkout fields** to your TagMango products:

- *How did you first hear about Edapt?* (YouTube, Instagram or Facebook ad, Friend or family, Workshop or webinar,
  MLA program, Google or website, Other)
- *How well do you know Umer?* (Don't know him, Heard the name, Watched a few videos, Watch him regularly, Follow him
  closely, Met him personally)

The answers fill the first door (for a new contact, or one whose door is still "Other") and Umer familiarity. A
self-rating never overwrites a salesperson's rating. Questions and answers are matched by the phrases under
[Self-rating matchers](#self-rating-matchers), so rewording a question only needs a settings change.

## 4. Libromi (WhatsApp API)

### Set up

1. In Libromi, open the webhook settings of the WhatsApp API number and paste the **Libromi WhatsApp** URL. Subscribe
   to **incoming messages**. If Libromi asks for a verify token, use the Libromi secret.
2. Send a WhatsApp message to the API number from a test phone and check Recent events.
3. Point every ad and website button at the API number ("Route every new enquiry to the Libromi number").

Libromi payloads in Meta's WhatsApp Cloud API shape (`entry[0].changes[0].value.messages[0]`) and flat payloads
(`{messageId, mobile, name, message}`) are both read.

### What each message does

- **First message**, or the first after `Options > WhatsApp conversation window` hours of silence (24 by default):
  a *WhatsApp API* enquiry with the message as its note. A new number becomes a new lead, assigned by round robin.
- **Later messages** in the same conversation: an inbound WhatsApp interaction on the contact's timeline, logged by
  the system (it does not count as a salesperson's touch).
- **Click-to-WhatsApp ads**: the ad headline becomes the campaign (matched to the campaign list by label), and a new
  contact's first door is Meta ad.
- **Delivery statuses and messages Edapt sent** are stored and skipped.

### Self-ratings in the welcome message

Add the two questions to the welcome message as **quick-reply buttons**. Give each button an id that says what it
means, and no configuration is needed:

| Button id | Sets |
| --- | --- |
| `door:youtube`, `door:meta_ad`, `door:referral`, `door:workshop_webinar`, `door:mla_program`, `door:search_website` | First door (for a new contact, or one whose door is still "Other") |
| `umer:0` … `umer:5` | Umer familiarity |
| `ai:0` … `ai:5` | AI knowledge |

If the buttons cannot carry ids, their titles are matched against the `buttons` list in the self-rating matchers
("YouTube", "Watched a few videos", …).

## 5. Pabbly Connect (Meta lead forms, website forms, WhatsApp forwarding)

Pabbly maps each tool's fields into one JSON contract that we control, so these pipes do not depend on the source's
field names.

### The contract

| Key | Required | Notes |
| --- | --- | --- |
| `phone` | yes | Any format; `+971…` or a local number |
| `dial_code` | | When the phone has no country code (`91`, `971`) |
| `name` | | Or `first_name` + `last_name` |
| `email` | | |
| `campaign` | | Matched to Settings > lists > campaigns by label, else stored as given |
| `form_name`, `ad_name` | | Kept on the enquiry; used as the campaign when they name a known campaign |
| `lead_id` | | Meta lead id or form submission id: makes retries safe |
| `product_interest` | | For website forms, the form name is used when missing |
| `city` | | |
| `answers` | | `{"question": "answer"}`; matched for self-ratings, all kept on the enquiry |
| `consent` | | `true`/`false`, `yes`/`no` |
| `first_door` | | A first door key or label, when the form knows it |

Any other field you send is kept as a form answer on the enquiry. Meta's raw `field_data` list
(`[{"name": "phone_number", "values": [...]}]`) is also understood.

### Meta lead forms

1. Create a workflow: trigger **Facebook Lead Ads > New Lead** (pick the page and form).
2. Action: **API by Pabbly** (or **Webhook**) > POST, payload type **JSON**, URL = the **Meta lead forms via Pabbly**
   URL. Map: `phone` ← Phone number, `name` ← Full name, `email` ← Email, `lead_id` ← Lead id, `form_name` ← Form name,
   `ad_name` ← Ad name, `campaign` ← Campaign name, `city` ← City, and each custom question into `answers`.
3. Submit a test lead with Meta's [Lead Ads Testing Tool](https://developers.facebook.com/tools/lead-ads-testing) and
   check Recent events.

### Website forms

1. Trigger: the form tool's Pabbly trigger (or **Webhook by Pabbly** if the site posts to Pabbly).
2. Action: POST JSON to the **Website forms via Pabbly** URL with the same contract (`form_name` = which form, such
   as "The AI Office call-back"). A site's own server-side form handler can also post form data straight to this
   URL (form-encoded bodies work). Never put the URL with its token into browser code or a page's HTML: anyone who
   reads it can send leads in.

### WhatsApp via Pabbly

If Libromi talks to Pabbly rather than to the CRM, add a workflow: trigger **Libromi > New message**, action POST to
the **WhatsApp via Pabbly** URL with `phone`, `name`, `message`, `message_id`, and, for button replies, `button_id`
and `button_text`.

## 6. Verify with a test event

Every pipe can be tried with curl (replace the host and secret):

```bash
# TagMango: a completed order
curl -s -X POST "https://crm.edapt.in/api/webhooks/tagmango?token=$TAGMANGO_WEBHOOK_SECRET" \
  -H 'content-type: application/json' \
  -d '{"orderId":"TEST-1","orderStatus":"completed","name":"Test Buyer","phone":"9847000001","dialCode":"91",
       "amountPaid":999,"currency":"INR","mangoName":"Claude Mastery Workshop",
       "customFields":[{"question":"How well do you know Umer?","answer":"Watched a few videos"}]}'

# Libromi: an inbound message
curl -s -X POST "https://crm.edapt.in/api/webhooks/libromi?token=$LIBROMI_WEBHOOK_SECRET" \
  -H 'content-type: application/json' \
  -d '{"messageId":"test-msg-1","mobile":"9847000002","name":"Test Chat","message":"Hi, tell me about the workshop"}'

# Pabbly: a Meta lead
curl -s -X POST "https://crm.edapt.in/api/webhooks/pabbly/meta-lead?token=$PABBLY_WEBHOOK_SECRET" \
  -H 'content-type: application/json' \
  -d '{"lead_id":"test-lead-1","phone":"9847000003","name":"Test Lead","campaign":"Claude Mastery Meta ads",
       "answers":{"How did you first hear about Edapt?":"YouTube"}}'

# A website form, form-encoded
curl -s -X POST "https://crm.edapt.in/api/webhooks/pabbly/website-form?token=$PABBLY_WEBHOOK_SECRET" \
  --data-urlencode 'phone=+971501230004' --data-urlencode 'name=Test Form' \
  --data-urlencode 'form_name=The AI Office call-back'
```

Then open Settings > Integrations > Recent events: each test shows as Processed with a link to the contact. Sending
the same command again answers `"duplicate": true`. Merge or delete test contacts afterwards (test purchases count
toward LTV until cancelled).

## 7. Field paths

When a tool sends a value under a name the CRM does not expect, the event fails (or a value is "Not found" in the
event view). Fix it without code:

1. Open the event (Recent events > **View**). *What we read* lists every value with the path it came from, and the
   raw payload shows where the missing value really is.
2. Under **Field paths**, add the path for that source and field, then **Save**:

   ```json
   {
     "tagmango": { "phone": ["buyer.whatsappNumber"], "amount": ["charges.net"], "orderId": ["order.ref"] },
     "libromi": { "phone": ["sender.msisdn"] },
     "pabbly": { "productInterest": ["course_selected"] }
   }
   ```

   Paths use dots and indexes: `data.customer.phone`, `items[0].name`, `items.0.name`. Keys match case- and
   punctuation-insensitively (`phone_number` finds `Phone Number`). Your paths are tried before the built-in ones,
   which are listed under *Built-in paths* on the same screen.
3. **Reprocess** the failed events.

Fields — TagMango: `orderId, status, phone, dialCode, name, firstName, lastName, email, amount, currency,
productName, productId, purchasedAt, affiliateName, affiliatePhone, affiliateDialCode, campaign, city, refundAmount,
refundId, refundReason, customFields`.
Libromi: `messageId, phone, dialCode, name, text, messageType, event, deliveryStatus, direction, timestamp, buttonId,
buttonTitle, campaign, adId, referralSource, ctwaClid`. Pabbly: `leadId, phone, dialCode, name, firstName, lastName,
email, campaign, formName, adName, productInterest, city, language, firstDoor, consent, submittedAt, answers`.

The settings key is `integrations.fieldPaths`.

## 8. Self-rating matchers

Settings key `integrations.selfRatings`, edited under **Self-ratings at the door**:

```json
{
  "questions": [{ "field": "umerLevel", "match": ["know umer", "familiar with umer"] }],
  "answers": [{ "field": "umerLevel", "value": "2", "match": ["watched a few", "a few videos"] }],
  "buttons": [{ "match": "Watched a few videos", "field": "umerLevel", "value": "2" }]
}
```

- `field` is `firstDoor`, `umerLevel` or `aiLevel`. `value` is a first door key, or a level `0`–`5`.
- `questions` decide which field an answer fills: the question must contain one of the phrases (whole words, any case).
- `answers` are checked in order and the first match wins (so "don't know" is listed before anything mentioning
  "know"). Answers that start with a number ("3", "3 - watches regularly") are read as that level, and a first door
  answer that equals a first door label ("YouTube") needs no entry.
- `buttons` match a WhatsApp button's id or title exactly (any case).
- **Restore defaults** brings back the shipped matchers.

## 9. Options

Settings key `integrations.options`: the default country for numbers without a code (IN), the currency of a TagMango
order that does not say (INR), the product family for orders whose product is not in the catalogue (Workshops), the
WhatsApp conversation window in hours (24), and the time zone of payload times written without a zone
(Asia/Kolkata).

## 10. Troubleshooting

| You see | Do this |
| --- | --- |
| The tool reports 401 | The token in the tool's URL does not match the server secret. Copy the URL again from Settings > Integrations. |
| The tool reports 400 | It sent something that is neither JSON nor form data. Check the tool's payload type (JSON). |
| Failed: "No order id / No phone / No amount found" | Open the event, find the value in the raw payload, add a field path, Reprocess. |
| Failed: "No INR rate is set for …" | Add the currency's rate in Settings > Currency, then Reprocess. |
| Purchase note "Not in the catalogue" | Add the TagMango product id (shown in the note) to the product's external ids. Past purchases keep the family they were recorded with. |
| Skipped: status "…" is not a started, failed, completed or refunded order | Expected for other order events (created, shipped). If it is a real payment status, map `status` to the right field. |
| Failed: "Order … is not recorded, so its refund cannot be applied yet" | The refund arrived before (or without) its order. Reprocess the order's event if it failed, then Reprocess the refund. |
| An event stays "In progress" | Processing was interrupted. After 5 minutes it can be reprocessed, and a redelivery runs it again. |
| An abandoned-checkout task for someone who paid | The paid order did not arrive or failed: check Recent events for a failed TagMango event and Reprocess it. |

`webhook_events` keeps every payload as it arrived (stored as `jsonb`, so key order is not preserved). Nothing prunes
it yet.

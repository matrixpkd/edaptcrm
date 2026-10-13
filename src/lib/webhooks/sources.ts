/**
 * The capture pipes and their webhook routes. PURE: the Settings > Integrations screen reads labels and paths
 * from here; the route handlers and the event log use the source keys.
 */
import type { FieldPathSource } from "./config";

export const WEBHOOK_SOURCES = ["tagmango", "libromi", "pabbly_whatsapp", "pabbly_meta", "pabbly_website"] as const;
export type WebhookSource = (typeof WEBHOOK_SOURCES)[number];

export type WebhookSourceInfo = {
  label: string;
  /** what the pipe brings in, for the settings screen */
  description: string;
  /** route path, relative to the app URL */
  path: string;
  /** environment variable holding the shared secret (?token=, x-webhook-secret or Bearer) */
  secretEnv: "TAGMANGO_WEBHOOK_SECRET" | "LIBROMI_WEBHOOK_SECRET" | "PABBLY_WEBHOOK_SECRET";
  /** whose field paths read the payload */
  fieldPaths: FieldPathSource;
  /** where to paste the URL */
  pasteInto: string;
};

export const WEBHOOK_SOURCE_INFO: Record<WebhookSource, WebhookSourceInfo> = {
  tagmango: {
    label: "TagMango orders",
    description: "Completed orders become verified purchases; started and failed checkouts become call tasks after an hour.",
    path: "/api/webhooks/tagmango",
    secretEnv: "TAGMANGO_WEBHOOK_SECRET",
    fieldPaths: "tagmango",
    pasteInto: "TagMango > Automations > Webhooks (order events)",
  },
  libromi: {
    label: "Libromi WhatsApp",
    description: "A new chat on the API number becomes an enquiry; replies in the same conversation are logged on the contact.",
    path: "/api/webhooks/libromi",
    secretEnv: "LIBROMI_WEBHOOK_SECRET",
    fieldPaths: "libromi",
    pasteInto: "Libromi > Settings > Webhook URL (incoming messages)",
  },
  pabbly_whatsapp: {
    label: "WhatsApp via Pabbly",
    description: "The same as Libromi, for messages forwarded by a Pabbly Connect workflow.",
    path: "/api/webhooks/pabbly/whatsapp",
    secretEnv: "PABBLY_WEBHOOK_SECRET",
    fieldPaths: "libromi",
    pasteInto: "Pabbly Connect > Libromi trigger > Webhook action",
  },
  pabbly_meta: {
    label: "Meta lead forms via Pabbly",
    description: "Ad leads with their form answers. First door defaults to Meta ad.",
    path: "/api/webhooks/pabbly/meta-lead",
    secretEnv: "PABBLY_WEBHOOK_SECRET",
    fieldPaths: "pabbly",
    pasteInto: "Pabbly Connect > Facebook Lead Ads trigger > Webhook action",
  },
  pabbly_website: {
    label: "Website forms via Pabbly",
    description: "Call-back requests from the website, such as The AI Office. First door defaults to Search or website.",
    path: "/api/webhooks/pabbly/website-form",
    secretEnv: "PABBLY_WEBHOOK_SECRET",
    fieldPaths: "pabbly",
    pasteInto: "Pabbly Connect > form trigger > Webhook action",
  },
};

export function isWebhookSource(v: unknown): v is WebhookSource {
  return typeof v === "string" && (WEBHOOK_SOURCES as readonly string[]).includes(v);
}

export function webhookSourceLabel(source: string): string {
  return isWebhookSource(source) ? WEBHOOK_SOURCE_INFO[source].label : source;
}

/** "Skipped: ..." notes are stored in webhook_events.error but are not failures. */
export const SKIP_PREFIX = "Skipped:";

export type WebhookEventState = "processed" | "skipped" | "failed" | "pending";

/** processed: done; skipped: nothing to do (a note says why); failed: an error, can be reprocessed; pending: in flight. */
export function webhookEventState(e: { processedAt: Date | null; error: string | null }): WebhookEventState {
  if (e.error && e.error.startsWith(SKIP_PREFIX)) return "skipped";
  if (e.error) return "failed";
  return e.processedAt ? "processed" : "pending";
}

/** A pending event older than this was interrupted mid-way: a redelivery or Reprocess runs it again. */
export const STUCK_EVENT_MS = 5 * 60_000;

import { handleWebhookGet, handleWebhookPost } from "@/lib/webhooks/handlers";

/**
 * TagMango order webhook (spec "Capture: every way in"). Completed orders become a verified purchase on the buyer's
 * contact; started and failed checkouts become checkout enquiries that the abandoned-checkout rule turns into a
 * call task when no paid order follows within the hour. Secret: TAGMANGO_WEBHOOK_SECRET. See docs/INTEGRATIONS.md.
 */
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleWebhookPost(req, "tagmango");
}

export function GET(req: Request): Promise<Response> {
  return handleWebhookGet(req, "tagmango");
}

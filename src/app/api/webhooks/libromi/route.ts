import { handleWebhookGet, handleWebhookPost } from "@/lib/webhooks/handlers";

/**
 * Libromi WhatsApp API webhook: a new chat (or a message after the conversation window) becomes a WhatsApp API
 * enquiry; messages inside the window are logged as inbound WhatsApp interactions; one-tap answers to the welcome
 * questions become self-ratings. Secret: LIBROMI_WEBHOOK_SECRET. See docs/INTEGRATIONS.md.
 */
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleWebhookPost(req, "libromi");
}

export function GET(req: Request): Promise<Response> {
  return handleWebhookGet(req, "libromi");
}

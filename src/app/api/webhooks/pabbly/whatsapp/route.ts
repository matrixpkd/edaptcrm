import { handleWebhookGet, handleWebhookPost } from "@/lib/webhooks/handlers";

/**
 * Libromi WhatsApp messages forwarded by a Pabbly Connect workflow. Processed exactly like /api/webhooks/libromi
 * (the same message through both routes is recorded once). Secret: PABBLY_WEBHOOK_SECRET.
 */
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleWebhookPost(req, "pabbly_whatsapp");
}

export function GET(req: Request): Promise<Response> {
  return handleWebhookGet(req, "pabbly_whatsapp");
}

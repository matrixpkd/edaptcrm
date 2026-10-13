import { handleWebhookGet, handleWebhookPost } from "@/lib/webhooks/handlers";

/**
 * Website forms (call-back requests such as The AI Office) forwarded by Pabbly Connect, in the same JSON contract
 * as the Meta lead route. Channel "Website form", first door "Search or website" unless an answer says otherwise.
 * Secret: PABBLY_WEBHOOK_SECRET.
 */
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleWebhookPost(req, "pabbly_website");
}

export function GET(req: Request): Promise<Response> {
  return handleWebhookGet(req, "pabbly_website");
}

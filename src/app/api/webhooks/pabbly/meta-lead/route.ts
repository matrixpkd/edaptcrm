import { handleWebhookGet, handleWebhookPost } from "@/lib/webhooks/handlers";

/**
 * Meta lead form leads forwarded by Pabbly Connect, in the JSON contract of docs/INTEGRATIONS.md
 * ({ phone, dial_code?, name, email?, campaign?, form_name?, ad_name?, lead_id?, product_interest?, city?,
 * answers?, consent? }). Channel "Meta lead form", first door "Meta ad" unless an answer says otherwise.
 * Secret: PABBLY_WEBHOOK_SECRET.
 */
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleWebhookPost(req, "pabbly_meta");
}

export function GET(req: Request): Promise<Response> {
  return handleWebhookGet(req, "pabbly_meta");
}

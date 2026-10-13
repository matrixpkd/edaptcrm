import type { NextRequest } from "next/server";
import { exportResponse } from "../handler";

export const dynamic = "force-dynamic";
// a 50,000-row export streams for a while
export const maxDuration = 300;

/** CSV of contacts; takes the Contacts list filters (grade, stage, door, campaign, channel, owner, family, country, lang, tag, risk, unrated, q). */
export function GET(req: NextRequest) {
  return exportResponse("contacts", req);
}

import type { NextRequest } from "next/server";
import { exportResponse } from "../handler";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** CSV of purchases; filters: from, to (YYYY-MM-DD in the admin's time zone), status, family, mode, source. */
export function GET(req: NextRequest) {
  return exportResponse("purchases", req);
}

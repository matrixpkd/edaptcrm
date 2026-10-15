import { NextResponse } from "next/server";
import { z } from "zod";
import { clientErrorAllowed, recordAppError } from "@/lib/app-errors";
import { clientIp } from "@/lib/auth/login-limit";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const Report = z.object({
  message: z.string().max(4000),
  stack: z.string().max(12000).nullish(),
  digest: z.string().max(200).nullish(),
  path: z.string().max(1000).nullish(),
  source: z.enum(["browser", "boundary"]).default("browser"),
});

/** Browser error reports from ClientErrorReporter and the error boundaries. Same-origin only, size and rate limited. */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) return NextResponse.json({ ok: false }, { status: 403 });
  const raw = await req.text();
  if (raw.length > 20_000) return NextResponse.json({ ok: false }, { status: 413 });
  let body: z.infer<typeof Report>;
  try {
    body = Report.parse(JSON.parse(raw));
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const ip = clientIp(req.headers);
  if (!(await clientErrorAllowed(ip))) return NextResponse.json({ ok: false }, { status: 429 });
  // who saw it, when signed in (best effort: reporting must not fail because of the session lookup)
  const user = await getCurrentUser().catch(() => null);
  await recordAppError({
    kind: "client",
    message: body.message,
    stack: body.stack,
    digest: body.digest,
    path: body.path,
    source: body.source,
    userId: user?.id ?? null,
    userAgent: req.headers.get("user-agent"),
    ip,
  });
  return NextResponse.json({ ok: true });
}

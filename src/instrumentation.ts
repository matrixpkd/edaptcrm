/**
 * Next.js calls onRequestError for every uncaught error while rendering a page, running a server action or a
 * route handler. Each one is written to app_errors (Settings -> Error log) so problems in production can be seen
 * without access to the hosting provider's logs.
 */
export async function register() {}

export async function onRequestError(
  err: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
  context: { routerKind: string; routePath: string; routeType: string },
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { recordAppError } = await import("./lib/app-errors");
  const e = err as { message?: string; stack?: string; digest?: string };
  const header = (k: string) => {
    const v = request.headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  await recordAppError({
    kind: "server",
    message: e?.message ?? String(err),
    stack: e?.stack ?? null,
    digest: e?.digest ?? null,
    path: request.path,
    method: request.method,
    source: context.routeType,
    userAgent: header("user-agent") ?? null,
    ip: (header("x-forwarded-for") ?? "").split(",")[0].trim() || null,
  });
}

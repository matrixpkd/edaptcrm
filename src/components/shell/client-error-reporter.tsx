"use client";
import { useEffect } from "react";

let sent = 0;

/** Sends a browser error to /api/client-errors (at most 10 per page load). Never throws. */
export function reportClientError(report: { message: string; stack?: string | null; digest?: string | null; source?: "browser" | "boundary" }) {
  if (sent >= 10) return;
  sent += 1;
  try {
    void fetch("/api/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ ...report, path: window.location.pathname + window.location.search }),
    }).catch(() => {});
  } catch {
    /* reporting must never break the page */
  }
}

/** Mounted once in the root layout: uncaught errors and rejected promises in the browser go to the error log. */
export function ClientErrorReporter() {
  useEffect(() => {
    const onError = (e: ErrorEvent) =>
      reportClientError({ message: e.message || String(e.error), stack: (e.error as Error | undefined)?.stack ?? null });
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as { message?: string; stack?: string } | undefined;
      reportClientError({ message: r?.message ?? String(e.reason), stack: r?.stack ?? null });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}

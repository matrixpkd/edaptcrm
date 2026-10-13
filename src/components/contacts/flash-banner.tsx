"use client";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, X } from "lucide-react";

/**
 * A one-time success banner (e.g. after Quick Add). Removes its query parameter from the address bar so a
 * refresh or a shared link does not show it again.
 */
export function FlashBanner({ message, param }: { message: React.ReactNode; param: string }) {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // a redirect after a server action keeps the old scroll position: bring the message into view
    const top = ref.current?.getBoundingClientRect().top;
    if (top !== undefined && (top < 0 || top > window.innerHeight)) window.scrollTo({ top: 0 });
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has(param)) {
        url.searchParams.delete(param);
        window.history.replaceState(window.history.state, "", url.pathname + (url.search ? url.search : "") + url.hash);
      }
    } catch {
      /* the banner still shows; only the address bar keeps the parameter */
    }
  }, [param]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      role="status"
      className="flex items-start gap-2 rounded-xl border border-success/25 bg-success/10 px-3 py-2.5 text-sm text-success"
    >
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{message}</div>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="-m-1 rounded-md p-1 hover:bg-success/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { FLASH_COOKIE, readFlashCookie } from "@/lib/flash-cookie";
import { cn } from "@/lib/utils";

/**
 * App-wide toasts. `toast("Reassigned")` from any client component shows a short message at the bottom of the
 * screen (above the phone tab bar), so an action whose button disappears after it runs (Mark qualified, a Today
 * row, a removed alternate number) still says what happened. Server actions that redirect use `flash()` from
 * `@/lib/flash` instead; the message rides a short-lived cookie and the Toaster shows it on the next page.
 */

const EVENT = "edapt:toast";
type Tone = "success" | "error";
type Msg = { text: string; tone: Tone; key: number };

export function toast(text: string, tone: Tone = "success") {
  if (typeof window === "undefined" || !text) return;
  window.dispatchEvent(new CustomEvent<{ text: string; tone: Tone }>(EVENT, { detail: { text, tone } }));
}

/** Mounted once in the signed-in layout. */
export function Toaster() {
  const [msg, setMsg] = useState<Msg | null>(null);
  const pathname = usePathname();
  const search = useSearchParams();

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ text: string; tone: Tone }>).detail;
      setMsg({ text: d.text, tone: d.tone, key: Date.now() });
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);

  // a message left by a server action that redirected here
  useEffect(() => {
    const text = readFlashCookie(document.cookie);
    if (!text) return;
    document.cookie = `${FLASH_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
    setMsg({ text, tone: "success", key: Date.now() });
  }, [pathname, search]);

  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(null), msg.tone === "error" ? 8000 : 4500);
    return () => window.clearTimeout(t);
  }, [msg]);

  return (
    <div
      aria-live="polite"
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex justify-center px-4 lg:bottom-8"
    >
      {msg && (
        <div
          key={msg.key}
          data-toast={msg.tone}
          className={cn(
            "pointer-events-auto flex max-w-md items-center gap-2 rounded-xl px-4 py-3 text-sm text-white shadow-lg",
            msg.tone === "error" ? "bg-danger" : "bg-foreground",
          )}
        >
          {msg.tone === "error" ? (
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <Check className="h-4 w-4 shrink-0" aria-hidden />
          )}
          <span className="min-w-0">{msg.text}</span>
          <button
            type="button"
            onClick={() => setMsg(null)}
            className="-mr-1 rounded p-0.5 text-white/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

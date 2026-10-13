"use client";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { clearPendingCall, readPendingCall } from "./quick-actions";

const MAX_AGE_MS = 3 * 60 * 60 * 1000;

/**
 * Mounted once in the app shell. After the user taps Call and later returns to the app,
 * the Log interaction screen is already open, so logging is never forgotten.
 */
export function CallReturnWatcher() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    function check() {
      if (document.visibilityState !== "visible") return;
      const pending = readPendingCall();
      if (!pending) return;
      // give the dialler a moment to take over before treating this as a return
      if (Date.now() - pending.at < 1500) return;
      clearPendingCall();
      if (Date.now() - pending.at > MAX_AGE_MS) return;
      const target = `/contacts/${pending.contactId}/log`;
      const back = pending.from?.startsWith("/") ? `&return=${encodeURIComponent(pending.from)}` : "";
      if (!pathname.startsWith(target)) router.push(`${target}?type=call&fromCall=1${back}`);
    }
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [router, pathname]);

  return null;
}

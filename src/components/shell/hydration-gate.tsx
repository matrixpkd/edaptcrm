"use client";
import { use } from "react";

let parsed: Promise<void> | null = null;

/** Resolves once the HTML document has been parsed (every inline RSC payload script has run); null on the server. */
function documentParsed(): Promise<void> | null {
  if (parsed) return parsed;
  if (typeof document === "undefined" || document.readyState !== "loading") return null;
  parsed = new Promise((resolve) => document.addEventListener("DOMContentLoaded", () => resolve(), { once: true }));
  return parsed;
}

/**
 * Where hydration waits for server-rendered children. Renders no markup.
 *
 * The React bundled with Next 15.5 (19.2 canary) has a hydration bug: when a host element's child is not ready yet and
 * becomes ready a moment later, React replays the element from a hydration cursor that has already moved into it,
 * throws a mismatch (#418, e.g. `<div class="rounded-xl…">` expected, `<ul class="divide-y…">` found) and re-renders
 * the page on the client. A child is not ready when
 * - it is in a part of the RSC payload that has not streamed in (Flight moves any element past ~3.2 KB of a payload row
 *   into a row of its own, and cached app scripts can start before the document is parsed), or
 * - its props hold a value from a client module whose chunk is still loading: the `error.tsx` boundary Next passes to
 *   the segment below it, or a constant a server component imports from a "use client" file (keep those in plain modules).
 *
 * A function component suspends safely, so this gate holds until the document is parsed (the whole payload is in) and
 * any later wait of its children (a client chunk) happens here, not in a host element. It wraps the root layout's
 * children and, in AppShell, the (app) segment's children (which carry `(app)/error.tsx`); a layout that puts `{children}`
 * of a segment with an `error.tsx` straight into an element needs one too. React 19.3 fixes the replay: drop this then.
 */
export function HydrationGate({ children }: { children: React.ReactNode }) {
  const pending = documentParsed();
  if (pending) use(pending);
  return children;
}

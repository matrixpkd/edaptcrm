/**
 * `toast()` and the message kept for a Toaster that is not listening yet. Plain module (no React), safe on the client
 * and the server; `<Toaster/>` in `@/components/ui/toast` shows the messages through `listenForToasts()`.
 *
 * The Toaster sits in its own Suspense boundary. React hydrates such a boundary last, and not at all while an action
 * is in flight, so a tap before hydration (React replays the submit once the form hydrates) can answer before the
 * Toaster listens. That message is kept here and the Toaster takes it when it starts listening, instead of it being lost.
 */

export const TOAST_EVENT = "edapt:toast";
export type ToastTone = "success" | "error";
export type ToastNote = { text: string; tone: ToastTone };

/** How long a message raised before the Toaster listens is kept for it (an older one is no longer news). */
export const PENDING_TOAST_MS = 10_000;

/** The last message no Toaster showed. One slot, like the screen: a newer message replaces it. */
let pending: (ToastNote & { at: number }) | null = null;

/** Shows `text` in the Toaster, or keeps it for the Toaster when none is listening yet. Does nothing on the server. */
export function toast(text: string, tone: ToastTone = "success") {
  if (typeof window === "undefined" || !text) return;
  // a listening Toaster cancels the event to say it showed the message
  const event = new CustomEvent<ToastNote>(TOAST_EVENT, { detail: { text, tone }, cancelable: true });
  const shown = !window.dispatchEvent(event);
  pending = shown ? null : { text, tone, at: Date.now() };
}

/** Takes the message no Toaster has shown yet, if it is recent. */
export function takePendingToast(now = Date.now()): ToastNote | null {
  const p = pending;
  pending = null;
  return p && now - p.at <= PENDING_TOAST_MS ? { text: p.text, tone: p.tone } : null;
}

/**
 * The Toaster's side: `show` gets every message from now on, and first the kept one if it is recent. Returns the
 * cleanup (for a useEffect).
 */
export function listenForToasts(show: (note: ToastNote) => void): () => void {
  const on = (e: Event) => {
    e.preventDefault(); // tells toast() the message was shown
    const d = (e as CustomEvent<ToastNote>).detail;
    show({ text: d.text, tone: d.tone });
  };
  window.addEventListener(TOAST_EVENT, on);
  const missed = takePendingToast();
  if (missed) show(missed);
  return () => window.removeEventListener(TOAST_EVENT, on);
}

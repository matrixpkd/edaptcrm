import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PENDING_TOAST_MS, TOAST_EVENT, listenForToasts, takePendingToast, toast, type ToastNote } from "@/lib/toast-events";

/**
 * A toast raised before the Toaster listens (a tap before hydration whose action answers while the Toaster's
 * Suspense boundary is still waiting) is kept for the Toaster to show when it starts listening, not dropped.
 * The window is a bare EventTarget: these tests run in node, without a DOM.
 */

const T = 1_800_000_000_000;

let win: EventTarget;

/** What the Toaster's mount effect does: listenForToasts, collecting what it would show. */
function mountToaster() {
  const shown: ToastNote[] = [];
  const unmount = listenForToasts((note) => shown.push(note));
  return { shown, unmount };
}

beforeEach(() => {
  win = new EventTarget();
  vi.stubGlobal("window", win);
  takePendingToast(); // start each test with an empty slot
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("toast before the Toaster listens", () => {
  it("shows a replayed tap's message once the Toaster mounts, 70 ms after it was raised", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(T);
    toast("Linked to this organisation");
    now.mockReturnValue(T + 70);
    const t = mountToaster();
    expect(t.shown).toEqual([{ text: "Linked to this organisation", tone: "success" }]);
    // StrictMode mounts effects twice: the second mount finds nothing, so the message shows once
    t.unmount();
    expect(mountToaster().shown).toEqual([]);
  });

  it("hands a kept message over once", () => {
    toast("Could not link", "error");
    expect(takePendingToast()).toEqual({ text: "Could not link", tone: "error" });
    expect(takePendingToast()).toBeNull();
  });

  it("keeps only the latest of two messages, as the screen would show", () => {
    toast("Reassigned");
    toast("Unlinked");
    expect(mountToaster().shown).toEqual([{ text: "Unlinked", tone: "success" }]);
  });

  it("still keeps the message when something else only watches the event", () => {
    const watched: Event[] = [];
    win.addEventListener(TOAST_EVENT, (e) => watched.push(e));
    toast("Saved");
    expect(watched).toHaveLength(1);
    expect(mountToaster().shown).toEqual([{ text: "Saved", tone: "success" }]);
  });

  it("keeps a message raised while the Toaster is unmounted, for the next one", () => {
    const first = mountToaster();
    first.unmount();
    toast("Saved");
    expect(first.shown).toEqual([]);
    expect(mountToaster().shown).toEqual([{ text: "Saved", tone: "success" }]);
  });
});

describe("toast while the Toaster listens", () => {
  it("shows the message straight away and keeps nothing", () => {
    const t = mountToaster();
    toast("Linked to this organisation");
    toast("Could not unlink", "error");
    expect(t.shown).toEqual([
      { text: "Linked to this organisation", tone: "success" },
      { text: "Could not unlink", tone: "error" },
    ]);
    expect(takePendingToast()).toBeNull();
  });
});

describe("how long a kept message lasts", () => {
  it(`is still shown ${PENDING_TOAST_MS} ms later`, () => {
    vi.spyOn(Date, "now").mockReturnValue(T);
    toast("Saved");
    expect(takePendingToast(T + PENDING_TOAST_MS)).toEqual({ text: "Saved", tone: "success" });
  });

  it("is dropped after that, as it is no longer news", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(T);
    toast("Saved");
    now.mockReturnValue(T + PENDING_TOAST_MS + 1);
    expect(mountToaster().shown).toEqual([]);
    expect(takePendingToast(T)).toBeNull();
  });
});

describe("nothing to show", () => {
  it("keeps nothing for an empty message", () => {
    toast("");
    expect(mountToaster().shown).toEqual([]);
  });

  it("keeps nothing on the server, where there is no window", () => {
    vi.unstubAllGlobals();
    expect(typeof window).toBe("undefined");
    toast("Saved");
    vi.stubGlobal("window", win);
    expect(takePendingToast()).toBeNull();
  });
});

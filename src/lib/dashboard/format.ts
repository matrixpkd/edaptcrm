/**
 * Small display helpers for the dashboard. PURE: safe in server and client components.
 */

export type Delta = {
  /** relative change (0.12 = +12%); null when there is nothing to compare against */
  change: number | null;
  direction: "up" | "down" | "flat";
  /** "+12%", "−8%", "No change", "New" */
  text: string;
};

/** Relative change of `current` against `previous`. A previous of 0 gives "New" (or "No change" when both are 0). */
export function deltaOf(current: number, previous: number): Delta {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return { change: null, direction: "flat", text: "" };
  if (previous === 0) {
    if (current === 0) return { change: 0, direction: "flat", text: "No change" };
    return { change: null, direction: current > 0 ? "up" : "down", text: "New" };
  }
  const change = (current - previous) / Math.abs(previous);
  const rounded = Math.round(change * 100);
  if (rounded === 0) return { change, direction: "flat", text: "No change" };
  return { change, direction: rounded > 0 ? "up" : "down", text: `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)}%` };
}

/** Change between two shares in percentage points: "+4 pts", "−2 pts", "No change". */
export function pointsDelta(current: number | null, previous: number | null): Delta {
  if (current === null || previous === null) return { change: null, direction: "flat", text: "" };
  const pts = Math.round((current - previous) * 100);
  if (pts === 0) return { change: 0, direction: "flat", text: "No change" };
  return { change: current - previous, direction: pts > 0 ? "up" : "down", text: `${pts > 0 ? "+" : "−"}${Math.abs(pts)} pts` };
}

/** 0.4567 -> "46%"; small non-zero shares keep one decimal ("0.4%"); null -> "—". */
export function share(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const p = v * 100;
  if (p !== 0 && Math.abs(p) < 1) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}

/** Response time: "under 1 min", "45 min", "3.5 h", "2.1 days"; null -> "—". */
export function formatHours(h: number | null | undefined): string {
  if (h === null || h === undefined || !Number.isFinite(h)) return "—";
  if (h * 60 < 1) return "under 1 min";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${(Math.round(h * 10) / 10).toString()} h`;
  return `${(Math.round((h / 24) * 10) / 10).toString()} days`;
}

/** "1,234" in Indian grouping. */
export function count(n: number | null | undefined): string {
  return Number(n ?? 0).toLocaleString("en-IN");
}

/** Singular/plural: plural(1, "customer") -> "1 customer"; plural(3, "customer") -> "3 customers". */
export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${count(n)} ${n === 1 ? word : pluralWord}`;
}

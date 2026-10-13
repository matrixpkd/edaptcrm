/**
 * What changed between two JSON values, as a short list of paths ("fit.spendingBand.1: 5 -> 6"), for the audit
 * log viewer. PURE.
 */

export type JsonChange = { path: string; before: unknown; after: unknown };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Lists with stable `key` / `id` / `rung` fields are compared item by item by that field, not by position. */
function idOf(v: unknown): string | null {
  if (!isObj(v)) return null;
  for (const f of ["key", "id", "rung"]) {
    const x = v[f];
    if (typeof x === "string" || typeof x === "number") return `${f}=${x}`;
  }
  return null;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function walk(a: unknown, b: unknown, path: string, out: JsonChange[], limit: number) {
  if (out.length >= limit || same(a, b)) return;
  if (isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
      walk(a[k], b[k], path ? `${path}.${k}` : k, out, limit);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const ids = [...a, ...b].map(idOf);
    if (ids.every((x) => x !== null)) {
      const ma = new Map(a.map((x) => [idOf(x)!, x]));
      const mb = new Map(b.map((x) => [idOf(x)!, x]));
      for (const id of [...new Set([...ma.keys(), ...mb.keys()])]) {
        walk(ma.get(id), mb.get(id), `${path}[${id}]`, out, limit);
      }
      const orderA = a.map(idOf).filter((x) => mb.has(x!));
      const orderB = b.map(idOf).filter((x) => ma.has(x!));
      if (out.length < limit && !same(orderA, orderB)) out.push({ path: `${path} (order)`, before: orderA, after: orderB });
      return;
    }
    if (a.every((x) => !isObj(x) && !Array.isArray(x)) && b.every((x) => !isObj(x) && !Array.isArray(x))) {
      out.push({ path, before: a, after: b });
      return;
    }
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) walk(a[i], b[i], `${path}[${i}]`, out, limit);
    return;
  }
  out.push({ path: path || "(value)", before: a === undefined ? null : a, after: b === undefined ? null : b });
}

/** Changed leaves between `before` and `after` (at most `limit`). Equal values give an empty list. */
export function jsonChanges(before: unknown, after: unknown, limit = 50): JsonChange[] {
  const out: JsonChange[] = [];
  walk(before, after, "", out, limit);
  return out;
}

/** A value for one line of the audit viewer: strings bare, everything else as compact JSON, cut at `max`. */
export function showValue(v: unknown, max = 160): string {
  if (v === null || v === undefined) return "empty";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

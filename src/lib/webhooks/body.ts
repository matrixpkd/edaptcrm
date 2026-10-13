/**
 * Reading a webhook request body: JSON, form-encoded or multipart, with a size cap. PURE apart from the
 * Request API (no server-only imports), unit tested.
 *
 * - JSON (any content type, since senders mislabel it); a JSON string holding JSON is unwrapped once.
 * - application/x-www-form-urlencoded and multipart/form-data: bracket keys expand ("answers[City]=Kochi" ->
 *   {answers: {City: "Kochi"}}), repeated keys become lists, and a value holding a JSON object or list is parsed.
 *   A form with a single field that holds a JSON object (e.g. Pabbly's "payload=") becomes that object.
 * - NUL characters are removed (Postgres jsonb cannot store them).
 */
import { isObject, type JsonObject } from "./paths";

export const MAX_WEBHOOK_BYTES = 1_000_000;

export type BodyResult = { ok: true; payload: unknown } | { ok: false; status: 400 | 413; error: string };

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

function stripNul(v: unknown): unknown {
  if (typeof v === "string") return v.includes("\u0000") ? v.replace(/\u0000/g, "") : v;
  if (Array.isArray(v)) return v.map(stripNul);
  if (isObject(v)) {
    const out: JsonObject = {};
    for (const [k, x] of Object.entries(v)) {
      if (UNSAFE.has(k)) continue;
      out[k.replace(/\u0000/g, "")] = stripNul(x);
    }
    return out;
  }
  return v;
}

function maybeJson(value: string): unknown {
  const s = value.trim();
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      return JSON.parse(s);
    } catch {
      return value;
    }
  }
  return value;
}

/** "a[b][c]" -> ["a", "b", "c"]; "a" -> ["a"] */
function keyPath(key: string): string[] {
  const m = /^([^[\]]+)((?:\[[^[\]]*\])+)$/.exec(key);
  if (!m) return [key];
  const rest = [...m[2].matchAll(/\[([^[\]]*)\]/g)].map((x) => x[1]);
  return [m[1], ...rest];
}

/** Turns form entries into an object (bracket keys expanded, repeated keys collected into lists). */
export function formEntriesToObject(entries: Iterable<[string, string]>): JsonObject {
  const out: JsonObject = {};
  for (const [rawKey, rawValue] of entries) {
    const path = keyPath(rawKey.trim());
    if (path.some((p) => UNSAFE.has(p))) continue;
    const value = maybeJson(rawValue);
    let cur: JsonObject = out;
    for (let i = 0; i < path.length; i++) {
      const seg = path[i] === "" ? String(Object.keys(cur).length) : path[i];
      if (i === path.length - 1) {
        if (Object.prototype.hasOwnProperty.call(cur, seg)) {
          const prev = cur[seg];
          cur[seg] = Array.isArray(prev) ? [...prev, value] : [prev, value];
        } else {
          cur[seg] = value;
        }
      } else {
        const next = cur[seg];
        if (!isObject(next)) cur[seg] = {};
        cur = cur[seg] as JsonObject;
      }
    }
  }
  // a form carrying one JSON document in one field
  const keys = Object.keys(out);
  if (keys.length === 1 && isObject(out[keys[0]]) && /^(payload|data|body|json|event|lead|message)$/i.test(keys[0])) {
    return out[keys[0]] as JsonObject;
  }
  return out;
}

/** Parses a body already read as text. */
export function parseWebhookText(text: string, contentType: string | null): BodyResult {
  const body = text.replace(/^﻿/, "");
  if (!body.trim()) return { ok: false, status: 400, error: "The request body is empty." };
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded")) {
    return finish(formEntriesToObject(new URLSearchParams(body).entries()));
  }
  try {
    let parsed: unknown = JSON.parse(body);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return finish(parsed);
  } catch {
    // not JSON: a form body sent without its content type ("a=1&b=2")
    if (!ct.includes("json") && /^[^{[\s][^=&\s]*=/.test(body.trim())) {
      return finish(formEntriesToObject(new URLSearchParams(body.trim()).entries()));
    }
    return { ok: false, status: 400, error: "The request body is not valid JSON or form data." };
  }
}

function finish(payload: unknown): BodyResult {
  if (!isObject(payload) && !(Array.isArray(payload) && payload.length > 0)) {
    return { ok: false, status: 400, error: "The request body must be a JSON object." };
  }
  return { ok: true, payload: stripNul(payload) };
}

/**
 * Reads at most `maxBytes` of a request body. The declared Content-Length is checked first, and the stream is cut
 * off as soon as it passes the cap, so a chunked or lying sender can never make the server buffer more than that.
 * Null when the body is too large.
 */
export async function readBodyBytes(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Reads and parses a webhook request body (at most `maxBytes`, else 413). */
export async function readWebhookBody(req: Request, maxBytes = MAX_WEBHOOK_BYTES): Promise<BodyResult> {
  let bytes: Uint8Array | null;
  try {
    bytes = await readBodyBytes(req, maxBytes);
  } catch {
    return { ok: false, status: 400, error: "The request body could not be read." };
  }
  if (!bytes) return { ok: false, status: 413, error: "The request body is too large." };
  const ct = req.headers.get("content-type");
  if ((ct ?? "").toLowerCase().includes("multipart/form-data")) {
    let form: FormData;
    try {
      // parsed from the bytes already read (and capped), never from the raw stream
      form = await new Response(bytes as BodyInit, { headers: { "content-type": ct ?? "" } }).formData();
    } catch {
      return { ok: false, status: 400, error: "The form data could not be read." };
    }
    const entries: [string, string][] = [];
    for (const [k, v] of form.entries()) if (typeof v === "string") entries.push([k, v]);
    if (!entries.length) return { ok: false, status: 400, error: "The request body is empty." };
    return finish(formEntriesToObject(entries));
  }
  return parseWebhookText(new TextDecoder().decode(bytes), ct);
}

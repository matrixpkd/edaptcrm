import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { contacts, payments, purchases, type Role } from "@/db/schema";
import { can, canViewContact } from "@/lib/auth/permissions";
import { INLINE_IMAGE_EXTENSIONS } from "@/lib/file-types";

/**
 * File store for payment proofs and import files.
 * Supabase Storage when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set, else ./uploads (dev only).
 * Files are always served through /api/files/<key>, which checks the session AND who may see the file
 * (canReadStoredFile): proofs follow the contact, import files are admin-only, anything else is never served.
 *
 * Import files can be bigger than a serverless request body (Vercel stops at about 4.5 MB), so with Supabase the
 * browser uploads them straight to Storage with a signed upload URL (createSignedUpload) and hands the key over.
 */
const LOCAL_ROOT = path.join(process.cwd(), "uploads");

/** The folders files are stored under. */
export const PROOF_FOLDER = "proofs";
export const IMPORT_FOLDER = "imports";

/** The URL stored on rows (payments.proof_url, import_batches.file_url) for a storage key. */
export function fileUrlForKey(key: string): string {
  return `/api/files/${key}`;
}

/** A storage key from the URL path segments (or a joined key); null when it is not a clean relative key. */
export function cleanStoredKey(key: string | string[]): string | null {
  // a URL segment can carry an encoded "/" ("..%2F..%2Fetc"): split every segment again before checking
  const parts = (Array.isArray(key) ? key : [key]).flatMap((k) => k.split("/")).filter((p) => p !== "");
  if (!parts.length || parts.some((p) => p === "." || p === ".." || p.includes("\\") || p.includes("\0"))) return null;
  return parts.join("/");
}

/** The top folder of a storage key ("proofs", "imports", ...), lower-cased. */
export function storedKeyFolder(key: string): string {
  return key.split("/")[0]?.toLowerCase() ?? "";
}

/**
 * May this signed-in user read the stored file `key`?
 * - "proofs": only when they can view the contact of a payment or purchase whose proof_url is this file;
 * - "imports": only people who run imports (can(user, "import.run"));
 * - anything else: nobody.
 */
export async function canReadStoredFile(user: { id: string; role: Role }, key: string, tx: Tx = db): Promise<boolean> {
  const folder = storedKeyFolder(key);
  if (folder === IMPORT_FOLDER) return can(user, "import.run");
  if (folder !== PROOF_FOLDER) return false;
  const url = fileUrlForKey(key);
  const holders = await tx
    .selectDistinct({ ownerId: contacts.ownerId })
    .from(purchases)
    .innerJoin(contacts, eq(contacts.id, purchases.contactId))
    .leftJoin(payments, and(eq(payments.purchaseId, purchases.id), eq(payments.proofUrl, url)))
    .where(or(eq(purchases.proofUrl, url), eq(payments.proofUrl, url)))
    .limit(20);
  return holders.some((c) => canViewContact(user, c));
}

function supabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || "crm-files";
  return url && key ? { url: url.replace(/\/$/, ""), key, bucket } : null;
}

/**
 * Works with both kinds of Supabase server key: the legacy service_role JWT (read from Authorization) and the new
 * sb_secret_... keys (read from apikey).
 */
function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, apikey: key };
}

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-80) || "file";
}

/** A fresh, unguessable key under `folder`: "<folder>/<yyyy-mm>/<uuid>-<safe name>". */
export function newStorageKey(folder: string, fileName: string): string {
  return `${folder.replace(/[^a-z0-9/_-]/gi, "")}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}-${safeName(fileName)}`;
}

/** True when a key has the shape newStorageKey gives under `folder` (used to accept keys handed back by a browser). */
export function isNewStorageKey(folder: string, key: string): boolean {
  const f = folder.replace(/[^a-z0-9/_-]/gi, "");
  const re = new RegExp(`^${f}/\\d{4}-\\d{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[a-zA-Z0-9._-]{1,80}$`);
  return re.test(key);
}

/** True when files go to Supabase Storage, so the browser can upload big files there directly. */
export function directUploadAvailable(): boolean {
  return supabase() !== null;
}

/**
 * A signed upload URL for one new file under `folder` (Supabase Storage, created with the service key):
 * the browser PUTs the file there, then hands `key` back to the server. Null without Supabase (local dev uploads
 * through the server action instead). The URL is valid for 2 hours and for this key only.
 */
export async function createSignedUpload(folder: string, fileName: string): Promise<{ key: string; uploadUrl: string } | null> {
  const sb = supabase();
  if (!sb) return null;
  const key = newStorageKey(folder, fileName);
  const res = await fetch(`${sb.url}/storage/v1/object/upload/sign/${sb.bucket}/${key}`, {
    method: "POST",
    headers: { ...authHeaders(sb.key), "Content-Type": "application/json", "x-upsert": "false" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`Could not prepare the upload: ${res.status} ${await res.text()}`);
  const { url } = (await res.json()) as { url?: string };
  if (!url) throw new Error("Could not prepare the upload: Storage returned no URL");
  return { key, uploadUrl: `${sb.url}/storage/v1${url.startsWith("/") ? url : `/${url}`}` };
}

/** The bytes of a stored file (downloaded from Supabase Storage, or read from ./uploads); null when missing. */
export async function readStoredBytes(key: string): Promise<Uint8Array | null> {
  const file = await readStoredFile(key);
  if (!file) return null;
  if ("bytes" in file) return file.bytes;
  const res = await fetch(file.redirect);
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

/** Saves a file and returns the URL to store (e.g. on payments.proof_url). */
export async function saveFile(
  file: File | { name: string; type: string; data: Uint8Array },
  folder: string,
): Promise<string> {
  const bytes = "data" in file ? file.data : new Uint8Array(await file.arrayBuffer());
  const key = newStorageKey(folder, file.name);
  const sb = supabase();
  if (sb) {
    const res = await fetch(`${sb.url}/storage/v1/object/${sb.bucket}/${key}`, {
      method: "POST",
      headers: {
        ...authHeaders(sb.key),
        "Content-Type": file.type || "application/octet-stream",
        "x-upsert": "false",
      },
      body: Buffer.from(bytes),
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  } else {
    const full = path.join(LOCAL_ROOT, key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
  }
  return fileUrlForKey(key);
}

/** For /api/files: a short-lived signed URL (Supabase) or the local bytes. */
export async function readStoredFile(
  key: string,
): Promise<{ redirect: string } | { bytes: Uint8Array; contentType: string } | null> {
  if (cleanStoredKey(key) !== key) return null;
  const sb = supabase();
  if (sb) {
    const res = await fetch(`${sb.url}/storage/v1/object/sign/${sb.bucket}/${key}`, {
      method: "POST",
      headers: { ...authHeaders(sb.key), "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 300 }),
    });
    if (!res.ok) return null;
    const { signedURL } = (await res.json()) as { signedURL: string };
    // anything that is not a picture downloads instead of opening in the browser (see storedFileHeaders)
    const download = isInlineKey(key) ? "" : `${signedURL.includes("?") ? "&" : "?"}download=${encodeURIComponent(storedFileName(key))}`;
    return { redirect: `${sb.url}/storage/v1${signedURL}${download}` };
  }
  try {
    const bytes = await readFile(path.join(LOCAL_ROOT, key));
    return { bytes, contentType: guessType(key) };
  } catch {
    return null;
  }
}

/** The file name part of a key, without the "<uuid>-" prefix newStorageKey adds. */
export function storedFileName(key: string): string {
  const last = key.split("/").pop() ?? "file";
  return last.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/, "").replace(/[^a-zA-Z0-9._-]+/g, "_") || "file";
}

function isInlineKey(key: string): boolean {
  return INLINE_IMAGE_EXTENSIONS.has(key.split(".").pop()?.toLowerCase() ?? "");
}

/**
 * Response headers for a stored file served by /api/files: never sniffed (nosniff), sandboxed by CSP so even a
 * file that slipped through as HTML or SVG could not run script on our origin, shown inline only when it is a
 * picture (PNG, JPEG, GIF, WebP) and otherwise sent as a download.
 */
export function storedFileHeaders(key: string, contentType: string): Record<string, string> {
  const inline = isInlineKey(key) && contentType.startsWith("image/");
  return {
    "Content-Type": contentType,
    "Content-Disposition": inline ? "inline" : `attachment; filename="${storedFileName(key)}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    "Cache-Control": "private, max-age=300",
  };
}

function guessType(key: string) {
  const ext = key.split(".").pop()?.toLowerCase();
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      pdf: "application/pdf",
      csv: "text/csv",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      txt: "text/plain",
    }[ext ?? ""] ?? "application/octet-stream"
  );
}

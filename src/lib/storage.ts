import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * File store for payment proofs and import files.
 * Supabase Storage when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set, else ./uploads (dev only).
 * Files are always served through /api/files/<key>, which checks the session.
 */
const LOCAL_ROOT = path.join(process.cwd(), "uploads");

function supabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || "crm-files";
  return url && key ? { url: url.replace(/\/$/, ""), key, bucket } : null;
}

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-80) || "file";
}

/** Saves a file and returns the URL to store (e.g. on payments.proof_url). */
export async function saveFile(
  file: File | { name: string; type: string; data: Uint8Array },
  folder: string,
): Promise<string> {
  const bytes = "data" in file ? file.data : new Uint8Array(await file.arrayBuffer());
  const key = `${folder.replace(/[^a-z0-9/_-]/gi, "")}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}-${safeName(file.name)}`;
  const sb = supabase();
  if (sb) {
    const res = await fetch(`${sb.url}/storage/v1/object/${sb.bucket}/${key}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sb.key}`,
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
  return `/api/files/${key}`;
}

/** For /api/files: a short-lived signed URL (Supabase) or the local bytes. */
export async function readStoredFile(
  key: string,
): Promise<{ redirect: string } | { bytes: Uint8Array; contentType: string } | null> {
  if (key.includes("..")) return null;
  const sb = supabase();
  if (sb) {
    const res = await fetch(`${sb.url}/storage/v1/object/sign/${sb.bucket}/${key}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sb.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 300 }),
    });
    if (!res.ok) return null;
    const { signedURL } = (await res.json()) as { signedURL: string };
    return { redirect: `${sb.url}/storage/v1${signedURL}` };
  }
  try {
    const bytes = await readFile(path.join(LOCAL_ROOT, key));
    return { bytes, contentType: guessType(key) };
  } catch {
    return null;
  }
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

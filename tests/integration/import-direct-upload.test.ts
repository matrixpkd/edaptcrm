import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { importBatches, importRows } from "@/db/schema";
import { createImportBatch, prepareImportUpload } from "@/lib/import/batches";
import { createSignedUpload, newStorageKey } from "@/lib/storage";
import { makeUser, resetDb } from "../support/db";

const written: string[] = [];
const local = (key: string) => path.join(process.cwd(), "uploads", key);
const ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_STORAGE_BUCKET"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

describe("import files uploaded straight to storage", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });
  afterAll(() => {
    for (const f of written) rmSync(f, { force: true });
  });

  it("the server reads a file the browser already stored, by its key, and keeps that file", async () => {
    const admin = await makeUser({ role: "admin" });
    const key = newStorageKey("imports", "zoho-contacts.csv");
    mkdirSync(path.dirname(local(key)), { recursive: true });
    writeFileSync(local(key), readFileSync(path.join(__dirname, "../fixtures/import/zoho-contacts.csv")));
    written.push(local(key));

    const id = await createImportBatch({ fileName: "zoho-contacts.csv", fileType: "text/csv", storedKey: key, source: "zoho" }, admin);
    const [b] = await db.select().from(importBatches).where(eq(importBatches.id, id));
    expect(b.fileUrl).toBe(`/api/files/${key}`);
    expect((await db.select().from(importRows).where(eq(importRows.batchId, id))).length).toBeGreaterThan(2);
  });

  it("refuses keys that are not fresh import keys, missing files and non-admins", async () => {
    const admin = await makeUser({ role: "admin" });
    const manager = await makeUser({ role: "manager" });
    const base = { fileName: "x.csv", fileType: "text/csv", source: "zoho" };
    await expect(createImportBatch({ ...base, storedKey: "proofs/2026-10/0f8fad5b-d9cb-469f-a165-70867728950e-x.png" }, admin)).rejects.toThrow(/not an import file/);
    await expect(createImportBatch({ ...base, storedKey: "imports/../proofs/x" }, admin)).rejects.toThrow(/not an import file/);
    await expect(createImportBatch({ ...base, storedKey: newStorageKey("imports", "gone.csv") }, admin)).rejects.toThrow(/could not be found/);
    await expect(createImportBatch({ ...base, storedKey: newStorageKey("imports", "x.csv") }, manager)).rejects.toThrow();
    await expect(prepareImportUpload({ fileName: "x.csv", size: 10 }, manager)).rejects.toThrow();
    await expect(prepareImportUpload({ fileName: "x.csv", size: 30 * 1024 * 1024 }, admin)).rejects.toThrow(/24 MB/);
  });

  it("without Supabase there is no signed URL (the browser posts the file); with it, one per new key", async () => {
    const admin = await makeUser({ role: "admin" });
    delete process.env.SUPABASE_URL;
    expect(await prepareImportUpload({ fileName: "x.csv", size: 10 }, admin)).toBeNull();

    process.env.SUPABASE_URL = "https://abc.supabase.co/";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    process.env.SUPABASE_STORAGE_BUCKET = "crm-files";
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      void init;
      const path = new URL(url).pathname.replace("/storage/v1", "");
      return new Response(JSON.stringify({ url: `${path}?token=tok123` }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await createSignedUpload("imports", "Big export.csv");
    expect(r?.key).toMatch(/^imports\/\d{4}-\d{2}\/[0-9a-f-]{36}-Big_export.csv$/);
    expect(r?.uploadUrl).toBe(`https://abc.supabase.co/storage/v1/object/upload/sign/crm-files/${r?.key}?token=tok123`);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://abc.supabase.co/storage/v1/object/upload/sign/crm-files/${r?.key}`);
    expect(init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer service-key" } });
  });
});

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, payments, purchases } from "@/db/schema";
import { eraseContact } from "@/lib/contacts/privacy";
import { canReadStoredFile, cleanStoredKey, isNewStorageKey, newStorageKey, redactStoredKey, storedKeyFromUrl } from "@/lib/storage";
import { makeUser, resetDb } from "../support/db";

const session = vi.hoisted(() => ({ user: null as null | { id: string; role: "admin" | "manager" | "sales" | "support" } }));
vi.mock("@/lib/auth/session", () => ({ getApiUser: vi.fn(async () => session.user) }));
const { GET } = await import("@/app/api/files/[...key]/route");

let seq = 0;
async function contact(ownerId: string | null) {
  seq += 1;
  const [c] = await db
    .insert(contacts)
    .values({ phoneE164: `+9198951${String(10000 + seq).padStart(5, "0")}`, name: `File ${seq}`, firstDoor: "other", ownerId })
    .returning();
  return c;
}
async function purchase(contactId: string, proofUrl: string | null = null) {
  const [p] = await db
    .insert(purchases)
    .values({ contactId, productName: "Workshop", family: "workshop", amount: 999, amountInr: 999, mode: "bank_transfer", proofUrl })
    .returning();
  return p;
}

const PROOF = "proofs/2026-10/0f8fad5b-d9cb-469f-a165-70867728950e-shot.png";
const LOCAL = path.join(process.cwd(), "uploads", "proofs", "2026-10", "0f8fad5b-d9cb-469f-a165-70867728950e-shot.png");

describe("stored file access", () => {
  beforeEach(async () => {
    await resetDb();
    session.user = null;
  });
  afterAll(async () => {
    await rm(LOCAL, { force: true });
  });

  it("a payment proof is served only to people who can view its contact", async () => {
    const owner = await makeUser({ role: "sales" });
    const colleague = await makeUser({ role: "sales" });
    const manager = await makeUser({ role: "manager" });
    const support = await makeUser({ role: "support" });
    const c = await contact(owner.id);
    const p = await purchase(c.id);
    await db.insert(payments).values({ purchaseId: p.id, contactId: c.id, amount: 999, amountInr: 999, status: "unverified", proofUrl: `/api/files/${PROOF}` });

    expect(await canReadStoredFile(owner, PROOF)).toBe(true);
    expect(await canReadStoredFile(manager, PROOF)).toBe(true);
    expect(await canReadStoredFile(support, PROOF)).toBe(true);
    expect(await canReadStoredFile(colleague, PROOF)).toBe(false);
    // a proof nobody's payment points at is never served
    expect(await canReadStoredFile(manager, "proofs/2026-10/orphan.png")).toBe(false);

    // the proof on the purchase itself counts too, and a pool contact is open to every salesperson
    const pool = await contact(null);
    await purchase(pool.id, "/api/files/proofs/2026-10/pool.pdf");
    expect(await canReadStoredFile(colleague, "proofs/2026-10/pool.pdf")).toBe(true);
  });

  it("import files are admin only; any other folder is never served", async () => {
    const admin = await makeUser({ role: "admin" });
    const manager = await makeUser({ role: "manager" });
    expect(await canReadStoredFile(admin, "imports/2026-10/x.csv")).toBe(true);
    expect(await canReadStoredFile(manager, "imports/2026-10/x.csv")).toBe(false);
    expect(await canReadStoredFile(admin, "other/x.csv")).toBe(false);
    expect(await canReadStoredFile(admin, "IMPORTS/2026-10/x.csv")).toBe(true);
  });

  it("the route answers 401 signed out, 404 when the user may not see the file, and the bytes otherwise", async () => {
    const owner = await makeUser({ role: "sales" });
    const colleague = await makeUser({ role: "sales" });
    const c = await contact(owner.id);
    await purchase(c.id, `/api/files/${PROOF}`);
    await mkdir(path.dirname(LOCAL), { recursive: true });
    await writeFile(LOCAL, new Uint8Array([137, 80, 78, 71]));
    const get = (key: string[]) => GET(new Request("http://localhost/api/files/x"), { params: Promise.resolve({ key }) });

    expect((await get(PROOF.split("/"))).status).toBe(401);
    session.user = colleague;
    expect((await get(PROOF.split("/"))).status).toBe(404);
    session.user = owner;
    const ok = await get(PROOF.split("/"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect((await get(["proofs", "..", "imports", "x.csv"])).status).toBe(404);
  });

  it("an erased contact's payment proof answers 404 at once, for everyone, and its file is deleted", async () => {
    const admin = await makeUser({ role: "admin" });
    const owner = await makeUser({ role: "sales" });
    const c = await contact(owner.id);
    const p = await purchase(c.id);
    await db.insert(payments).values({ purchaseId: p.id, contactId: c.id, amount: 999, amountInr: 999, status: "verified", proofUrl: `/api/files/${PROOF}` });
    await mkdir(path.dirname(LOCAL), { recursive: true });
    await writeFile(LOCAL, new Uint8Array([137, 80, 78, 71]));
    const get = () => GET(new Request("http://localhost/api/files/x"), { params: Promise.resolve({ key: PROOF.split("/") }) });
    session.user = owner;
    expect((await get()).status).toBe(200);

    expect(await eraseContact(c.id, admin, "Asked by email")).toMatchObject({ proofKeys: [PROOF], filesDeleted: 1, fileErrors: 0 });
    expect((await get()).status).toBe(404);
    session.user = admin;
    expect((await get()).status).toBe(404);
    expect(existsSync(LOCAL)).toBe(false);
    expect(await db.select().from(payments).where(eq(payments.proofUrl, `/api/files/${PROOF}`))).toHaveLength(0);
  });

  it("keys: path tricks are refused; browser-returned keys must look like ours", () => {
    expect(cleanStoredKey(["proofs", "2026-10", "a.png"])).toBe("proofs/2026-10/a.png");
    expect(cleanStoredKey("proofs/../imports/a.csv")).toBeNull();
    expect(cleanStoredKey(["proofs", "a\\\\b"])).toBeNull();
    expect(cleanStoredKey([])).toBeNull();
    const key = newStorageKey("imports", "Zoho export (final).xlsx");
    expect(key).toMatch(/^imports\/\d{4}-\d{2}\/[0-9a-f-]{36}-Zoho_export_final_.xlsx$/);
    expect(isNewStorageKey("imports", key)).toBe(true);
    expect(isNewStorageKey("imports", key.replace("imports", "proofs"))).toBe(false);
    expect(isNewStorageKey("imports", "imports/2026-10/../../etc/passwd")).toBe(false);
    // the key behind a stored URL (an outside link has none), and a key fit for a log: no file name
    expect(storedKeyFromUrl(`/api/files/${PROOF}`)).toBe(PROOF);
    expect(storedKeyFromUrl("/api/files/proofs/../imports/a.csv")).toBeNull();
    expect(storedKeyFromUrl("https://example.com/proofs/a.png")).toBeNull();
    expect(storedKeyFromUrl(null)).toBeNull();
    expect(redactStoredKey(PROOF)).toBe("proofs/2026-10/0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(redactStoredKey("proofs/2026-10/priya-nair.png")).toBe("proofs/(file)");
  });
});

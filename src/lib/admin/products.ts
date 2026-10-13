import "server-only";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { products, purchases, type Product } from "@/db/schema";
import { audit, auditDiff } from "@/lib/audit";
import { currenciesWithRates } from "@/lib/money/fx";
import { getSettings, type ProductFamily, type Rung } from "@/lib/settings";
import { isUuid } from "@/lib/utils";
import { AdminError } from "./errors";
import { assertAdmin, inTx, saveSettingAudited, type AdminActor } from "./settings";
import { validateFamilies, validateRungs } from "./validate";

/**
 * The product catalogue and the ladder (Settings > Products). A product's rung always comes from its family
 * (settings `ladder.families`), so changing a family's rung moves every product of that family with it.
 * Admin only; every change is audited.
 */

export type AdminProductRow = Product & { purchaseCount: number };

/** Every product (active first, then by family and name) with how many purchases point at it. */
export async function listProducts(tx: Tx = db): Promise<AdminProductRow[]> {
  const rows = await tx
    .select()
    .from(products)
    .orderBy(sql`${products.active} desc`, asc(products.family), asc(sql`lower(${products.name})`));
  const used = await tx
    .select({ id: purchases.productId, n: sql<number>`count(*)::int` })
    .from(purchases)
    .where(isNotNull(purchases.productId))
    .groupBy(purchases.productId);
  const by = new Map(used.map((u) => [u.id, Number(u.n)]));
  return rows.map((p) => ({ ...p, purchaseCount: by.get(p.id) ?? 0 }));
}

export type ProductInput = {
  name: string | null;
  family: string | null;
  listPrice: number | null;
  currency: string | null;
  active: boolean;
  /** TagMango ids or name patterns ("Claude Mastery*"), one per entry */
  externalIds: string[];
  description: string | null;
};

type CleanProduct = Omit<ProductInput, "name" | "family" | "listPrice" | "currency"> & {
  name: string;
  family: string;
  rung: number | null;
  listPrice: number;
  currency: string;
};

async function cleanProduct(input: ProductInput, t: Tx): Promise<CleanProduct> {
  const s = await getSettings(["ladder.families", "currency"], t);
  const name = (input.name ?? "").trim().replace(/\s+/g, " ");
  if (!name) throw new AdminError("Enter the product name", "name");
  if (name.length > 120) throw new AdminError("That name is too long", "name");
  const fam = s["ladder.families"].find((f) => f.key === input.family);
  if (!fam) throw new AdminError("Choose a product family", "family");
  const listPrice = input.listPrice;
  if (listPrice === null || !Number.isFinite(listPrice) || listPrice < 0) throw new AdminError("Enter a list price of 0 or more", "listPrice");
  if (listPrice > 1e11) throw new AdminError("That price is too large", "listPrice");
  const currency = (input.currency ?? "INR").trim().toUpperCase();
  const offered = new Set([...s.currency.enabled, ...currenciesWithRates(s.currency)]);
  if (!offered.has(currency)) throw new AdminError(`Add ${currency} in Settings > Currency first`, "currency");
  const externalIds = [...new Set(input.externalIds.map((e) => e.trim()).filter(Boolean))];
  if (externalIds.some((e) => e.length > 120)) throw new AdminError("A TagMango id is too long", "externalIds");
  const description = input.description?.trim() || null;
  return {
    name,
    family: fam.key,
    rung: fam.rung,
    listPrice: Math.round(listPrice * 100) / 100,
    currency,
    active: input.active,
    externalIds,
    description,
  };
}

/** TagMango ids must point at one product only, or orders would match the wrong one. */
async function assertExternalIdsFree(ids: string[], exceptId: string | null, t: Tx) {
  if (!ids.length) return;
  const rows = await t
    .select({ id: products.id, name: products.name, externalIds: products.externalIds })
    .from(products)
    .where(sql`${products.externalIds} && ${sql`array[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::text[]`}`);
  const clash = rows.find((r) => r.id !== exceptId);
  if (clash) {
    const id = clash.externalIds.find((e) => ids.includes(e));
    throw new AdminError(`"${id}" already belongs to ${clash.name}`, "externalIds");
  }
}

export async function createProduct(input: ProductInput, actor: AdminActor, tx: Tx = db): Promise<Product> {
  assertAdmin(actor);
  return inTx(tx, async (t) => {
    const clean = await cleanProduct(input, t);
    await assertExternalIdsFree(clean.externalIds, null, t);
    const [p] = await t.insert(products).values(clean).returning();
    await audit({ table: "products", rowId: p.id, action: "insert", newValue: clean, userId: actor.id }, t);
    return p;
  });
}

export async function updateProduct(id: string, input: ProductInput, actor: AdminActor, tx: Tx = db): Promise<Product> {
  assertAdmin(actor);
  if (!isUuid(id)) throw new AdminError("That product does not exist");
  return inTx(tx, async (t) => {
    const [before] = await t.select().from(products).where(eq(products.id, id)).limit(1).for("update");
    if (!before) throw new AdminError("That product does not exist");
    const clean = await cleanProduct(input, t);
    await assertExternalIdsFree(clean.externalIds, id, t);
    const [after] = await t
      .update(products)
      .set({ ...clean, updatedAt: new Date() })
      .where(eq(products.id, id))
      .returning();
    await auditDiff("products", id, before, clean, actor.id, t);
    return after;
  });
}

/**
 * Deletes a product nobody bought and no next-best-offer rule points at. Anything else is switched off instead,
 * so purchase history keeps its link.
 */
export async function deleteProduct(id: string, actor: AdminActor, tx: Tx = db): Promise<void> {
  assertAdmin(actor);
  if (!isUuid(id)) throw new AdminError("That product does not exist");
  return inTx(tx, async (t) => {
    const [p] = await t.select().from(products).where(eq(products.id, id)).limit(1).for("update");
    if (!p) throw new AdminError("That product does not exist");
    const [{ n }] = await t.select({ n: sql<number>`count(*)::int` }).from(purchases).where(eq(purchases.productId, id));
    if (Number(n) > 0) throw new AdminError(`${p.name} has ${n} purchase${Number(n) === 1 ? "" : "s"}. Switch it off instead.`);
    const s = await getSettings(["nbo.rules"], t);
    const rule = s["nbo.rules"].find((r) => r.productId === id);
    if (rule) throw new AdminError(`The offer rule "${rule.label}" uses ${p.name}. Change the rule first.`);
    await t.delete(products).where(eq(products.id, id));
    await audit({ table: "products", rowId: id, action: "delete", oldValue: p, userId: actor.id }, t);
  });
}

// ---------------------------------------------------------------------------
// Ladder
// ---------------------------------------------------------------------------

/** How many products and purchases use each family key (a family in use cannot be removed). */
export async function familyUsage(tx: Tx = db): Promise<Map<string, { products: number; purchases: number }>> {
  const p = await tx
    .select({ family: products.family, n: sql<number>`count(*)::int` })
    .from(products)
    .groupBy(products.family);
  const q = await tx
    .select({ family: purchases.family, n: sql<number>`count(*)::int` })
    .from(purchases)
    .groupBy(purchases.family);
  const out = new Map<string, { products: number; purchases: number }>();
  for (const r of p) out.set(r.family, { products: Number(r.n), purchases: 0 });
  for (const r of q) out.set(r.family, { products: out.get(r.family)?.products ?? 0, purchases: Number(r.n) });
  return out;
}

/**
 * Saves the rungs and the product families together (they depend on each other), then moves every product to
 * the rung of its family. A family that products or purchases use cannot be removed, and a rung a family sits on
 * cannot be removed. Returns how many products changed rung.
 */
export async function saveLadder(
  input: { rungs: unknown; families: unknown },
  actor: AdminActor,
  tx: Tx = db,
): Promise<{ productsMoved: number; warnings: string[] }> {
  assertAdmin(actor);
  const r = validateRungs(input.rungs);
  if (!r.ok) throw new AdminError(r.error);
  const f = validateFamilies(input.families, r.value);
  if (!f.ok) throw new AdminError(f.error);
  const rungs: Rung[] = r.value;
  const families: ProductFamily[] = f.value;
  return inTx(tx, async (t) => {
    const before = await getSettings(["ladder.families", "nbo.rules", "integrations.options"], t);
    const kept = new Set(families.map((x) => x.key));
    const removed = before["ladder.families"].filter((x) => !kept.has(x.key)).map((x) => x.key);
    // TagMango orders for a product not in the catalogue land in this family (Settings > Integrations)
    const fallback = before["integrations.options"].tagmangoDefaultFamily;
    if (fallback && removed.includes(fallback)) {
      const label = before["ladder.families"].find((x) => x.key === fallback)?.label ?? fallback;
      throw new AdminError(
        `${label} is where TagMango orders for unknown products go. Choose another family in Settings > Integrations first.`,
      );
    }
    if (removed.length) {
      const usage = await familyUsage(t);
      for (const key of removed) {
        const u = usage.get(key);
        if (u && (u.products || u.purchases)) {
          const label = before["ladder.families"].find((x) => x.key === key)?.label ?? key;
          throw new AdminError(
            `${label} is used by ${u.products} product${u.products === 1 ? "" : "s"} and ${u.purchases} purchase${u.purchases === 1 ? "" : "s"}, so it cannot be removed.`,
          );
        }
      }
    }
    await saveSettingAudited("ladder.rungs", rungs, actor, t);
    await saveSettingAudited("ladder.families", families, actor, t);
    const productsMoved = await syncProductRungs(families, t);
    const warnings: string[] = [];
    const ruleFamilies = new Set(
      before["nbo.rules"].flatMap((rule) => rule.when.flatMap((c) => ("values" in c && /family|families/.test(c.type) ? c.values : []))),
    );
    for (const key of removed) if (ruleFamilies.has(key)) warnings.push(`An offer rule still mentions the removed family "${key}".`);
    return { productsMoved, warnings };
  });
}

/** Puts every product on its family's rung. Returns how many products changed. */
export async function syncProductRungs(families: ProductFamily[], tx: Tx = db): Promise<number> {
  let moved = 0;
  for (const fam of families) {
    const rows = await tx
      .update(products)
      .set({ rung: fam.rung, updatedAt: new Date() })
      .where(and(eq(products.family, fam.key), sql`${products.rung} is distinct from ${fam.rung}`))
      .returning({ id: products.id });
    moved += rows.length;
  }
  return moved;
}

/** Products by id, for showing rule products and pickers. */
export async function productNames(ids: string[], tx: Tx = db): Promise<Map<string, string>> {
  const valid = ids.filter(isUuid);
  if (!valid.length) return new Map();
  const rows = await tx.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, valid));
  return new Map(rows.map((r) => [r.id, r.name]));
}

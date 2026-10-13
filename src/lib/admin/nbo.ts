import "server-only";
import { asc, eq } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { contacts, products } from "@/db/schema";
import type { NboFacts, NboProduct } from "@/lib/metrics/nbo";
import { getSetting, type NboRule } from "@/lib/settings";
import { isUuid } from "@/lib/utils";
import { AdminError } from "./errors";
import { assertAdmin, saveSettingAudited, type AdminActor } from "./settings";
import { validateNboRules } from "./validate";

/** Next best offer rules (Settings > Next best offer). */

/** The catalogue as the offer engine sees it. */
export async function nboProducts(tx: Tx = db): Promise<NboProduct[]> {
  const rows = await tx
    .select({
      id: products.id,
      name: products.name,
      family: products.family,
      rung: products.rung,
      listPrice: products.listPrice,
      currency: products.currency,
      active: products.active,
    })
    .from(products)
    .orderBy(asc(products.name));
  return rows.map((p) => ({ ...p, listPrice: Number(p.listPrice) }));
}

/** What the offer engine knows about one contact (its calculated columns), for the tester. Null when missing or merged. */
export async function nboFactsForContact(
  id: string,
  tx: Tx = db,
): Promise<{ id: string; name: string; nextOffer: string | null; facts: NboFacts } | null> {
  if (!isUuid(id)) return null;
  const [c] = await tx
    .select({
      id: contacts.id,
      name: contacts.name,
      mergedIntoId: contacts.mergedIntoId,
      nextOffer: contacts.nextOffer,
      purchaseCount: contacts.purchaseCount,
      families: contacts.families,
      currentRung: contacts.currentRung,
      industry: contacts.industry,
      aiLevel: contacts.aiLevel,
      fit: contacts.fit,
      country: contacts.country,
      phoneCountry: contacts.phoneCountry,
      tags: contacts.tags,
      firstDoor: contacts.firstDoor,
    })
    .from(contacts)
    .where(eq(contacts.id, id))
    .limit(1);
  if (!c || c.mergedIntoId) return null;
  return {
    id: c.id,
    name: c.name,
    nextOffer: c.nextOffer,
    facts: {
      purchaseCount: c.purchaseCount,
      families: c.families,
      currentRung: c.currentRung,
      industry: c.industry,
      aiLevel: c.aiLevel,
      fit: c.fit,
      country: c.country,
      phoneCountry: c.phoneCountry,
      tags: c.tags,
      firstDoor: c.firstDoor,
    },
  };
}

/** Validates and saves the ordered rule list (audited). */
export async function saveNboRules(input: unknown, actor: AdminActor, tx: Tx = db): Promise<{ changed: boolean; warnings: string[] }> {
  assertAdmin(actor);
  const catalogue = await tx.select({ id: products.id, name: products.name, active: products.active }).from(products);
  const families = (await getSetting("ladder.families", tx)).map((f) => f.key);
  const v = validateNboRules(input, {
    productIds: catalogue.map((p) => p.id),
    activeProductNames: catalogue.filter((p) => p.active).map((p) => p.name),
    families,
  });
  if (!v.ok) throw new AdminError(v.error);
  const rules: NboRule[] = v.value;
  const { changed } = await saveSettingAudited("nbo.rules", rules, actor, tx);
  return { changed, warnings: v.warnings };
}


import { notFound } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { Trash2 } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { db } from "@/db";
import { products, purchases } from "@/db/schema";
import { requireUser } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";
import { formatINR, isUuid } from "@/lib/utils";
import { FormSubmit, SettingsForm } from "../../_components/settings-form";
import { SettingsHeader } from "../../_components/settings-header";
import { deleteProductAction, updateProductAction } from "../actions";
import { ProductFields } from "../_components/product-fields";

export const metadata = { title: "Product" };

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser(["admin"]);
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [[product], [usage], s] = await Promise.all([
    db.select().from(products).where(eq(products.id, id)).limit(1),
    db
      .select({ n: sql<number>`count(*)::int`, inr: sql<number>`coalesce(sum(${purchases.amountInr}), 0)` })
      .from(purchases)
      .where(eq(purchases.productId, id)),
    getSettings(["ladder.families", "currency", "nbo.rules"]),
  ]);
  if (!product) notFound();
  const n = Number(usage.n);
  const currencies = [...new Set([...s.currency.enabled, product.currency])];
  const rule = s["nbo.rules"].find((r) => r.productId === id);

  return (
    <div className="mx-auto max-w-3xl">
      <SettingsHeader
        title={product.name}
        description={n ? `${n.toLocaleString("en-IN")} purchase${n === 1 ? "" : "s"} worth ${formatINR(Number(usage.inr))}.` : "No purchases yet."}
        backHref="/settings/products"
        backLabel="Products"
      />
      <div className="flex flex-col gap-5">
        <Card>
          <CardBody>
            <SettingsForm action={updateProductAction} aria-label="Product" inlineFieldErrors>
              <input type="hidden" name="id" value={product.id} />
              <ProductFields product={product} families={s["ladder.families"]} currencies={currencies} />
              <div className="mt-4">
                <FormSubmit pendingText="Saving…">Save product</FormSubmit>
              </div>
            </SettingsForm>
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Delete"
            description={
              n
                ? "Products with purchases are never deleted, so history keeps its link. Switch it off above instead."
                : rule
                  ? `The offer rule "${rule.label}" uses this product. Change the rule first.`
                  : "Nobody has bought it, so it can be deleted."
            }
          />
          {!n && !rule && (
            <CardBody>
              <SettingsForm action={deleteProductAction} confirm={`Delete ${product.name}? This cannot be undone.`} aria-label="Delete product">
                <input type="hidden" name="id" value={product.id} />
                <FormSubmit variant="danger" pendingText="Deleting…">
                  <Trash2 className="h-4 w-4" aria-hidden /> Delete product
                </FormSubmit>
              </SettingsForm>
            </CardBody>
          )}
        </Card>
      </div>
    </div>
  );
}

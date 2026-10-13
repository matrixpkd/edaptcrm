import Link from "next/link";
import { Plus } from "lucide-react";
import { FlashBanner } from "@/components/contacts/flash-banner";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader, EmptyState } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { familyUsage, listProducts } from "@/lib/admin/products";
import { requireUser } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";
import { formatMoney } from "@/lib/utils";
import { SettingsHeader } from "../_components/settings-header";
import { LadderEditor } from "./ladder-editor";

export const metadata = { title: "Products and ladder" };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ saved?: string; deleted?: string }> }) {
  await requireUser(["admin"]);
  const sp = await searchParams;
  const [rows, usage, s] = await Promise.all([listProducts(), familyUsage(), getSettings(["ladder.rungs", "ladder.families"])]);
  const families = s["ladder.families"];
  const famLabel = (k: string) => families.find((f) => f.key === k)?.label ?? k;

  return (
    <div className="mx-auto max-w-5xl">
      <SettingsHeader
        title="Products and ladder"
        description="Workshop buyers enter at rung 1; the CRM's job is to move them up. A product's rung comes from its family."
        actions={
          <ButtonLink href="/settings/products/new">
            <Plus className="h-4 w-4" aria-hidden /> Add product
          </ButtonLink>
        }
      />
      <div className="flex flex-col gap-5">
        {sp.saved && <FlashBanner param="saved" message="Product added." />}
        {sp.deleted && <FlashBanner param="deleted" message="Product deleted." />}
        <Card>
          <CardHeader title="Catalogue" description="Past purchases keep the name, family and price they were sold at." />
          {rows.length === 0 ? (
            <EmptyState title="No products yet" description="Add the products you sell so payments and next offers can use them." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Product</Th>
                  <Th className="hidden sm:table-cell">Family</Th>
                  <Th className="text-center">Rung</Th>
                  <Th className="text-right">List price</Th>
                  <Th className="hidden md:table-cell text-right">Purchases</Th>
                  <Th className="hidden md:table-cell">TagMango ids</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className={p.active ? "hover:bg-surface-muted/50" : "text-muted hover:bg-surface-muted/50"}>
                    <Td>
                      <Link href={`/settings/products/${p.id}`} className="font-medium text-foreground underline-offset-2 hover:underline">
                        {p.name}
                      </Link>
                      {!p.active && (
                        <Badge className="ml-2" tone="neutral">
                          Off
                        </Badge>
                      )}
                      <span className="block text-xs text-muted sm:hidden">{famLabel(p.family)}</span>
                    </Td>
                    <Td className="hidden sm:table-cell">{famLabel(p.family)}</Td>
                    <Td className="tabular text-center">{p.rung ?? "–"}</Td>
                    <Td className="tabular text-right whitespace-nowrap">{formatMoney(p.listPrice, p.currency)}</Td>
                    <Td className="hidden md:table-cell tabular text-right">{p.purchaseCount.toLocaleString("en-IN")}</Td>
                    <Td className="hidden md:table-cell max-w-48 truncate font-mono text-xs" title={p.externalIds.join(", ")}>
                      {p.externalIds.length ? p.externalIds.join(", ") : <span className="font-sans text-muted">–</span>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader title="Ladder" description="Rungs and product families. Moving a family to another rung moves its products too." />
          <CardBody>
            <LadderEditor rungs={s["ladder.rungs"]} families={families} usage={Object.fromEntries(usage)} />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

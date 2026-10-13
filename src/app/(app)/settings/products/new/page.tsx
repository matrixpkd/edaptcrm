import { Card, CardBody } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";
import { FormSubmit, SettingsForm } from "../../_components/settings-form";
import { SettingsHeader } from "../../_components/settings-header";
import { createProductAction } from "../actions";
import { ProductFields } from "../_components/product-fields";

export const metadata = { title: "Add product" };

export default async function NewProductPage() {
  await requireUser(["admin"]);
  const s = await getSettings(["ladder.families", "currency"]);
  return (
    <div className="mx-auto max-w-3xl">
      <SettingsHeader title="Add product" backHref="/settings/products" backLabel="Products" />
      <Card>
        <CardBody>
          <SettingsForm action={createProductAction} aria-label="New product" inlineFieldErrors>
            <ProductFields families={s["ladder.families"]} currencies={s.currency.enabled} />
            <div className="mt-4">
              <FormSubmit pendingText="Adding…">Add product</FormSubmit>
            </div>
          </SettingsForm>
        </CardBody>
      </Card>
    </div>
  );
}

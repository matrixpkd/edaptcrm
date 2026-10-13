import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import type { Product } from "@/db/schema";
import type { ProductFamily } from "@/lib/settings";
import { FieldError } from "../../_components/settings-form";

/** The product form's fields (inside a SettingsForm). The rung is not editable: it comes from the family. */
export function ProductFields({
  product,
  families,
  currencies,
}: {
  product?: Product | null;
  families: ProductFamily[];
  currencies: string[];
}) {
  const familyOptions = families.map((f) => ({
    value: f.key,
    label: f.rung ? `${f.label} (rung ${f.rung})` : `${f.label} (${f.group ?? "side group"})`,
  }));
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Name" htmlFor="name" required className="sm:col-span-2">
        <Input id="name" name="name" defaultValue={product?.name ?? ""} required maxLength={120} />
        <FieldError field="name" />
      </Field>
      <Field label="Family" htmlFor="family" required hint="Sets the ladder rung.">
        <Select id="family" name="family" defaultValue={product?.family ?? ""} placeholder="Choose a family" options={familyOptions} required />
        <FieldError field="family" />
      </Field>
      <div className="grid grid-cols-[1fr_7rem] gap-2">
        <Field label="List price" htmlFor="listPrice" required>
          <Input id="listPrice" name="listPrice" type="number" min={0} step="0.01" inputMode="decimal" defaultValue={product?.listPrice ?? ""} required />
          <FieldError field="listPrice" />
        </Field>
        <Field label="Currency" htmlFor="currency">
          <Select id="currency" name="currency" defaultValue={product?.currency ?? "INR"} options={currencies.map((c) => ({ value: c, label: c }))} />
          <FieldError field="currency" />
        </Field>
      </div>
      <Field
        label="TagMango ids"
        htmlFor="externalIds"
        className="sm:col-span-2"
        hint='One per line: a TagMango mango or product id, or a name pattern such as "Claude Mastery*". Orders that match become this product.'
      >
        <Textarea id="externalIds" name="externalIds" rows={3} defaultValue={(product?.externalIds ?? []).join("\n")} className="font-mono" />
        <FieldError field="externalIds" />
      </Field>
      <Field label="Description" htmlFor="description" className="sm:col-span-2" hint="Optional, for the team.">
        <Textarea id="description" name="description" rows={2} defaultValue={product?.description ?? ""} />
      </Field>
      <div className="sm:col-span-2">
        <Checkbox name="active" defaultChecked={product ? product.active : true} label="Active (offered on Record payment and in next offers)" />
      </div>
    </div>
  );
}

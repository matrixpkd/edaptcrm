"use client";
import { startTransition, useActionState, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Sparkles } from "lucide-react";
import { saveMappingAction } from "@/app/(app)/import/actions";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, FormMessage, Input, Select, type Option } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import {
  FIELD_INFO,
  TARGET_FIELDS,
  type ImportDefaults,
  type ImportSource,
  type TargetField,
} from "@/lib/import/types";
import { cn } from "@/lib/utils";

export type MappingColumn = { header: string; samples: string[]; field: TargetField };
export type ProductValue = { value: string; key: string; n: number; auto: string | null; choice: string };

const GROUPS = ["Person", "Labels", "Purchase", "Referral", "Other"];
const PAYMENT_MODE_OPTIONS: Option[] = [
  { value: "tagmango", label: "TagMango / online checkout" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "upi_qr", label: "UPI / QR" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

function FieldSelect({ id, value, onChange, label }: { id: string; value: TargetField; onChange: (v: TargetField) => void; label: string }) {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as TargetField)}
      className={cn(
        "h-10 w-full rounded-lg border bg-surface px-3 pr-8 text-sm focus:border-foreground focus:outline-none focus:ring-2 focus:ring-black/10",
        value === "ignore" ? "border-border text-muted" : "border-foreground/40 font-medium text-foreground",
      )}
    >
      {GROUPS.map((g) => (
        <optgroup key={g} label={g}>
          {TARGET_FIELDS.filter((f) => FIELD_INFO[f].group === g).map((f) => (
            <option key={f} value={f}>
              {f === "ignore" ? "Ignore this column" : FIELD_INFO[f].label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** Step 2: confirm the proposed column mapping and the defaults applied to every row. */
export function MappingForm({
  batchId,
  source,
  columns,
  mappingBy,
  mappingNote,
  defaults,
  options,
  productColumn,
  productValues,
}: {
  batchId: string;
  source: ImportSource;
  columns: MappingColumn[];
  mappingBy: "ai" | "heuristic";
  mappingNote: string | null;
  defaults: ImportDefaults;
  options: {
    firstDoors: Option[];
    campaigns: Option[];
    tags: string[];
    families: Option[];
    currencies: string[];
    owners: Option[];
    countries: Option[];
    products: Option[];
  };
  productColumn: string | null;
  productValues: ProductValue[];
}) {
  const [state, action, pending] = useActionState(saveMappingAction, null);
  const [fields, setFields] = useState<TargetField[]>(columns.map((c) => c.field));
  const [tags, setTags] = useState<string[]>(defaults.tags.filter((t) => options.tags.includes(t)));
  const extra = defaults.tags.filter((t) => !options.tags.includes(t)).join(", ");
  const tagmango = source === "tagmango";

  const hasIdentity = fields.includes("phone") || fields.includes("email");
  const mappedCount = fields.filter((f) => f !== "ignore").length;
  const currentProductColumn = useMemo(() => columns[fields.indexOf("product")]?.header ?? null, [columns, fields]);
  const hasAmount = fields.includes("amount");
  const hasOwner = fields.includes("owner");
  const hasEnquiryDate = fields.includes("enquired_at");
  const [ownerFromFile, setOwnerFromFile] = useState(!!defaults.ownerFromFile);

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        // dispatched by hand so a refused save keeps every choice on screen (a form action resets the form)
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
    >
      <input type="hidden" name="batchId" value={batchId} />

      <Card>
        <CardHeader
          title="Columns"
          description={`${mappedCount} of ${columns.length} columns will be imported. Every original value is kept with the row either way.`}
        />
        <CardBody className="space-y-3">
          <p
            className={cn(
              "flex items-start gap-2 rounded-lg px-3 py-2 text-xs",
              mappingBy === "ai" ? "bg-accent/10 text-accent" : "bg-surface-muted text-muted",
            )}
          >
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              {mappingBy === "ai" ? "Claude proposed this mapping from the headers and sample values." : "Keyword rules proposed this mapping."}
              {mappingNote ? ` ${mappingNote}.` : ""} Check each column before you continue.
            </span>
          </p>
          <div className="hidden grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(180px,0.8fr)] gap-3 border-b border-border pb-2 text-xs font-medium uppercase tracking-wide text-muted sm:grid">
            <span>Column in the file</span>
            <span>Sample values</span>
            <span>Imports as</span>
          </div>
          <ul className="divide-y divide-border">
            {columns.map((c, i) => (
              <li key={c.header} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(180px,0.8fr)] sm:items-center sm:gap-3">
                <label htmlFor={`col-${i}`} className="min-w-0 break-words text-sm font-medium">
                  {c.header}
                </label>
                <div className="flex min-w-0 flex-wrap gap-1">
                  {c.samples.length ? (
                    c.samples.slice(0, 4).map((s, j) => (
                      <span key={j} className="max-w-full truncate rounded-md bg-surface-muted px-1.5 py-0.5 text-xs text-foreground/80" title={s}>
                        {s}
                      </span>
                    ))
                  ) : (
                    <span className="text-xs text-muted">Empty in the first rows</span>
                  )}
                </div>
                <div>
                  <FieldSelect
                    id={`col-${i}`}
                    label={`Imports ${c.header} as`}
                    value={fields[i]}
                    onChange={(v) => setFields((prev) => prev.map((f, j) => (j === i ? v : f)))}
                  />
                  <input type="hidden" name={`col_${i}`} value={fields[i]} />
                </div>
              </li>
            ))}
          </ul>
          {!hasIdentity && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              Map a column to Phone or Email: a person is matched by phone first, then email.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Every row gets" description="Used when a row has no value of its own. Missing values are never guessed." />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="First door for new contacts" htmlFor="firstDoor" hint="Set once and never overwritten. Existing contacts keep theirs.">
            <Select id="firstDoor" name="firstDoor" defaultValue={defaults.firstDoor ?? ""} placeholder="Not known (Other, or Referral when referred)" options={options.firstDoors} />
          </Field>
          <Field label="Campaign or program" htmlFor="campaign">
            <Select id="campaign" name="campaign" defaultValue={defaults.campaign ?? ""} placeholder="None" options={options.campaigns} />
          </Field>
          <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
            <legend className="text-sm font-medium">Tags</legend>
            <div className="flex flex-wrap gap-2">
              {options.tags.map((t) => {
                const on = tags.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => setTags((prev) => (on ? prev.filter((x) => x !== t) : [...prev, t]))}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-sm font-medium max-md:py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on ? "border-foreground bg-foreground text-white" : "border-border bg-surface hover:bg-surface-muted",
                    )}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
            {tags.map((t) => (
              <input key={t} type="hidden" name="tags" value={t} />
            ))}
            <Input name="extraTags" defaultValue={extra} placeholder="Other tags, comma separated" aria-label="Other tags, comma separated" className="mt-1" />
            <Checkbox name="tagWithCampaign" defaultChecked={defaults.tagWithCampaign} label="Also tag each row with its campaign or program" className="mt-1" />
          </fieldset>
          <Field
            label="Owner when the file names none"
            htmlFor="ownerFallback"
            hint={hasOwner && ownerFromFile ? "Existing contacts keep their owner unless the file names one." : "Existing contacts keep their owner."}
          >
            <Select id="ownerFallback" name="ownerFallback" defaultValue={defaults.ownerFallback}>
              <option value="pool">Leave in the pool (unassigned)</option>
              <option value="round_robin">Round robin to the team (the usual auto-assignment)</option>
              {options.owners.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            {hasOwner ? (
              <Checkbox
                name="ownerFromFile"
                checked={ownerFromFile}
                onChange={(e) => setOwnerFromFile(e.target.checked)}
                label="The owner named in the file replaces the current owner of existing contacts"
                className="mt-2"
              />
            ) : (
              ownerFromFile && <input type="hidden" name="ownerFromFile" value="on" />
            )}
          </Field>
          <Field
            label="Date of these records"
            htmlFor="recordsDate"
            hint={
              hasEnquiryDate
                ? "For rows with no enquiry date of their own. Leave empty if not known."
                : "When these people were in touch (the program or event date). Without it, rows are dated today and look like fresh interest."
            }
          >
            <Input id="recordsDate" name="recordsDate" type="date" defaultValue={defaults.recordsDate ?? ""} />
          </Field>
          <Field label="Country for numbers without a code" htmlFor="defaultCountry" hint="UAE numbers written 05X… are still read as UAE.">
            <Select id="defaultCountry" name="defaultCountry" defaultValue={defaults.defaultCountry} options={options.countries} />
          </Field>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium">Dates like 03/04/2025 are</legend>
            <label className="inline-flex items-center gap-2 text-sm max-md:min-h-10">
              <input type="radio" name="dateOrder" value="day_first" defaultChecked={defaults.dayFirst} className="h-4 w-4 accent-black" />
              3 April (day first, Indian)
            </label>
            <label className="inline-flex items-center gap-2 text-sm max-md:min-h-10">
              <input type="radio" name="dateOrder" value="month_first" defaultChecked={!defaults.dayFirst} className="h-4 w-4 accent-black" />
              4 March (month first)
            </label>
          </fieldset>
          <Field label="Currency when none is written" htmlFor="currency">
            <Select id="currency" name="currency" defaultValue={defaults.currency} options={options.currencies.map((c) => ({ value: c, label: c }))} />
          </Field>
          {!hasAmount && (
            <>
              {/* kept as they are until the file has an amount column */}
              <input type="hidden" name="paymentMode" value={tagmango ? "tagmango" : defaults.paymentMode} />
              <input type="hidden" name="productFamily" value={defaults.productFamily ?? ""} />
              <input type="hidden" name="verified" value={tagmango || defaults.verified ? "on" : ""} />
            </>
          )}
          {hasAmount && (
            <>
              <Field label="Payment mode" htmlFor="paymentMode" hint={tagmango ? "TagMango orders are always TagMango payments." : undefined}>
                <Select id="paymentMode" name="paymentMode" defaultValue={tagmango ? "tagmango" : defaults.paymentMode} options={PAYMENT_MODE_OPTIONS} disabled={tagmango} />
                {tagmango && <input type="hidden" name="paymentMode" value="tagmango" />}
              </Field>
              <Field label="Product family for products not in the catalogue" htmlFor="productFamily">
                <Select id="productFamily" name="productFamily" defaultValue={defaults.productFamily ?? ""} placeholder="None: such rows need a choice below" options={options.families} />
              </Field>
              <div className="sm:col-span-2">
                <Checkbox
                  name="verified"
                  defaultChecked={tagmango || defaults.verified}
                  disabled={tagmango}
                  label="Payments in this file were received (count them as verified)"
                />
                {tagmango && <input type="hidden" name="verified" value="on" />}
                <p className="mt-1 text-xs text-muted">
                  {tagmango
                    ? "Every TagMango row is a real payment: it counts toward LTV, with the order id as its reference."
                    : "Unchecked, imported payments wait for a manager on the Payments desk and do not count toward LTV until verified."}
                </p>
              </div>
            </>
          )}
        </CardBody>
      </Card>

      {productColumn && hasAmount && (
        <Card>
          <CardHeader
            title="Products in this file"
            description={`From the column "${productColumn}". Matched to the catalogue by name; choose a product or family for the rest.`}
          />
          <CardBody>
            {currentProductColumn !== productColumn && (
              <p className="mb-3 text-xs text-warning">You changed the product column: save to refresh this list.</p>
            )}
            <ul className="divide-y divide-border">
              {productValues.map((p, i) => (
                <li key={p.key} className="grid gap-2 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.8fr)] sm:items-center">
                  <label htmlFor={`prod-${i}`} className="min-w-0 text-sm">
                    <span className="font-medium break-words">{p.value}</span>
                    <span className="text-muted"> · {p.n.toLocaleString("en-IN")} row{p.n === 1 ? "" : "s"}</span>
                  </label>
                  <input type="hidden" name={`prodKey_${i}`} value={p.key} />
                  <select
                    id={`prod-${i}`}
                    name={`prod_${i}`}
                    defaultValue={p.choice}
                    className="h-10 w-full rounded-lg border border-border bg-surface px-3 pr-8 text-sm focus:border-foreground focus:outline-none focus:ring-2 focus:ring-black/10"
                  >
                    <option value="">{p.auto ? `Catalogue: ${p.auto}` : "Default family (above)"}</option>
                    <optgroup label="Catalogue products">
                      {options.products.map((o) => (
                        <option key={o.value} value={`p:${o.value}`}>
                          {o.label}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Product family">
                      {options.families.map((o) => (
                        <option key={o.value} value={`f:${o.value}`}>
                          {o.label}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </li>
              ))}
            </ul>
            {productValues.length >= 150 && <p className="mt-2 text-xs text-muted">Showing the 150 most common products.</p>}
          </CardBody>
        </Card>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button type="submit" size="lg" disabled={!hasIdentity || pending} aria-busy={pending} className="w-full sm:w-auto">
          {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {pending ? "Saving…" : "Save and clean rows"}
        </Button>
        <p className="text-xs text-muted">Next, every row is cleaned and matched against the CRM. Nothing is imported until you commit.</p>
      </div>
      <FormMessage state={state && !state.ok ? state : null} />
    </form>
  );
}

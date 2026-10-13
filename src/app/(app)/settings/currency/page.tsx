import { Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { requireUser } from "@/lib/auth/session";
import { monthKeyOf } from "@/lib/money/fx";
import { getSetting } from "@/lib/settings";
import { FormSubmit, SettingsForm } from "../_components/settings-form";
import { SettingsHeader } from "../_components/settings-header";
import { addCurrencyAction, deleteRateAction, setRateAction, toggleCurrencyAction } from "./actions";

export const metadata = { title: "Currency" };

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}

export default async function CurrencyPage() {
  await requireUser(["admin"]);
  const cfg = await getSetting("currency");
  const thisMonth = monthKeyOf(new Date());
  const codes = [...new Set([...cfg.enabled.filter((c) => c !== "INR"), ...Object.keys(cfg.rates)])];

  return (
    <div className="mx-auto max-w-4xl">
      <SettingsHeader
        title="Currency"
        description="INR is the base. Each other currency has a rate per month: how many rupees one unit is worth. A payment uses the latest month at or before its date."
      />
      <div className="flex flex-col gap-5">
        <p className="rounded-xl border border-border bg-surface px-4 py-3 text-sm">
          <span className="font-medium">Saved payments keep their own rate.</span>{" "}
          <span className="text-muted">
            Editing or deleting a rate only affects payments entered from now on, so past LTV never shifts.
          </span>
        </p>

        <Card>
          <CardHeader
            title="Offered on payment forms"
            description="Switching a currency off hides it from new payments; nothing saved changes."
          />
          <ul className="divide-y divide-border">
            <li className="flex items-center gap-3 px-4 py-3">
              <span className="w-12 font-mono text-sm font-semibold">INR</span>
              <span className="flex-1 text-sm text-muted">Indian rupee, the base currency</span>
              <Badge tone="brand">Base</Badge>
            </li>
            {codes.map((c) => {
              const on = cfg.enabled.includes(c);
              const hasRates = Object.keys(cfg.rates[c] ?? {}).length > 0;
              return (
                <li key={c} className="px-4 py-3">
                  <SettingsForm action={toggleCurrencyAction} messageClassName="mt-2" aria-label={`${c} on or off`}>
                    <input type="hidden" name="currency" value={c} />
                    <input type="hidden" name="on" value={on ? "0" : "1"} />
                    <div className="flex items-center gap-3">
                      <span className="w-12 font-mono text-sm font-semibold">{c}</span>
                      <span className="flex-1 text-sm text-muted">
                        {hasRates
                          ? `${Object.keys(cfg.rates[c]).length} monthly rate${Object.keys(cfg.rates[c]).length === 1 ? "" : "s"}`
                          : "No rates yet"}
                      </span>
                      {on ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
                      <FormSubmit variant="outline" className="sm:h-8 sm:px-3" pendingText="…" disabled={!on && !hasRates}>
                        {on ? "Switch off" : "Switch on"}
                      </FormSubmit>
                    </div>
                  </SettingsForm>
                </li>
              );
            })}
          </ul>
        </Card>

        {codes.map((c) => {
          const months = Object.entries(cfg.rates[c] ?? {}).sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0));
          const current = months.find(([m]) => m <= thisMonth)?.[0] ?? months[months.length - 1]?.[0];
          return (
            <Card key={c} aria-labelledby={`rates-${c}`}>
              <CardHeader title={<span id={`rates-${c}`}>{c} rates</span>} description={`Rupees per 1 ${c}, by month.`} />
              {months.length > 0 && (
                <ul className="divide-y divide-border">
                  {months.map(([m, rate]) => (
                    <li key={m} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-2.5">
                      <div className="flex w-full items-center gap-2 pt-0 sm:w-36 sm:pt-2">
                        <span className="text-sm font-medium">{monthLabel(m)}</span>
                        {m === current && <Badge tone="info">In use</Badge>}
                      </div>
                      <SettingsForm
                        action={setRateAction}
                        className="min-w-0"
                        messageClassName="mt-1.5 max-w-xs"
                        aria-label={`${c} rate for ${monthLabel(m)}`}
                      >
                        <input type="hidden" name="currency" value={c} />
                        <input type="hidden" name="month" value={m} />
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-muted" aria-hidden>
                            ₹
                          </span>
                          <div className="w-32">
                            <Input
                              name="rate"
                              type="number"
                              step="0.000001"
                              min="0"
                              inputMode="decimal"
                              defaultValue={rate}
                              className="text-right tabular"
                              aria-label={`Rupees per ${c} in ${monthLabel(m)}`}
                            />
                          </div>
                          <FormSubmit variant="outline" className="sm:h-8 sm:px-3" pendingText="…">
                            Save
                          </FormSubmit>
                        </div>
                      </SettingsForm>
                      <SettingsForm
                        action={deleteRateAction}
                        confirm={`Delete the ${c} rate for ${monthLabel(m)}?`}
                        messageClassName="mt-1.5 max-w-xs"
                        aria-label={`Delete ${c} rate for ${monthLabel(m)}`}
                      >
                        <input type="hidden" name="currency" value={c} />
                        <input type="hidden" name="month" value={m} />
                        <FormSubmit
                          variant="ghost"
                          className="sm:h-8 sm:px-2"
                          pendingText="…"
                          aria-label={`Delete ${c} rate for ${monthLabel(m)}`}
                          title="Delete this rate"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </FormSubmit>
                      </SettingsForm>
                    </li>
                  ))}
                </ul>
              )}
              <CardBody className="border-t border-border">
                <SettingsForm action={setRateAction} aria-label={`Add a ${c} month`}>
                  <input type="hidden" name="currency" value={c} />
                  <div className="flex flex-wrap items-end gap-3">
                    <Field label="Month" htmlFor={`month-${c}`}>
                      <div className="w-44">
                        <Input id={`month-${c}`} name="month" type="month" defaultValue={thisMonth} required />
                      </div>
                    </Field>
                    <Field label={`Rupees per 1 ${c}`} htmlFor={`rate-${c}`}>
                      <div className="w-36">
                        <Input
                          id={`rate-${c}`}
                          name="rate"
                          type="number"
                          step="0.000001"
                          min="0"
                          inputMode="decimal"
                          className="text-right tabular"
                          required
                        />
                      </div>
                    </Field>
                    <FormSubmit variant="outline" pendingText="Adding…">
                      <Plus className="h-4 w-4" aria-hidden /> Add month
                    </FormSubmit>
                  </div>
                </SettingsForm>
              </CardBody>
            </Card>
          );
        })}

        <Card>
          <CardHeader title="Add a currency" description="For example USD for The AI Office pricing. It needs a first rate." />
          <CardBody>
            <SettingsForm action={addCurrencyAction} aria-label="Add a currency">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Code" htmlFor="new-currency" hint="Three letters">
                  <div className="w-24">
                    <Input
                      id="new-currency"
                      name="currency"
                      maxLength={3}
                      placeholder="USD"
                      className="font-mono uppercase"
                      autoCapitalize="characters"
                      required
                    />
                  </div>
                </Field>
                <Field label="Month" htmlFor="new-month" hint="First month">
                  <div className="w-44">
                    <Input id="new-month" name="month" type="month" defaultValue={thisMonth} required />
                  </div>
                </Field>
                <Field label="Rupees per 1 unit" htmlFor="new-rate" hint="e.g. 83.4">
                  <div className="w-36">
                    <Input
                      id="new-rate"
                      name="rate"
                      type="number"
                      step="0.000001"
                      min="0"
                      inputMode="decimal"
                      className="text-right tabular"
                      required
                    />
                  </div>
                </Field>
                <FormSubmit pendingText="Adding…">
                  <Plus className="h-4 w-4" aria-hidden /> Add currency
                </FormSubmit>
              </div>
            </SettingsForm>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

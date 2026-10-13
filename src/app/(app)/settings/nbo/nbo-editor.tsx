"use client";
import { useState } from "react";
import { ArrowDown, ArrowUp, Copy, Plus, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import {
  NBO_CONDITION_META,
  NBO_CONDITION_TYPES,
  REGION_LABELS,
  blankCondition,
  slugKey,
  type NboConditionType,
} from "@/lib/admin/meta";
import { previewNbo } from "@/lib/admin/nbo-preview";
import { validateNboRules } from "@/lib/admin/validate";
import type { NboFacts, NboProduct } from "@/lib/metrics/nbo";
import type { CurrencyConfig, ListItem, NboCondition, NboRule, ProductFamily, Rung } from "@/lib/settings/defaults";
import { cn, formatINR } from "@/lib/utils";
import { JsonSaveForm } from "../_components/json-save-form";
import { RecalcButton } from "../_components/recalc-button";
import { recalcScoresChunkAction } from "../actions";
import { saveNboAction } from "./actions";

type Options = {
  firstDoors: ListItem[];
  tags: ListItem[];
  industries: ListItem[];
  families: ProductFamily[];
  rungs: Rung[];
  products: NboProduct[];
  currency: CurrencyConfig;
  gccCountries: string[];
};

export type TesterContact = { id: string; name: string; nextOffer: string | null; facts: NboFacts };

/** Editable rule (prices and numbers may be half-typed strings while editing). */
type DraftRule = Omit<NboRule, "price"> & { price?: number | string | null };

function newId(label: string) {
  return `${slugKey(label) || "rule"}_${Math.random().toString(36).slice(2, 7)}`;
}

function valueOptions(source: string, o: Options): { value: string; label: string }[] {
  switch (source) {
    case "firstDoors":
      return o.firstDoors.map((i) => ({ value: i.key, label: i.label }));
    case "tags":
      return o.tags.map((i) => ({ value: i.key, label: i.label }));
    case "industries":
      return o.industries.map((i) => ({ value: i.key, label: i.label }));
    case "families":
      return o.families.map((f) => ({ value: f.key, label: f.label }));
    default:
      return [];
  }
}

/** Comma-separated country codes; keeps what is typed (commas, spaces) and reports the parsed codes. */
function CountriesInput({ values, label, onChange }: { values: string[]; label: string; onChange: (v: string[]) => void }) {
  const [raw, setRaw] = useState(values.join(", "));
  return (
    <div className="min-w-40 flex-1">
      <Input
        value={raw}
        placeholder="AE, SA"
        aria-label={label}
        className="uppercase"
        onChange={(e) => {
          setRaw(e.target.value);
          onChange(
            e.target.value
              .split(/[\s,;]+/)
              .map((x) => x.trim().toUpperCase())
              .filter(Boolean),
          );
        }}
      />
    </div>
  );
}

function ConditionInput({ c, onChange, o }: { c: NboCondition; onChange: (c: NboCondition) => void; o: Options }) {
  const meta = NBO_CONDITION_META[c.type];
  const input = meta.input;
  if (input.kind === "none") return null;
  if (input.kind === "number" && "value" in c) {
    return (
      <div className="w-24">
        <Input
          type="number"
          min={input.min}
          max={input.max}
          step={1}
          value={String(c.value)}
          aria-label={meta.label}
          className="text-right tabular"
          onChange={(e) =>
            onChange({ ...c, value: e.target.value === "" ? ("" as unknown as number) : Number(e.target.value) } as NboCondition)
          }
        />
      </div>
    );
  }
  if (input.kind === "rung" && "value" in c) {
    return (
      <div className="max-w-full">
        <Select
          value={String(c.value)}
          aria-label={meta.label}
          onChange={(e) => onChange({ ...c, value: Number(e.target.value) } as NboCondition)}
        >
          <option value="0">0: nothing on the ladder</option>
          {o.rungs.map((r) => (
            <option key={r.rung} value={r.rung}>
              {r.rung}: {r.label}
            </option>
          ))}
        </Select>
      </div>
    );
  }
  if (input.kind === "region" && c.type === "region_is") {
    return (
      <div>
        <Select
          value={c.value}
          aria-label={meta.label}
          onChange={(e) => onChange({ type: "region_is", value: e.target.value as "gcc" | "india" | "rest_of_world" })}
        >
          {Object.entries(REGION_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </Select>
      </div>
    );
  }
  if (input.kind === "values" && "values" in c) {
    if (input.source === "countries") {
      return (
        <CountriesInput
          values={c.values}
          label={`${meta.label} (country codes)`}
          onChange={(values) => onChange({ ...c, values } as NboCondition)}
        />
      );
    }
    const opts = valueOptions(input.source, o);
    const unknown = c.values.filter((v) => !opts.some((x) => x.value === v));
    return (
      <div className="flex basis-full flex-wrap gap-1.5 sm:flex-1 sm:basis-0" role="group" aria-label={meta.label}>
        {[...opts, ...unknown.map((v) => ({ value: v, label: `${v} (not in list)` }))].map((opt) => {
          const on = c.values.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onChange({
                  ...c,
                  values: on ? c.values.filter((v) => v !== opt.value) : [...c.values, opt.value],
                } as NboCondition)
              }
              className={cn(
                "min-h-10 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0",
                on ? "border-foreground bg-foreground text-white" : "border-border bg-surface hover:bg-surface-muted",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    );
  }
  return null;
}

export function NboEditor({
  initial,
  options,
  tester,
  testerSearch,
}: {
  initial: NboRule[];
  options: Options;
  tester: TesterContact | null;
  /** the server-rendered contact search for the tester */
  testerSearch: React.ReactNode;
}) {
  const [saved, setSaved] = useState<NboRule[]>(initial);
  const [rules, setRules] = useState<DraftRule[]>(initial);
  const [justSaved, setJustSaved] = useState(false);
  const [addType, setAddType] = useState<Record<string, NboConditionType>>({});
  const [now] = useState(() => new Date());

  const check = validateNboRules(rules, {
    productIds: options.products.map((p) => p.id),
    activeProductNames: options.products.filter((p) => p.active).map((p) => p.name),
    families: options.families.map((f) => f.key),
  });
  const dirty = JSON.stringify(rules) !== JSON.stringify(saved);
  const preview = tester && check.ok ? previewNbo(tester.facts, check.value, { ...options, now }) : null;

  const update = (fn: (r: DraftRule[]) => DraftRule[]) => {
    setRules(fn);
    setJustSaved(false);
  };
  const patch = (i: number, p: Partial<DraftRule>) => update((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, d: -1 | 1) =>
    update((r) => {
      const j = i + d;
      if (j < 0 || j >= r.length) return r;
      const next = [...r];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const productOptions = options.products.map((p) => ({ value: p.id, label: `${p.name}${p.active ? "" : " (off)"}` }));
  const familyOptions = options.families.map((f) => ({
    value: f.key,
    label: `${f.label}${f.rung !== null ? ` (rung ${f.rung})` : f.group ? ` (${f.group})` : ""}`,
  }));
  const activeNames = [...new Set(options.products.filter((p) => p.active).map((p) => p.name))];

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-sm text-muted">
          Checked from the top: the first switched-on rule whose conditions all hold gives the offer.
        </p>
        <ol className="flex flex-col gap-3">
          {rules.map((rule, i) => {
            const off = rule.active === false;
            const fires = preview?.winner === i;
            const matches = preview?.matches[i];
            const type = addType[rule.id] ?? "bought_family";
            return (
              <li key={rule.id}>
                <Card className={cn(off && "opacity-70", fires && "ring-2 ring-foreground")}>
                  <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                    <span
                      className="flex h-6 min-w-6 items-center justify-center rounded-full bg-surface-muted px-1.5 text-xs font-semibold tabular"
                      aria-label={`Rule ${i + 1}`}
                    >
                      {i + 1}
                    </span>
                    <div className="order-last min-w-0 basis-full sm:order-none sm:flex-1 sm:basis-0">
                      <Input
                        value={rule.label}
                        onChange={(e) => patch(i, { label: e.target.value })}
                        aria-label={`Rule ${i + 1} name`}
                        className="h-9 font-medium"
                      />
                    </div>
                    {fires && <Badge tone="brand">Fires for {tester?.name}</Badge>}
                    {!fires && matches && <Badge tone="neutral">Also matches</Badge>}
                    <label className="flex min-h-10 items-center gap-1.5 px-1 text-xs font-medium sm:min-h-0">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-black"
                        aria-label={`Rule ${i + 1} switched on`}
                        checked={!off}
                        onChange={(e) => patch(i, { active: e.target.checked ? undefined : false })}
                      />
                      On
                    </label>
                    <div className="flex items-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-10 w-10 sm:h-8 sm:w-8"
                        aria-label={`Move rule ${i + 1} up`}
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                      >
                        <ArrowUp className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-10 w-10 sm:h-8 sm:w-8"
                        aria-label={`Move rule ${i + 1} down`}
                        disabled={i === rules.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDown className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-10 w-10 sm:h-8 sm:w-8"
                        aria-label={`Duplicate rule ${i + 1}`}
                        onClick={() =>
                          update((r) => [
                            ...r.slice(0, i + 1),
                            { ...structuredClone(rule), id: newId(rule.label), label: `${rule.label} (copy)` },
                            ...r.slice(i + 1),
                          ])
                        }
                      >
                        <Copy className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-10 w-10 sm:h-8 sm:w-8"
                        aria-label={`Delete rule ${i + 1}`}
                        onClick={() => {
                          if (window.confirm(`Delete the rule "${rule.label}"?`)) update((r) => r.filter((_, j) => j !== i));
                        }}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                  </div>
                  <CardBody className="flex flex-col gap-3">
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-muted">When all of these hold</p>
                      {rule.when.length === 0 && (
                        <p className="text-sm text-muted">No conditions: matches everyone who reaches it.</p>
                      )}
                      <ul className="flex flex-col gap-2">
                        {rule.when.map((c, ci) => (
                          <li key={ci} className="relative flex min-h-12 flex-wrap items-center gap-2 rounded-lg bg-surface-muted/60 py-1.5 pl-2 pr-12 sm:min-h-11 sm:pr-10">
                            <span className="text-sm font-medium">{NBO_CONDITION_META[c.type]?.label ?? c.type}</span>
                            <ConditionInput
                              c={c}
                              o={options}
                              onChange={(next) => patch(i, { when: rule.when.map((x, k) => (k === ci ? next : x)) })}
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="absolute right-1 top-1 h-10 w-10 sm:top-1.5 sm:h-8 sm:w-8"
                              aria-label={`Remove condition ${ci + 1} of rule ${i + 1}`}
                              onClick={() => patch(i, { when: rule.when.filter((_, k) => k !== ci) })}
                            >
                              <X className="h-4 w-4" aria-hidden />
                            </Button>
                          </li>
                        ))}
                      </ul>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <div className="min-w-0 max-w-full">
                          <Select
                            value={type}
                            aria-label={`Condition to add to rule ${i + 1}`}
                            className="h-9"
                            onChange={(e) => setAddType((a) => ({ ...a, [rule.id]: e.target.value as NboConditionType }))}
                          >
                            {NBO_CONDITION_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {NBO_CONDITION_META[t].label}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => patch(i, { when: [...rule.when, blankCondition(type)] })}
                        >
                          <Plus className="h-3.5 w-3.5" aria-hidden /> Add condition
                        </Button>
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[1.5fr_1fr_8rem]">
                      <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                        Offer shown to the salesperson
                        <Input value={rule.offer} onChange={(e) => patch(i, { offer: e.target.value })} />
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                        Product (optional)
                        <Select
                          value={rule.productId ?? ""}
                          onChange={(e) => patch(i, { productId: e.target.value || null })}
                          placeholder="None"
                          options={productOptions}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                        Price, ₹ (optional)
                        <Input
                          type="number"
                          min={0}
                          step="1"
                          inputMode="decimal"
                          value={rule.price === null || rule.price === undefined ? "" : String(rule.price)}
                          onChange={(e) => patch(i, { price: e.target.value === "" ? null : e.target.value })}
                          className="text-right tabular"
                        />
                      </label>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                        Or a product by name (optional)
                        <Input
                          value={rule.productName ?? ""}
                          list="nbo-product-names"
                          placeholder="e.g. AI Agents for Business"
                          autoComplete="off"
                          onChange={(e) => patch(i, { productName: e.target.value || undefined })}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                        Or the cheapest in a family (optional)
                        <Select
                          value={rule.family ?? ""}
                          onChange={(e) => patch(i, { family: e.target.value || undefined })}
                          placeholder="None"
                          options={familyOptions}
                        />
                      </label>
                    </div>
                  </CardBody>
                </Card>
              </li>
            );
          })}
        </ol>
        <div>
          <Button
            variant="outline"
            onClick={() =>
              update((r) => [...r, { id: newId("rule"), label: "New rule", when: [], offer: "", productId: null, price: null }])
            }
          >
            <Plus className="h-4 w-4" aria-hidden /> Add rule
          </Button>
        </div>
        <datalist id="nbo-product-names">
          {activeNames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <p className="text-xs text-muted">
          Price for the 90-day forecast: the rule&apos;s price, else its product&apos;s list price, else the active product
          with that name, else the cheapest active product in its family, else the cheapest active product on the rung
          above the customer. The product found also sets the next rung on the contact page.
        </p>
        {/* phones: the tester and the save button sit at the end, so keep the result and a way there in view */}
        <div className="sticky bottom-20 z-20 flex items-center gap-2 rounded-xl border border-border bg-surface/95 p-2 text-xs shadow-lg backdrop-blur lg:hidden">
          <span className="min-w-0 flex-1 truncate">
            {!check.ok
              ? "Fix the highlighted rule to save"
              : preview
                ? preview.offer
                  ? `Rule ${preview.winner + 1} fires for ${tester?.name}`
                  : `No rule fires for ${tester?.name}`
                : dirty
                  ? "Unsaved changes"
                  : "Pick a contact in the tester to try the rules"}
          </span>
          <a href="#nbo-save" className="shrink-0 rounded-lg px-2 py-1 font-semibold underline-offset-2 hover:underline">
            {dirty ? "Save…" : "Tester"}
          </a>
        </div>
      </div>

      <aside id="nbo-save" className="flex scroll-mt-20 flex-col gap-4 lg:sticky lg:top-6 lg:self-start" aria-label="Tester and save">
        <Card>
          <CardHeader title="Tester" description="Pick a contact to see which rule fires, with your unsaved changes." />
          <CardBody className="flex flex-col gap-3">
            {testerSearch}
            {tester && (
              <div className="rounded-lg border border-border p-3 text-sm" role="status" aria-live="polite">
                <p className="font-semibold">{tester.name}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {tester.facts.purchaseCount} purchase{tester.facts.purchaseCount === 1 ? "" : "s"}
                  {tester.facts.families.length
                    ? ` (${tester.facts.families.map((f) => options.families.find((x) => x.key === f)?.label ?? f).join(", ")})`
                    : ""}{" "}
                  · rung {tester.facts.currentRung} · Fit {tester.facts.fit ?? "–"} · AI {tester.facts.aiLevel ?? "–"}
                  {tester.facts.tags.length ? ` · ${tester.facts.tags.join(", ")}` : ""}
                </p>
                {!check.ok ? (
                  <p className="mt-2 text-xs text-danger">Fix the rules to test them: {check.error}</p>
                ) : preview?.offer ? (
                  <div className="mt-2">
                    <p className="text-xs text-muted">Rule {preview.winner + 1} fires:</p>
                    <p className="font-medium">{preview.offer.offer}</p>
                    <p className="text-xs text-muted">
                      {preview.offer.priceInr !== null
                        ? `Priced at ${formatINR(preview.offer.priceInr)}`
                        : "No price: it adds nothing to the forecast"}
                      {preview.offer.productId
                        ? ` · ${options.products.find((p) => p.id === preview.offer!.productId)?.name ?? ""}`
                        : ""}
                    </p>
                  </div>
                ) : (
                  <p className="mt-2 text-sm">No rule fires: no offer is shown.</p>
                )}
                <p className="mt-2 border-t border-border pt-2 text-xs text-muted">
                  Saved offer now: {tester.nextOffer ?? "none"}
                </p>
              </div>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardBody className="flex flex-col gap-3">
            {!check.ok ? (
              <p role="alert" className="text-sm text-danger">
                {check.error}
              </p>
            ) : (
              check.warnings.map((w) => (
                <p key={w} className="text-xs text-warning">
                  {w}
                </p>
              ))
            )}
            <JsonSaveForm
              action={saveNboAction}
              value={check.ok ? check.value : rules}
              dirty={dirty}
              disabled={!check.ok || !dirty}
              submitLabel="Save rules"
              onSaved={() => {
                if (check.ok) {
                  setSaved(check.value);
                  setRules(check.value);
                }
                setJustSaved(true);
              }}
            />
            {justSaved && <RecalcButton action={recalcScoresChunkAction} hint="" />}
          </CardBody>
        </Card>
      </aside>
    </div>
  );
}

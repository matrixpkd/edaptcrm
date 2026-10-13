"use client";
import { createContext, useContext, useRef, useState } from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { GradeBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { scoreExamples } from "@/lib/admin/scoring-examples";
import { scoringMaxTotals, validateScoring } from "@/lib/admin/validate";
import { DEFAULT_SETTINGS, type ListItem, type LocationConfig, type ScoringConfig } from "@/lib/settings/defaults";
import { cn } from "@/lib/utils";
import { JsonSaveForm } from "../_components/json-save-form";
import { RecalcButton } from "../_components/recalc-button";
import { recalcScoresChunkAction } from "../actions";
import { saveScoringAction } from "./actions";

type Path = (string | number)[];
type Leaf = number | string;

function getAt(o: unknown, path: Path): unknown {
  let cur: unknown = o;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/** Immutable set: copies every object or array on the path. */
function setAt<T>(o: T, path: Path, v: unknown): T {
  if (!path.length) return v as T;
  const [k, ...rest] = path;
  const src = (o ?? (typeof k === "number" ? [] : {})) as Record<string | number, unknown>;
  const copy = (Array.isArray(src) ? [...src] : { ...src }) as Record<string | number, unknown>;
  copy[k] = setAt(src[k], rest, v);
  return copy as T;
}

function removeAt<T>(o: T, path: Path, index: number): T {
  const list = getAt(o, path) as unknown[];
  return setAt(
    o,
    path,
    list.filter((_, i) => i !== index),
  );
}

const n = (v: unknown) => {
  const x = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(x) ? x : 0;
};
const maxOf = (vals: unknown[]) => (vals.length ? Math.max(...vals.map(n)) : 0);

const LOCATION_LABELS: [keyof ScoringConfig["fit"]["location"], string][] = [
  ["gcc", "GCC"],
  ["rest_of_world", "Rest of the world"],
  ["kerala_city_or_metro", "Kerala cities and Indian metros"],
  ["rest_of_kerala", "Rest of Kerala"],
  ["rest_of_india", "Rest of India"],
  ["unknown", "Unknown"],
];
const BAND_LABELS: [string, string][] = [
  ["1", "1 Low"],
  ["2", "2 Lower-middle"],
  ["3", "3 Middle"],
  ["4", "4 Upper-middle"],
  ["5", "5 High"],
  ["unknown", "Unknown"],
];
const AI_LABELS: [string, string][] = [
  ["0", "0 Never used AI"],
  ["1", "1 Tried a few times"],
  ["2", "2 Now and then"],
  ["3", "3 Every week"],
  ["4", "4 Power user"],
  ["5", "5 Builds with AI"],
  ["unknown", "Unknown"],
];
const GUT_LABELS: [string, string][] = [
  ["1", "1 star"],
  ["2", "2 stars"],
  ["3", "3 stars"],
  ["4", "4 stars"],
  ["5", "5 stars"],
  ["unrated", "Unrated"],
];

type EditorCtx = {
  draft: ScoringConfig;
  set: (path: Path, v: Leaf) => void;
  update: (fn: (d: ScoringConfig) => ScoringConfig) => void;
};
const Ctx = createContext<EditorCtx>({ draft: DEFAULT_SETTINGS.scoring, set: () => {}, update: () => {} });

function Num({
  path,
  label,
  step = 1,
  min = 0,
  className,
  allowEmpty,
}: {
  path: Path;
  label: string;
  step?: number;
  min?: number;
  className?: string;
  /** an empty value is allowed (falls back to "unknown") */
  allowEmpty?: boolean;
}) {
  const { draft, set } = useContext(Ctx);
  const v = getAt(draft, path);
  const empty = v === "" || v === undefined || v === null;
  const bad = empty ? !allowEmpty : !Number.isFinite(Number(v)) || Number(v) < min;
  return (
    <input
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      value={v === undefined || v === null ? "" : String(v)}
      onChange={(e) => set(path, e.target.value === "" ? "" : e.target.value)}
      aria-label={label}
      aria-invalid={bad}
      className={cn(
        "h-10 rounded-md border bg-surface px-2 text-right text-sm tabular focus:border-foreground focus:outline-none focus:ring-2 focus:ring-black/10 sm:h-9",
        bad ? "border-danger" : "border-border",
        // width: the caller's, else the default (two width classes would fight, cn does not merge)
        className ?? "w-20",
      )}
    />
  );
}

/** key -> points; `open` tables (industry, age band) may leave a key empty to use "unknown". */
function PointsTable({
  title,
  path,
  rows,
  open,
  hint,
}: {
  title: string;
  path: Path;
  rows: [string, string][];
  open?: boolean;
  hint?: string;
}) {
  const { draft } = useContext(Ctx);
  const table = (getAt(draft, path) ?? {}) as Record<string, Leaf>;
  const max = maxOf(Object.values(table).filter((x) => x !== ""));
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold">{title}</h4>
        <span className="tabular text-xs text-muted">max {max}</span>
      </div>
      {hint && <p className="-mt-1 mb-2 text-xs text-muted">{hint}</p>}
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([key, label]) => {
            const empty = open && key !== "unknown" && (table[key] === undefined || table[key] === "");
            return (
              <tr key={key} className="border-b border-border last:border-0">
                <td className="py-1.5 pr-2">
                  {label}
                  {empty && <span className="ml-1 text-xs text-muted">(uses unknown)</span>}
                </td>
                <td className="w-24 py-1.5 text-right">
                  <Num path={[...path, key]} label={`${title}: ${label}`} allowEmpty={open && key !== "unknown"} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Threshold rows ("within N days", "below ₹N", "at least N") plus an optional fallback row. */
function RowsTable({
  title,
  path,
  field,
  describe,
  fallback,
  max,
  blank,
}: {
  title: string;
  path: Path;
  field: "withinDays" | "below" | "min";
  describe: (input: React.ReactNode) => React.ReactNode;
  fallback?: { label: string; path: Path };
  max: number;
  blank: Record<string, number>;
}) {
  const { draft, update } = useContext(Ctx);
  const rows = (getAt(draft, path) ?? []) as Record<string, Leaf>[];
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold">{title}</h4>
        <span className="tabular text-xs text-muted">max {max}</span>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((_, i) => (
            <tr key={i} className="border-b border-border">
              <td className="whitespace-nowrap py-1.5 pr-2">
                {describe(
                  <Num
                    path={[...path, i, field]}
                    label={`${title} row ${i + 1} threshold`}
                    className={field === "below" ? "w-[5.5rem]" : "w-16 sm:w-[5.5rem]"}
                    min={field === "withinDays" ? 0 : 1}
                  />,
                )}
              </td>
              <td className="w-20 py-1.5 text-right sm:w-24">
                <Num path={[...path, i, "points"]} label={`${title} row ${i + 1} points`} className="w-16 sm:w-20" />
              </td>
              <td className="w-11 py-1.5 text-right sm:w-9">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 sm:h-8 sm:w-8"
                  aria-label={`Remove ${title} row ${i + 1}`}
                  onClick={() => update((d) => removeAt(d, path, i))}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </td>
            </tr>
          ))}
          {fallback && (
            <tr>
              <td className="py-1.5 pr-2 text-muted">{fallback.label}</td>
              <td className="w-24 py-1.5 text-right">
                <Num path={fallback.path} label={`${title}: ${fallback.label}`} className="w-16 sm:w-20" />
              </td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
      <Button variant="ghost" size="sm" className="mt-1" onClick={() => update((d) => setAt(d, path, [...rows, blank]))}>
        <Plus className="h-3.5 w-3.5" aria-hidden /> Add row
      </Button>
    </div>
  );
}

export function ScoringEditor({
  initial,
  industries,
  ageBands,
  locations,
  gccCountries,
}: {
  initial: ScoringConfig;
  industries: ListItem[];
  ageBands: ListItem[];
  locations: LocationConfig;
  gccCountries: string[];
}) {
  const [saved, setSaved] = useState<ScoringConfig>(initial);
  const [draft, setDraft] = useState<ScoringConfig>(initial);
  const [justSaved, setJustSaved] = useState(false);
  const [now] = useState(() => new Date());
  const lastGood = useRef<ScoringConfig>(initial);

  const lists = { industries: industries.map((i) => i.key), ageBands: ageBands.map((i) => i.key) };
  const check = validateScoring(draft, lists);
  if (check.ok) lastGood.current = check.value;
  const cfg = lastGood.current;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const totals = scoringMaxTotals(cfg);
  const preview = scoreExamples(cfg, { locations, gccCountries }, now);
  const isDefault = JSON.stringify(draft) === JSON.stringify(DEFAULT_SETTINGS.scoring);

  const update = (fn: (d: ScoringConfig) => ScoringConfig) => {
    setDraft(fn);
    setJustSaved(false);
  };
  const set = (path: Path, v: Leaf) => update((d) => setAt(d, path, v));

  const industryRows: [string, string][] = [
    ...industries.map((i): [string, string] => [i.key, i.label + (i.active === false ? " (off)" : "")]),
    ...Object.keys(draft.fit.industry)
      .filter((k) => k !== "unknown" && !industries.some((i) => i.key === k))
      .map((k): [string, string] => [k, `${k} (not in the list)`]),
    ["unknown", "Unknown"],
  ];
  const ageRows: [string, string][] = [
    ...ageBands.map((i): [string, string] => [i.key, i.label + (i.active === false ? " (off)" : "")]),
    ...Object.keys(draft.fit.ageBand)
      .filter((k) => k !== "unknown" && !ageBands.some((i) => i.key === k))
      .map((k): [string, string] => [k, `${k} (not in the list)`]),
    ["unknown", "Unknown"],
  ];
  const leadSum = n(draft.blend.lead.fit) + n(draft.blend.lead.readiness);
  const custSum = n(draft.blend.customer.fit) + n(draft.blend.customer.readiness) + n(draft.blend.customer.value);
  const r = cfg.readiness;
  const v = cfg.value;

  return (
    <Ctx.Provider value={{ draft, set, update }}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <Card>
            <CardHeader
              title="Edapt Score and grade"
              description="Leads are judged on Fit and Readiness; once someone pays, Value carries its share. G is the gut adjustment."
            />
            <CardBody className="grid gap-6 md:grid-cols-2">
              <div>
                <h4 className="mb-2 text-sm font-semibold">Blend weights</h4>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted">
                      <th className="pb-1 text-left font-medium" />
                      <th className="pb-1 text-right font-medium">Fit</th>
                      <th className="pb-1 text-right font-medium">Readiness</th>
                      <th className="pb-1 text-right font-medium">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-border">
                      <td className="py-1.5">
                        Lead{" "}
                        <span className={cn("block text-xs", Math.abs(leadSum - 1) < 0.001 ? "text-muted" : "text-warning")}>
                          sum {Math.round(leadSum * 1000) / 1000}
                        </span>
                      </td>
                      <td className="py-1.5 text-right">
                        <Num path={["blend", "lead", "fit"]} label="Lead weight for Fit" step={0.05} className="w-16" />
                      </td>
                      <td className="py-1.5 text-right">
                        <Num
                          path={["blend", "lead", "readiness"]}
                          label="Lead weight for Readiness"
                          step={0.05}
                          className="w-16"
                        />
                      </td>
                      <td className="py-1.5 text-right text-muted">–</td>
                    </tr>
                    <tr>
                      <td className="py-1.5">
                        Customer{" "}
                        <span className={cn("block text-xs", Math.abs(custSum - 1) < 0.001 ? "text-muted" : "text-warning")}>
                          sum {Math.round(custSum * 1000) / 1000}
                        </span>
                      </td>
                      <td className="py-1.5 text-right">
                        <Num path={["blend", "customer", "fit"]} label="Customer weight for Fit" step={0.05} className="w-16" />
                      </td>
                      <td className="py-1.5 text-right">
                        <Num
                          path={["blend", "customer", "readiness"]}
                          label="Customer weight for Readiness"
                          step={0.05}
                          className="w-16"
                        />
                      </td>
                      <td className="py-1.5 text-right">
                        <Num
                          path={["blend", "customer", "value"]}
                          label="Customer weight for Value"
                          step={0.05}
                          className="w-16"
                        />
                      </td>
                    </tr>
                  </tbody>
                </table>
                <h4 className="mb-2 mt-5 text-sm font-semibold">Grade cut-offs</h4>
                <table className="w-full text-sm">
                  <tbody>
                    {(["A", "B", "C"] as const).map((g) => (
                      <tr key={g} className="border-b border-border">
                        <td className="py-1.5">
                          <GradeBadge grade={g} size="sm" /> <span className="ml-1">from</span>
                        </td>
                        <td className="py-1.5 text-right">
                          <Num path={["grades", g]} label={`Grade ${g} from`} />
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className="py-1.5 text-muted">
                        <GradeBadge grade="D" size="sm" /> <span className="ml-1">below C</span>
                      </td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
              <div>
                <h4 className="mb-2 text-sm font-semibold">Gut adjustment (G)</h4>
                <table className="w-full text-sm">
                  <tbody>
                    {GUT_LABELS.map(([k, label]) => (
                      <tr key={k} className="border-b border-border last:border-0">
                        <td className="py-1.5">{label}</td>
                        <td className="py-1.5 text-right">
                          <Num path={["gut", k]} label={`Gut points for ${label}`} min={-100} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-muted">
                  Points added to the Edapt Score; may be negative. The result is held between 0 and 100.
                </p>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={`Fit: who they are (max ${totals.fit})`}
              description="Spending power + industry + age band + location."
            />
            <CardBody className="grid gap-6 md:grid-cols-2">
              <PointsTable title="Spending power" path={["fit", "spendingBand"]} rows={BAND_LABELS} />
              <PointsTable
                title="Location"
                path={["fit", "location"]}
                rows={LOCATION_LABELS}
                hint="Cities and spellings come from Settings > Locations."
              />
              <PointsTable title="Industry or role" path={["fit", "industry"]} rows={industryRows} open />
              <PointsTable title="Age band" path={["fit", "ageBand"]} rows={ageRows} open />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={`Readiness: what is in their head (max ${totals.readiness})`}
              description="Umer familiarity + AI knowledge (a curve, not a ladder) + recent interest."
            />
            <CardBody className="grid gap-6 md:grid-cols-2">
              <div className="flex flex-col gap-6">
                <div>
                  <div className="mb-2 flex items-baseline justify-between gap-2">
                    <h4 className="text-sm font-semibold">Umer familiarity</h4>
                    <span className="tabular text-xs text-muted">max {5 * r.umerPointsPerLevel}</span>
                  </div>
                  <table className="w-full text-sm">
                    <tbody>
                      <tr className="border-b border-border">
                        <td className="py-1.5">Points per level (0 to 5)</td>
                        <td className="py-1.5 text-right">
                          <Num path={["readiness", "umerPointsPerLevel"]} label="Points per Umer familiarity level" />
                        </td>
                      </tr>
                      <tr>
                        <td className="py-1.5">Unknown counts as level</td>
                        <td className="py-1.5 text-right">
                          <Num path={["readiness", "umerUnknownLevel"]} label="Unknown Umer familiarity counts as level" />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <RowsTable
                  title="Recent interest"
                  path={["readiness", "recentInterest"]}
                  field="withinDays"
                  describe={(input) => <span className="inline-flex items-center gap-1.5">Within {input} days</span>}
                  fallback={{ label: "Older or never", path: ["readiness", "recentInterestOlder"] }}
                  max={maxOf([...r.recentInterest.map((x) => x.points), r.recentInterestOlder])}
                  blank={{ withinDays: 180, points: 0 }}
                />
              </div>
              <PointsTable title="AI knowledge" path={["readiness", "aiLevel"]} rows={AI_LABELS} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={`Value: what they have done (max ${totals.value})`}
              description="Used once someone pays. Money + frequency + breadth + referrals + recency."
            />
            <CardBody className="grid gap-6 md:grid-cols-2">
              <RowsTable
                title="Money (LTV)"
                path={["value", "ltv"]}
                field="below"
                describe={(input) => <span className="inline-flex items-center gap-1.5">Under ₹ {input}</span>}
                fallback={{ label: "Above the last amount", path: ["value", "ltvTop"] }}
                max={maxOf([...v.ltv.map((x) => x.points), v.ltvTop])}
                blank={{ below: 100000, points: 0 }}
              />
              <RowsTable
                title="Frequency"
                path={["value", "frequency"]}
                field="min"
                describe={(input) => <span className="inline-flex items-center gap-1.5">{input} or more purchases</span>}
                max={maxOf(v.frequency.map((x) => x.points))}
                blank={{ min: 10, points: 0 }}
              />
              <RowsTable
                title="Breadth (product families)"
                path={["value", "breadth"]}
                field="min"
                describe={(input) => <span className="inline-flex items-center gap-1.5">{input} or more families</span>}
                max={maxOf(v.breadth.map((x) => x.points))}
                blank={{ min: 4, points: 0 }}
              />
              <RowsTable
                title="Referrals (paying customers brought)"
                path={["value", "referrals"]}
                field="min"
                describe={(input) => <span className="inline-flex items-center gap-1.5">{input} or more</span>}
                max={maxOf(v.referrals.map((x) => x.points))}
                blank={{ min: 5, points: 0 }}
              />
              <RowsTable
                title="Recency of last purchase"
                path={["value", "recency"]}
                field="withinDays"
                describe={(input) => <span className="inline-flex items-center gap-1.5">Within {input} days</span>}
                fallback={{ label: "Older", path: ["value", "recencyOlder"] }}
                max={maxOf([...v.recency.map((x) => x.points), v.recencyOlder])}
                blank={{ withinDays: 730, points: 0 }}
              />
            </CardBody>
          </Card>

          {/* phones: the preview and the save button sit at the end, so keep the grades in view while editing */}
          <div className="sticky bottom-20 z-20 flex items-center gap-2 rounded-xl border border-border bg-surface/95 p-2 shadow-lg backdrop-blur lg:hidden">
            <span className="text-xs font-medium text-muted">Preview</span>
            <span className="flex flex-1 flex-wrap items-center gap-1.5">
              {preview.map(({ example, score }) => (
                <span key={example.id} title={example.title} className="inline-flex items-center gap-1">
                  <GradeBadge grade={score.grade} size="sm" />
                  <span className="tabular text-xs">{score.edaptScore}</span>
                </span>
              ))}
            </span>
            <a href="#scoring-save" className="rounded-lg px-2 py-1 text-xs font-semibold underline-offset-2 hover:underline">
              {dirty ? "Save…" : "Details"}
            </a>
          </div>
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start" aria-label="Preview and save">
          <Card>
            <CardHeader
              title="Live preview"
              description="The four worked examples from the spec, scored with the weights above."
            />
            <ul className="divide-y divide-border">
              {preview.map(({ example, score }) => {
                const changed = score.edaptScore !== example.spec.edapt || score.grade !== example.spec.grade;
                return (
                  <li key={example.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{example.title}</p>
                        <p className="mt-0.5 text-xs text-muted">{example.summary}</p>
                      </div>
                      <GradeBadge grade={score.grade} score={score.edaptScore} />
                    </div>
                    <p className="tabular mt-1.5 text-xs text-muted">
                      F {score.fit} · R {score.readiness} · V {score.value ?? "–"}
                      {changed && (
                        <span className="ml-1 font-medium text-warning">
                          (spec {example.spec.edapt} {example.spec.grade})
                        </span>
                      )}
                    </p>
                  </li>
                );
              })}
            </ul>
          </Card>
          <Card>
            <CardBody id="scoring-save" className="flex scroll-mt-20 flex-col gap-3">
              {!check.ok ? (
                <p role="alert" className="text-sm text-danger">
                  {check.error}
                </p>
              ) : check.warnings.length ? (
                <ul className="flex flex-col gap-1 text-xs text-warning" aria-label="Warnings">
                  {check.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted">Each score adds up to 100 and the blends to 1.</p>
              )}
              <JsonSaveForm
                action={saveScoringAction}
                value={draft}
                dirty={dirty}
                disabled={!check.ok || !dirty}
                submitLabel="Save scoring"
                onSaved={() => {
                  setSaved(draft);
                  setJustSaved(true);
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                disabled={isDefault}
                onClick={() => {
                  setDraft(structuredClone(DEFAULT_SETTINGS.scoring));
                  setJustSaved(false);
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset to spec defaults
              </Button>
              {justSaved && <RecalcButton action={recalcScoresChunkAction} hint="" />}
            </CardBody>
          </Card>
        </aside>
      </div>
    </Ctx.Provider>
  );
}

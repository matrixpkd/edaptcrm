"use client";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { slugKey } from "@/lib/admin/meta";
import { validateFamilies, validateRungs } from "@/lib/admin/validate";
import type { ProductFamily, Rung } from "@/lib/settings/defaults";
import { JsonSaveForm } from "../_components/json-save-form";
import { RecalcButton } from "../_components/recalc-button";
import { recalcScoresChunkAction } from "../actions";
import { saveLadderAction } from "./actions";

type Fam = ProductFamily & { isNew?: boolean };
type Usage = Record<string, { products: number; purchases: number }>;

/** The ladder: rungs (names and descriptions) and product families (on a rung, or in a side group). */
export function LadderEditor({ rungs: initialRungs, families: initialFamilies, usage }: { rungs: Rung[]; families: ProductFamily[]; usage: Usage }) {
  const [saved, setSaved] = useState({ rungs: initialRungs, families: initialFamilies });
  const [rungs, setRungs] = useState<Rung[]>(initialRungs);
  const [families, setFamilies] = useState<Fam[]>(initialFamilies);
  const [justSaved, setJustSaved] = useState(false);

  const cleanFamilies: ProductFamily[] = families.map(({ key, label, rung, group }) =>
    rung === null ? { key, label, rung: null, group: group ?? "" } : { key, label, rung },
  );
  const value = { rungs, families: cleanFamilies };
  const rv = validateRungs(rungs);
  const fv = rv.ok ? validateFamilies(cleanFamilies, rv.value) : null;
  const error = !rv.ok ? rv.error : fv && !fv.ok ? fv.error : null;
  const dirty = JSON.stringify(value) !== JSON.stringify(saved);
  const groups = [...new Set(families.map((f) => f.group).filter((g): g is string => !!g))];
  const setFam = (i: number, patch: Partial<Fam>) => setFamilies((f) => f.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const used = (key: string) => (usage[key]?.products ?? 0) + (usage[key]?.purchases ?? 0);

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="rungs-title" className="flex flex-col gap-3">
        <h3 id="rungs-title" className="text-sm font-semibold">
          Rungs
        </h3>
        <ol className="flex flex-col gap-2">
          {rungs.map((r, i) => {
            const onIt = families.filter((f) => f.rung === r.rung).length;
            const last = i === rungs.length - 1;
            return (
              <li key={r.rung} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[2.5rem_1fr_2fr_auto] sm:items-center">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground text-sm font-semibold text-white" aria-label={`Rung ${r.rung}`}>
                  {r.rung}
                </span>
                <Input value={r.label} aria-label={`Rung ${r.rung} name`} onChange={(e) => setRungs((x) => x.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} />
                <Input
                  value={r.description ?? ""}
                  placeholder="Description (optional)"
                  aria-label={`Rung ${r.rung} description`}
                  onChange={(e) => setRungs((x) => x.map((y, j) => (j === i ? { ...y, description: e.target.value } : y)))}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove rung ${r.rung}`}
                  title={!last ? "Only the top rung can be removed" : onIt ? "Move its families first" : "Remove"}
                  disabled={!last || onIt > 0 || rungs.length === 1}
                  onClick={() => setRungs((x) => x.slice(0, -1))}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            );
          })}
        </ol>
        <div>
          <Button variant="outline" size="sm" onClick={() => setRungs((x) => [...x, { rung: x.length + 1, label: "" }])}>
            <Plus className="h-4 w-4" aria-hidden /> Add rung
          </Button>
        </div>
      </section>

      <section aria-labelledby="families-title" className="flex flex-col gap-3">
        <div>
          <h3 id="families-title" className="text-sm font-semibold">
            Product families
          </h3>
          <p className="text-xs text-muted">Every product belongs to a family. A family sits on a rung, or in a side group (B2B, delegation) outside the ladder.</p>
        </div>
        <ul className="flex flex-col gap-2">
          {families.map((f, i) => {
            const n = used(f.key);
            return (
              <li key={i} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1.4fr_1fr_1.2fr_1.2fr_auto] sm:items-end">
                <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                  Name
                  <Input value={f.label} onChange={(e) => setFam(i, { label: e.target.value, ...(f.isNew ? { key: slugKey(e.target.value) } : {}) })} />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                  Key {f.isNew ? "" : "(fixed)"}
                  <Input
                    value={f.key}
                    readOnly={!f.isNew}
                    className={f.isNew ? "" : "bg-surface-muted text-muted"}
                    onChange={(e) => setFam(i, { key: e.target.value.toLowerCase() })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                  Place
                  <Select
                    value={f.rung === null ? "side" : String(f.rung)}
                    onChange={(e) =>
                      e.target.value === "side"
                        ? setFam(i, { rung: null, group: f.group ?? groups[0] ?? "" })
                        : setFam(i, { rung: Number(e.target.value), group: undefined })
                    }
                  >
                    {rungs.map((r) => (
                      <option key={r.rung} value={r.rung}>
                        Rung {r.rung}: {r.label || "unnamed"}
                      </option>
                    ))}
                    <option value="side">Side group</option>
                  </Select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                  Side group
                  <Input
                    value={f.rung === null ? (f.group ?? "") : ""}
                    disabled={f.rung !== null}
                    placeholder={f.rung === null ? "e.g. B2B and constituency" : "On the ladder"}
                    list="side-groups"
                    onChange={(e) => setFam(i, { group: e.target.value })}
                  />
                </label>
                <div className="flex items-center justify-between gap-2 sm:justify-end">
                  <span className="text-xs text-muted sm:hidden">{n ? `${usage[f.key]?.products ?? 0} products, ${usage[f.key]?.purchases ?? 0} purchases` : "Unused"}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${f.label || "family"}`}
                    title={n ? `Used by ${usage[f.key]?.products ?? 0} products and ${usage[f.key]?.purchases ?? 0} purchases` : "Remove"}
                    disabled={n > 0}
                    onClick={() => setFamilies((x) => x.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        <datalist id="side-groups">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
        <div>
          <Button variant="outline" size="sm" onClick={() => setFamilies((x) => [...x, { key: "", label: "", rung: 1, isNew: true }])}>
            <Plus className="h-4 w-4" aria-hidden /> Add family
          </Button>
        </div>
      </section>

      {error && dirty && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <JsonSaveForm
        action={saveLadderAction}
        value={value}
        dirty={dirty}
        disabled={!!error || !dirty}
        submitLabel="Save ladder"
        onSaved={() => {
          setSaved(value);
          setFamilies((x) => x.map((f) => ({ ...f, isNew: false })));
          setJustSaved(true);
        }}
      />
      {justSaved && <RecalcButton action={recalcScoresChunkAction} />}
    </div>
  );
}

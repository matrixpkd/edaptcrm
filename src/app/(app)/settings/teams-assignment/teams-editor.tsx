"use client";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, type Option } from "@/components/ui/form";
import { slugKey } from "@/lib/admin/meta";
import { validateTeams } from "@/lib/admin/validate";
import type { Team } from "@/lib/settings/defaults";
import { JsonSaveForm } from "../_components/json-save-form";
import { saveTeamsAction } from "./actions";

type Row = Team & { isNew?: boolean; members: number };

/** Teams: key (fixed once saved), name and time zone. A team with members cannot be removed. */
export function TeamsEditor({ initial, members, zones }: { initial: Team[]; members: Record<string, number>; zones: Option[] }) {
  const [saved, setSaved] = useState(initial);
  const [rows, setRows] = useState<Row[]>(initial.map((t) => ({ ...t, members: members[t.key] ?? 0 })));
  const value: Team[] = rows.map(({ key, label, timezone }) => ({ key, label, timezone }));
  const check = validateTeams(value);
  const dirty = JSON.stringify(value) !== JSON.stringify(saved);
  const set = (i: number, patch: Partial<Row>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3">
        {rows.map((t, i) => (
          <li key={i} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_1.3fr_auto] sm:items-end">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Name
              <Input
                value={t.label}
                aria-label={`Team ${i + 1} name`}
                onChange={(e) => set(i, { label: e.target.value, ...(t.isNew ? { key: slugKey(e.target.value) } : {}) })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Key {t.isNew ? "" : "(fixed)"}
              <Input
                value={t.key}
                readOnly={!t.isNew}
                aria-label={`Team ${i + 1} key`}
                className={t.isNew ? "" : "bg-surface-muted text-muted"}
                onChange={(e) => set(i, { key: e.target.value.toLowerCase() })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted">
              Time zone
              <Select value={t.timezone} aria-label={`Team ${i + 1} time zone`} onChange={(e) => set(i, { timezone: e.target.value })} options={zones} />
            </label>
            <div className="flex items-center justify-between gap-2 sm:justify-end">
              <span className="text-xs text-muted sm:hidden">{t.members} member{t.members === 1 ? "" : "s"}</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${t.label || "team"}`}
                title={t.members ? "Move its members to another team first" : "Remove"}
                disabled={t.members > 0 || rows.length === 1}
                onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRows((r) => [...r, { key: "", label: "", timezone: "Asia/Kolkata", isNew: true, members: 0 }])}
        >
          <Plus className="h-4 w-4" aria-hidden /> Add team
        </Button>
      </div>
      {!check.ok && dirty && (
        <p role="alert" className="text-sm text-danger">
          {check.error}
        </p>
      )}
      <JsonSaveForm
        action={saveTeamsAction}
        value={value}
        dirty={dirty}
        disabled={!check.ok || !dirty}
        submitLabel="Save teams"
        onSaved={() => {
          setSaved(value);
          setRows((r) => r.map((x) => ({ ...x, isNew: false })));
        }}
      />
    </div>
  );
}

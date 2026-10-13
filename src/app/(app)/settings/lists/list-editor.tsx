"use client";
import { useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { slugKey } from "@/lib/admin/meta";
import { validateList } from "@/lib/admin/validate";
import type { ListItem } from "@/lib/settings/defaults";
import { cn } from "@/lib/utils";
import { JsonSaveForm } from "../_components/json-save-form";
import { saveListAction } from "./actions";

export type UsageView = { total: number; text: string };

/**
 * One dropdown list: rename labels (the key stays), reorder, switch items off, add new ones. An item can be
 * removed only while nothing uses it and the system does not rely on it.
 */
export function ListEditor({
  listKey,
  title,
  initial,
  usage,
  systemKeys,
  keyIsLabel,
}: {
  listKey: string;
  title: string;
  initial: ListItem[];
  usage: Record<string, UsageView>;
  systemKeys: string[];
  keyIsLabel?: boolean;
}) {
  const [saved, setSaved] = useState<ListItem[]>(initial);
  const [items, setItems] = useState<(ListItem & { isNew?: boolean })[]>(initial);
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);

  const value: ListItem[] = items.map(({ key, label, active }) =>
    active === false ? { key, label, active: false } : { key, label },
  );
  const check = validateList(value, title);
  const dirty = JSON.stringify(value) !== JSON.stringify(saved);
  const suggestedKey = keyIsLabel ? newLabel.trim() : slugKey(newLabel);
  const addKey = keyTouched ? newKey.trim() : suggestedKey;
  const addError = !newLabel.trim()
    ? null
    : !addKey
      ? "Give it a key"
      : items.some((i) => i.key.toLowerCase() === addKey.toLowerCase())
        ? `The key "${addKey}" is already in the list`
        : items.some((i) => i.label.toLowerCase() === newLabel.trim().toLowerCase())
          ? "That name is already in the list"
          : null;

  const move = (i: number, d: -1 | 1) =>
    setItems((list) => {
      const j = i + d;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const patch = (i: number, p: Partial<ListItem>) => setItems((list) => list.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {items.map((it, i) => {
          const u = usage[it.key];
          const system = systemKeys.includes(it.key);
          const removable = it.isNew || (!system && !(u?.total ?? 0));
          const off = it.active === false;
          return (
            <li
              key={it.key}
              className={cn("flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center", off && "bg-surface-muted/60")}
            >
              <div className="flex min-w-0 items-center gap-2 sm:w-72 sm:shrink-0">
                <Input
                  value={it.label}
                  onChange={(e) => patch(i, { label: e.target.value })}
                  aria-label={`Name of ${it.key}`}
                  className={cn(off && "text-muted line-through decoration-muted/60")}
                />
              </div>
              <div className="flex items-center justify-between gap-2 sm:contents">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs text-muted">
                  <code
                    className="max-w-40 truncate rounded bg-surface-muted px-1.5 py-0.5 font-mono"
                    title="Stored key (never changes)"
                  >
                    {it.key}
                  </code>
                  {system && <Badge tone="info">System</Badge>}
                  {off && <Badge>Off</Badge>}
                  {it.isNew ? (
                    <Badge tone="success">New</Badge>
                  ) : (
                    <span className="tabular whitespace-nowrap">{u ? u.text : "Unused"}</span>
                  )}
                </div>
                <div className="flex items-center gap-0.5 sm:ml-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 sm:h-9 sm:w-9"
                    aria-label={`Move ${it.label} up`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 sm:h-9 sm:w-9"
                    aria-label={`Move ${it.label} down`}
                    disabled={i === items.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 sm:h-9 sm:w-9"
                    aria-label={off ? `Switch ${it.label} on` : `Switch ${it.label} off`}
                    title={
                      off ? "Switch on: shown in dropdowns again" : "Switch off: hidden from dropdowns, existing records keep it"
                    }
                    onClick={() => patch(i, { active: off ? undefined : false })}
                  >
                    {off ? <Eye className="h-4 w-4" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 sm:h-9 sm:w-9"
                    aria-label={`Remove ${it.label}`}
                    title={
                      removable
                        ? "Remove"
                        : system
                          ? "The system relies on this key: switch it off instead"
                          : "In use: switch it off instead"
                    }
                    disabled={!removable}
                    onClick={() => setItems((list) => list.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <form
        className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newLabel.trim() || addError) return;
          setItems((list) => [...list, { key: addKey, label: newLabel.trim().replace(/\s+/g, " "), isNew: true }]);
          setNewLabel("");
          setNewKey("");
          setKeyTouched(false);
        }}
        aria-label={`Add to ${title}`}
      >
        <div className="grid gap-2 sm:grid-cols-[1fr_14rem_auto] sm:items-end">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            New item
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Name shown in dropdowns"
              maxLength={80}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Key {keyIsLabel ? "(the tag itself)" : "(stored, never changes)"}
            <Input
              value={addKey}
              onChange={(e) => {
                setKeyTouched(true);
                setNewKey(e.target.value);
              }}
              className="font-mono"
              maxLength={60}
            />
          </label>
          <Button type="submit" variant="outline" disabled={!newLabel.trim() || !!addError}>
            <Plus className="h-4 w-4" aria-hidden /> Add
          </Button>
        </div>
        {addError && <p className="text-xs text-danger">{addError}</p>}
      </form>

      {!check.ok && (
        <p role="alert" className="text-sm text-danger">
          {check.error}
        </p>
      )}
      <JsonSaveForm
        action={saveListAction}
        value={value}
        hidden={{ list: listKey }}
        dirty={dirty}
        disabled={!check.ok || !dirty}
        submitLabel={`Save ${title.toLowerCase()}`}
        onSaved={() => {
          setSaved(value);
          setItems((list) => list.map((x) => ({ key: x.key, label: x.label, ...(x.active === false ? { active: false } : {}) })));
        }}
      />
    </div>
  );
}

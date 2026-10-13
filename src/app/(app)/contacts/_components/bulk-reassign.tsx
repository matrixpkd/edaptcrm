"use client";
import { useSearchParams } from "next/navigation";
import { startTransition, useActionState, useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { FormMessage, Input, Select, type Option } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { bulkReassignAction } from "../actions";

export const BULK_FORM_ID = "bulk-reassign";
const BOX = `input[form="${BULK_FORM_ID}"][name="ids"]`;
const ALL = "input[data-bulk-all]";

/**
 * Manager/admin bulk reassign. The row checkboxes live in the server-rendered table and join this form through
 * the form="…" attribute; this bar counts them and appears once something is selected.
 */
export function BulkReassignBar({ people }: { people: Option[] }) {
  const [count, setCount] = useState(0);
  const [state, action, pending] = useActionState(bulkReassignAction, null);
  const searchParams = useSearchParams();

  const sync = useCallback(() => {
    const boxes = [...document.querySelectorAll<HTMLInputElement>(BOX)];
    const n = boxes.filter((b) => b.checked).length;
    setCount(n);
    const all = document.querySelector<HTMLInputElement>(ALL);
    if (all) {
      all.checked = n > 0 && n === boxes.length;
      all.indeterminate = n > 0 && n < boxes.length;
    }
  }, []);

  const clear = useCallback(() => {
    document.querySelectorAll<HTMLInputElement>(BOX).forEach((b) => (b.checked = false));
    sync();
  }, [sync]);

  useEffect(() => {
    function onChange(e: Event) {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      if (t.matches(ALL)) document.querySelectorAll<HTMLInputElement>(BOX).forEach((b) => (b.checked = t.checked));
      if (t.matches(ALL) || t.matches(BOX)) sync();
    }
    document.addEventListener("change", onChange);
    sync();
    return () => document.removeEventListener("change", onChange);
  }, [sync, searchParams]);

  useEffect(() => {
    if (!state?.ok) return;
    document.querySelector<HTMLFormElement>(`#${BULK_FORM_ID}`)?.reset();
    clear();
  }, [state, clear]);

  return (
    <div aria-live="polite">
      {state && count === 0 && (
        <div className="mt-3">
          <FormMessage state={state} />
        </div>
      )}
      <form
        id={BULK_FORM_ID}
        onSubmit={(e) => {
          // dispatched by hand: a plain form action would reset the form afterwards, and that would untick the
          // row checkboxes (they belong to this form) and clear the reason even when the server reports an error
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          startTransition(() => action(fd));
        }}
        hidden={count === 0}
        className="sticky bottom-4 z-20 mt-3 rounded-xl border border-border bg-surface p-3 shadow-lg"
        aria-label="Reassign selected contacts"
      >
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto text-sm font-semibold">
            {count} selected
            <Button variant="ghost" size="sm" className="ml-2" onClick={clear}>
              Clear
            </Button>
          </p>
          <label htmlFor="bulk-to" className="sr-only">
            New owner
          </label>
          <Select id="bulk-to" name="toUserId" required defaultValue="" className="w-48">
            <option value="" disabled>
              Reassign to…
            </option>
            <option value="pool">The pool</option>
            {people.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
          <label htmlFor="bulk-reason" className="sr-only">
            Reason
          </label>
          <Input
            id="bulk-reason"
            name="reason"
            required
            placeholder="Reason, e.g. workload balance"
            className="w-64 max-w-full"
          />
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {pending ? "Reassigning…" : "Reassign"}
          </Button>
        </div>
        {state && !state.ok && (
          <div className="mt-2">
            <FormMessage state={state} />
          </div>
        )}
      </form>
    </div>
  );
}

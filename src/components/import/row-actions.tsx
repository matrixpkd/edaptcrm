"use client";
import { resolveAllConflictsAction, resolveConflictAction, skipRowsAction, discardBatchAction, changeSheetAction } from "@/app/(app)/import/actions";
import { SubmitButton } from "@/components/ui/submit-button";
import { ImportActionForm } from "./action-form";

/** Skip a row, or bring a skipped row back. */
export function SkipRowButton({ batchId, rowId, skip }: { batchId: string; rowId: string; skip: boolean }) {
  return (
    <ImportActionForm action={skipRowsAction} errorsOnly messageClassName="text-xs">
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="rowId" value={rowId} />
      <input type="hidden" name="skip" value={skip ? "1" : "0"} />
      <SubmitButton size="sm" className="max-md:h-10" variant="ghost" pendingText={skip ? "Skipping…" : "Adding…"}>
        {skip ? "Skip" : "Include"}
      </SubmitButton>
    </ImportActionForm>
  );
}

/** One click for a conflict: a new contact, or a merge into the contact / earlier row that was found. */
export function ConflictButtons({
  batchId,
  rowId,
  candidates,
  conflictRow,
  conflictName,
  decided,
}: {
  batchId: string;
  rowId: string;
  candidates: { id: string; name: string; phone: string }[];
  conflictRow: number | null;
  conflictName: string | null;
  decided: "new" | string | null;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <ImportActionForm action={resolveConflictAction} errorsOnly messageClassName="text-xs">
        <input type="hidden" name="batchId" value={batchId} />
        <input type="hidden" name="rowId" value={rowId} />
        <input type="hidden" name="kind" value="new" />
        <SubmitButton size="sm" className="max-md:h-10" variant={decided === "new" ? "primary" : "outline"} aria-pressed={decided === "new"} pendingText="Saving…">
          Treat as new
        </SubmitButton>
      </ImportActionForm>
      {candidates.map((c) => (
        <ImportActionForm key={c.id} action={resolveConflictAction} errorsOnly messageClassName="text-xs">
          <input type="hidden" name="batchId" value={batchId} />
          <input type="hidden" name="rowId" value={rowId} />
          <input type="hidden" name="kind" value="contact" />
          <input type="hidden" name="contactId" value={c.id} />
          <SubmitButton
            size="sm"
            className="max-md:h-10 max-w-full truncate"
            variant={decided === c.id ? "primary" : "outline"}
            aria-pressed={decided === c.id}
            pendingText="Saving…"
            title={`Merge into ${c.name} (${c.phone})`}
          >
            Merge into {c.name} (…{c.phone.slice(-4)})
          </SubmitButton>
        </ImportActionForm>
      ))}
      {conflictRow && (
        <ImportActionForm action={resolveConflictAction} errorsOnly messageClassName="text-xs">
          <input type="hidden" name="batchId" value={batchId} />
          <input type="hidden" name="rowId" value={rowId} />
          <input type="hidden" name="kind" value="row" />
          <SubmitButton size="sm" className="max-md:h-10" variant={decided === "row" ? "primary" : "outline"} aria-pressed={decided === "row"} pendingText="Saving…">
            Merge into row {conflictRow}
            {conflictName ? ` (${conflictName})` : ""}
          </SubmitButton>
        </ImportActionForm>
      )}
    </div>
  );
}

export function ResolveAllConflictsButton({ batchId, count }: { batchId: string; count: number }) {
  return (
    <ImportActionForm
      action={resolveAllConflictsAction}
      confirm={`Import all ${count.toLocaleString("en-IN")} undecided conflicts as new contacts? Each pair is flagged on the Duplicates screen for a later look.`}
    >
      <input type="hidden" name="batchId" value={batchId} />
      <SubmitButton size="sm" className="max-md:h-10" variant="outline" pendingText="Saving…">
        All conflicts → new
      </SubmitButton>
    </ImportActionForm>
  );
}

export function DiscardButton({ batchId }: { batchId: string }) {
  return (
    <ImportActionForm action={discardBatchAction} confirm="Discard this import? Nothing was imported yet; the rows are deleted.">
      <input type="hidden" name="batchId" value={batchId} />
      <SubmitButton size="sm" className="max-md:h-10" variant="ghost" pendingText="Discarding…">
        Discard
      </SubmitButton>
    </ImportActionForm>
  );
}

export function SheetPicker({ batchId, sheets, current }: { batchId: string; sheets: string[]; current: string | null }) {
  return (
    <ImportActionForm action={changeSheetAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <input type="hidden" name="batchId" value={batchId} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="sheet" className="text-sm font-medium">
          Sheet
        </label>
        <select
          id="sheet"
          name="sheet"
          defaultValue={current ?? undefined}
          className="h-10 rounded-lg border border-border bg-surface px-3 pr-8 text-sm focus:border-foreground focus:outline-none focus:ring-2 focus:ring-black/10"
        >
          {sheets.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <SubmitButton variant="outline" pendingText="Reading…">
        Use this sheet
      </SubmitButton>
    </ImportActionForm>
  );
}

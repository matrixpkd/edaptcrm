"use client";
import { startTransition, useActionState, useId, useState } from "react";
import { FileUp, Loader2, Sparkles } from "lucide-react";
import { uploadImportAction } from "@/app/(app)/import/actions";
import { FormMessage } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { IMPORT_SOURCES, SOURCE_INFO, type ImportSource } from "@/lib/import/types";
import { cn } from "@/lib/utils";

const ACCEPT = ".csv,.tsv,.xlsx,.docx,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain";

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Step 1: where the file comes from, and the file. */
export function UploadForm({ aiEnabled, suggested }: { aiEnabled: boolean; suggested: ImportSource }) {
  const [state, action, pending] = useActionState(uploadImportAction, null);
  const [source, setSource] = useState<ImportSource>(suggested);
  const [file, setFile] = useState<File | null>(null);
  const fileId = useId();
  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        // dispatched by hand: a refused upload keeps the chosen file and source (a form action resets the form)
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
    >
      <fieldset>
        <legend className="text-sm font-medium">Where does the file come from?</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {IMPORT_SOURCES.map((s) => {
            const on = source === s;
            return (
              <label
                key={s}
                className={cn(
                  "flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
                  on ? "border-foreground bg-surface-muted/60" : "border-border hover:bg-surface-muted/40",
                )}
              >
                <input
                  type="radio"
                  name="source"
                  value={s}
                  checked={on}
                  onChange={() => setSource(s)}
                  className="mt-1 h-4 w-4 shrink-0 accent-black"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{SOURCE_INFO[s].label}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted">{SOURCE_INFO[s].description}</span>
                </span>
              </label>
            );
          })}
        </div>
        {fieldErrors?.source && <p className="mt-1 text-xs text-danger">{fieldErrors.source}</p>}
      </fieldset>

      <div>
        <label htmlFor={fileId} className="text-sm font-medium">
          File
        </label>
        <label
          htmlFor={fileId}
          className={cn(
            "mt-2 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors",
            file ? "border-foreground/40 bg-surface-muted/40" : "border-border hover:bg-surface-muted/40",
          )}
        >
          <FileUp className="h-6 w-6 text-muted" aria-hidden />
          {file ? (
            <span className="text-sm">
              <span className="font-medium break-all">{file.name}</span>
              <span className="text-muted"> · {size(file.size)}</span>
            </span>
          ) : (
            <span className="text-sm">
              <span className="font-medium">Choose a file</span>
              <span className="block text-xs text-muted">CSV, Excel (.xlsx), Word (.docx) or text, up to 24 MB</span>
            </span>
          )}
        </label>
        <input
          id={fileId}
          type="file"
          name="file"
          accept={ACCEPT}
          required
          className="sr-only"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        {fieldErrors?.file && <p className="mt-1 text-xs text-danger">{fieldErrors.file}</p>}
      </div>

      <p className="flex items-start gap-2 text-xs text-muted">
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        {aiEnabled
          ? "Claude proposes the column mapping (and pulls people out of docs). You check it in the next step."
          : "No Anthropic API key is set, so keyword rules propose the column mapping. You check it in the next step."}
      </p>

      <FormMessage state={state && !state.ok ? state : null} />
      <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={pending} aria-busy={pending}>
        {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {pending ? "Reading the file…" : "Upload and map columns"}
      </Button>
    </form>
  );
}

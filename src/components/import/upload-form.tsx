"use client";
import { startTransition, useActionState, useId, useState } from "react";
import { FileUp, Loader2, Sparkles } from "lucide-react";
import { prepareImportUploadAction, uploadImportAction } from "@/app/(app)/import/actions";
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

/**
 * The file goes straight from the browser to Supabase Storage (signed upload URL), then only its key is posted:
 * a 50,000-row export can be bigger than the ~4.5 MB a Vercel function accepts. Returns the form data to post, or
 * the reason the upload failed.
 */
async function uploadToStorage(fd: FormData, file: File): Promise<{ fd: FormData } | { error: string }> {
  const prep = await prepareImportUploadAction({ fileName: file.name, size: file.size });
  if (!prep || !prep.ok) return { error: prep?.error ?? "The upload could not start. Try again." };
  // no Storage configured after all: post the file itself
  if (!prep.data) return { fd };
  let res: Response;
  try {
    res = await fetch(prep.data.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream", "x-upsert": "false" },
      body: file,
    });
  } catch {
    return { error: "The file could not be uploaded. Check your connection and try again." };
  }
  if (!res.ok) return { error: `The file could not be uploaded (storage answered ${res.status}). Try again.` };
  const out = new FormData();
  for (const [k, v] of fd.entries()) if (k !== "file") out.append(k, v);
  out.set("storageKey", prep.data.key);
  out.set("fileName", file.name);
  out.set("fileType", file.type);
  return { fd: out };
}

/** Step 1: where the file comes from, and the file. */
export function UploadForm({
  aiEnabled,
  suggested,
  directUpload = false,
}: {
  aiEnabled: boolean;
  suggested: ImportSource;
  /** Supabase Storage is configured: upload the file from the browser straight to Storage */
  directUpload?: boolean;
}) {
  const [state, action, pending] = useActionState(uploadImportAction, null);
  const [source, setSource] = useState<ImportSource>(suggested);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileId = useId();
  const fieldErrors = state && !state.ok ? state.fieldErrors : undefined;
  const busy = pending || uploading;

  return (
    <form
      className="space-y-5"
      onSubmit={async (e) => {
        // dispatched by hand: a refused upload keeps the chosen file and source (a form action resets the form)
        e.preventDefault();
        if (busy) return;
        let fd = new FormData(e.currentTarget);
        setUploadError(null);
        if (directUpload && file) {
          setUploading(true);
          try {
            const r = await uploadToStorage(fd, file);
            if ("error" in r) {
              setUploadError(r.error);
              return;
            }
            fd = r.fd;
          } finally {
            setUploading(false);
          }
        }
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

      <FormMessage state={uploadError ? { ok: false, error: uploadError } : state && !state.ok ? state : null} />
      <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={busy} aria-busy={busy}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {uploading ? "Uploading the file…" : pending ? "Reading the file…" : "Upload and map columns"}
      </Button>
    </form>
  );
}

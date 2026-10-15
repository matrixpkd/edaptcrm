"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Input } from "@/components/ui/form";

type Pick = { id: string; title: string; subtitle: string };

/**
 * Optional contact for a task: type a name, phone or email and pick from the matches (the same scoped search as the
 * global search). Submits the chosen id as a hidden `name` field.
 */
export function ContactPicker({
  name,
  initial,
  inputId,
}: {
  name: string;
  initial?: { id: string; name: string } | null;
  inputId?: string;
}) {
  const [chosen, setChosen] = useState<Pick | null>(initial ? { id: initial.id, title: initial.name, subtitle: "" } : null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Pick[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const text = q.trim();
    if (chosen || text.length < 2) {
      setHits([]);
      setLoading(false);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?kinds=contact&q=${encodeURIComponent(text)}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { hits: Pick[] };
        if (id === seq.current) {
          setHits(data.hits);
          setFailed(false);
        }
      } catch {
        if (id === seq.current) setFailed(true);
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q, chosen]);

  if (chosen) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-muted px-3 py-2">
        <input type="hidden" name={name} value={chosen.id} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{chosen.title}</span>
        <button
          type="button"
          onClick={() => {
            setChosen(null);
            setQ("");
          }}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface"
          aria-label={`Remove ${chosen.title}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }
  return (
    <div className="relative">
      <input type="hidden" name={name} value="" />
      <Input
        id={inputId}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search a contact (optional)"
        autoComplete="off"
        inputMode="search"
      />
      {loading && <Loader2 className="absolute right-3 top-3 h-4 w-4 animate-spin text-muted" aria-hidden />}
      {failed && <p className="mt-1 text-xs text-danger">Search is not reachable right now.</p>}
      {hits.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-border bg-surface shadow-lg" role="listbox" aria-label="Matching contacts">
          {hits.map((h) => (
            <li key={h.id} role="option" aria-selected={false}>
              <button
                type="button"
                onClick={() => setChosen(h)}
                className="block w-full px-3 py-2 text-left hover:bg-surface-muted"
              >
                <span className="block truncate text-sm font-medium">{h.title}</span>
                <span className="block truncate text-xs text-muted">{h.subtitle}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!loading && !failed && q.trim().length >= 2 && hits.length === 0 && (
        <p className="mt-1 text-xs text-muted">No contact you can see matches “{q.trim()}”.</p>
      )}
    </div>
  );
}

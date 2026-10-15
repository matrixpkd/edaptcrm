"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Building2, CornerDownLeft, LayoutGrid, Loader2, Search, UserRound, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Hit = {
  kind: "contact" | "organisation" | "page";
  id: string;
  href: string;
  title: string;
  subtitle: string;
  grade?: "A" | "B" | "C" | "D" | null;
};

const KIND_ICON = { contact: UserRound, organisation: Building2, page: LayoutGrid } as const;

/**
 * Global search: a "Search" button (sidebar on laptops, an icon in the phone top bar) and Ctrl/Cmd+K anywhere open a
 * dialog that finds contacts (name, phone in any format, email), organisations and screens as you type. Arrow keys
 * move, Enter opens. Results come from /api/search (scoped to what the person may see).
 */
export function GlobalSearch({ variant }: { variant: "sidebar" | "icon" }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    // the sidebar and the phone bar both render this; only one listens
    if (variant !== "sidebar") return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant]);
  useEffect(() => {
    // pages open the search with openGlobalSearch(); the sidebar copy answers (it is the one always mounted on laptops)
    if (variant !== "sidebar") return;
    const onOpen = () => setOpen(true);
    window.addEventListener("edapt:open-search", onOpen);
    return () => window.removeEventListener("edapt:open-search", onOpen);
  }, [variant]);

  return (
    <>
      {variant === "sidebar" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Search className="h-4 w-4" aria-hidden />
          <span className="flex-1 text-left">Search</span>
          <kbd className="rounded border border-border px-1.5 text-[10px] font-medium">Ctrl K</kbd>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg p-2 hover:bg-surface-muted"
          aria-label="Search"
        >
          <Search className="h-5 w-5" />
        </button>
      )}
      {/* in a portal: the phone top bar's backdrop blur would otherwise trap a fixed overlay inside the bar */}
      {open && createPortal(<SearchDialog onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setHits([]);
      setLoading(false);
      setError(null);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(text)}`, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { hits: Hit[] };
        if (id !== seq.current) return;
        setHits(data.hits);
        setActive(0);
        setError(null);
      } catch {
        if (id === seq.current) setError("Search is not reachable right now. Check your connection.");
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [q]);

  const go = useCallback(
    (hit: Hit | undefined) => {
      if (!hit) return;
      onClose();
      router.push(hit.href);
    },
    [onClose, router],
  );

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(hits.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hits.length) go(hits[active]);
      else if (q.trim().length >= 2) go({ kind: "page", id: "contacts", href: `/contacts?q=${encodeURIComponent(q.trim())}`, title: "", subtitle: "" });
    }
  }

  const text = q.trim();
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-0 sm:p-4 sm:pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="flex h-dvh w-full flex-col bg-surface shadow-2xl sm:h-auto sm:max-h-[70vh] sm:max-w-xl sm:rounded-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-5 w-5 shrink-0 text-muted" aria-hidden />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, phone, email or organisation"
            aria-label="Search contacts, organisations and screens"
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls="global-search-results"
            aria-activedescendant={hits[active] ? `gs-${active}` : undefined}
            className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted/70"
            inputMode="search"
            autoComplete="off"
            spellCheck={false}
          />
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted" aria-label="Searching" />}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-surface-muted"
            aria-label="Close search"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error && <p className="px-3 py-4 text-sm text-danger">{error}</p>}
          {!error && text.length < 2 && (
            <p className="px-3 py-4 text-sm text-muted">Type at least two letters or digits. Phone numbers work in any format.</p>
          )}
          {!error && text.length >= 2 && !loading && hits.length === 0 && (
            <p className="px-3 py-4 text-sm text-muted">
              Nothing found for “{text}”. Press Enter to search the Contacts list instead.
            </p>
          )}
          <ul id="global-search-results" role="listbox" aria-label="Results">
            {hits.map((h, i) => {
              const Icon = KIND_ICON[h.kind];
              return (
                <li key={`${h.kind}:${h.id}`} id={`gs-${i}`} role="option" aria-selected={i === active}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(h)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left",
                      i === active ? "bg-surface-muted" : "hover:bg-surface-muted",
                    )}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-muted text-muted">
                      {h.kind === "contact" && h.grade ? (
                        <span className="text-xs font-semibold text-foreground">{h.grade}</span>
                      ) : (
                        <Icon className="h-4 w-4" aria-hidden />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{h.title}</span>
                      <span className="block truncate text-xs text-muted">{h.subtitle}</span>
                    </span>
                    {i === active && <CornerDownLeft className="hidden h-4 w-4 text-muted sm:block" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** Opens the search dialog from anywhere (e.g. a button on a page). */
export function openGlobalSearch() {
  window.dispatchEvent(new Event("edapt:open-search"));
}

"use client";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The Contacts list filter bar. A plain GET form (it works without JavaScript); with JavaScript, a changed
 * select or checkbox applies at once and empty fields are left out of the URL so links stay short and shareable.
 * On phones the filters fold behind a button.
 */
export function FilterForm({
  search,
  filters,
  activeCount,
}: {
  search: React.ReactNode;
  filters: React.ReactNode;
  activeCount: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function apply(form: HTMLFormElement) {
    const params = new URLSearchParams();
    for (const [k, v] of new FormData(form)) {
      if (typeof v === "string" && v.trim()) params.append(k, v.trim());
    }
    const qs = params.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  }

  return (
    <form
      method="get"
      action={pathname}
      role="search"
      aria-label="Search and filter contacts"
      onSubmit={(e) => {
        e.preventDefault();
        apply(e.currentTarget);
      }}
      onChange={(e) => {
        const t = e.target;
        if (t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && t.type === "checkbox"))
          apply(e.currentTarget);
      }}
      className="space-y-3"
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">{search}</div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="contact-filters"
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-sm font-medium hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
          Filters
          {activeCount > 0 && (
            <span className="rounded-full bg-foreground px-1.5 text-xs font-semibold text-white">{activeCount}</span>
          )}
        </button>
        <span className="w-5 shrink-0" aria-live="polite">
          {pending && <Loader2 className="h-4 w-4 animate-spin text-muted" aria-label="Loading" />}
        </span>
      </div>
      <div id="contact-filters" className={cn(open ? "block" : "hidden lg:block")}>
        {filters}
      </div>
    </form>
  );
}

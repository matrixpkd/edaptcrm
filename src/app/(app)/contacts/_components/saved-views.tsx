"use client";
import Link from "next/link";
import { useState } from "react";
import { Bookmark, Plus, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { ActionForm } from "@/components/contacts/action-form";
import { cn } from "@/lib/utils";
import { deleteViewAction, saveViewAction } from "../actions";

export type ViewChip = {
  id: string;
  name: string;
  query: string;
  shared: boolean;
  mine: boolean;
  ownerName: string | null;
};

/** Saved views as chips, with a small form to save the current filters under a name. */
export function SavedViews({
  views,
  currentQuery,
  canShare,
  canDeleteShared,
  builtIn = [],
}: {
  /** fixed views next to All contacts, e.g. My contacts and Pool (with its count) */
  builtIn?: { query: string; label: string; count: number | null }[];
  views: ViewChip[];
  currentQuery: string;
  canShare: boolean;
  canDeleteShared: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const isSaved = views.some((v) => v.query === currentQuery) || builtIn.some((b) => b.query === currentQuery);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {[{ query: "", label: "All contacts", count: null as number | null }, ...builtIn].map((b) => {
          const active = currentQuery === b.query;
          return (
            <Link
              key={b.query || "all"}
              href={b.query ? `/contacts?${b.query}` : "/contacts"}
              aria-current={active ? "true" : undefined}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium",
                active ? "border-foreground bg-foreground text-white" : "border-border bg-surface hover:bg-surface-muted",
              )}
            >
              {b.label}
              {b.count !== null && b.count > 0 && (
                <span
                  className={cn(
                    "tabular rounded-full px-1.5 text-xs font-semibold",
                    active ? "bg-white text-foreground" : "bg-warning/15 text-warning",
                  )}
                >
                  {b.count.toLocaleString("en-IN")}
                </span>
              )}
            </Link>
          );
        })}
        {views.map((v) => {
          const active = v.query === currentQuery;
          return (
            <span
              key={v.id}
              className={cn(
                "inline-flex h-9 items-center rounded-full border text-sm font-medium",
                active ? "border-foreground bg-foreground text-white" : "border-border bg-surface",
              )}
            >
              <Link
                href={v.query ? `/contacts?${v.query}` : "/contacts"}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "inline-flex h-full items-center gap-1.5 rounded-full pl-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  v.mine || canDeleteShared ? "pr-2" : "pr-3",
                  !active && "hover:bg-surface-muted",
                )}
                title={v.shared ? `Shared${v.ownerName ? ` by ${v.ownerName}` : ""}` : "Only you see this view"}
              >
                {v.shared ? (
                  <Users className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <Bookmark className="h-3.5 w-3.5" aria-hidden />
                )}
                {v.name}
              </Link>
              {(v.mine || (v.shared && canDeleteShared)) && (
                <ActionForm
                  action={deleteViewAction}
                  confirm={`Delete the view "${v.name}"?`}
                  messageClassName="sr-only"
                >
                  <input type="hidden" name="viewId" value={v.id} />
                  <button
                    type="submit"
                    aria-label={`Delete view ${v.name}`}
                    className={cn(
                      "mr-0.5 flex h-8 w-8 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active ? "hover:bg-white/20" : "text-muted hover:bg-surface-muted",
                    )}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </ActionForm>
              )}
            </span>
          );
        })}
        {currentQuery !== "" && !isSaved && !saving && (
          <Button variant="ghost" size="sm" onClick={() => setSaving(true)} className="rounded-full">
            <Plus className="h-4 w-4" aria-hidden /> Save this view
          </Button>
        )}
      </div>
      {saving && (
        <ActionForm
          action={saveViewAction}
          onSuccess={() => setSaving(false)}
          className="rounded-xl border border-border bg-surface p-3"
          aria-label="Save view"
        >
          <input type="hidden" name="query" value={currentQuery} />
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="view-name" className="sr-only">
              View name
            </label>
            <Input
              id="view-name"
              name="name"
              required
              maxLength={60}
              placeholder="Name, e.g. Grade A leads in Dubai"
              className="w-72 max-w-full"
              autoFocus
            />
            {canShare && <Checkbox name="shared" label="Share with everyone" />}
            <SubmitButton size="sm" pendingText="Saving…">
              Save
            </SubmitButton>
            <Button variant="ghost" size="sm" onClick={() => setSaving(false)}>
              Cancel
            </Button>
          </div>
        </ActionForm>
      )}
    </div>
  );
}

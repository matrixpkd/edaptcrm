"use client";
import { useActionState, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import type { InteractionType } from "@/db/schema";
import { Textarea } from "@/components/ui/form";
import type { ActionResult } from "@/lib/action";
import {
  FOLLOW_UP_CHOICES,
  LOG_TYPES,
  suggestedFollowUp,
  suggestedLostReason,
  type FollowUpChoice,
} from "@/lib/today/rules";
import { cn } from "@/lib/utils";
import { RadioChips } from "./choice";

type Item = { key: string; label: string };

/**
 * Log interaction: type, outcome, next follow-up and a short note in under 30 seconds.
 * Submits through onSubmit (not a bare form action) so a server error never wipes what was typed.
 */
export function LogForm({
  action,
  defaultType,
  outcomes,
  lostReasons,
  canMarkLost,
  followUpHints,
  minDate,
  returnTo,
}: {
  action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  defaultType: InteractionType;
  outcomes: Item[];
  lostReasons: Item[];
  canMarkLost: boolean;
  /** "Wed 14 Oct, 10:00 am" for each preset chip */
  followUpHints: Partial<Record<FollowUpChoice, string>>;
  /** YYYY-MM-DD of the user's local today */
  minDate: string;
  returnTo: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [, startTransition] = useTransition();
  const [type, setType] = useState<InteractionType | null>(defaultType);
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [outcome, setOutcome] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState<FollowUpChoice | null>("none");
  const [followUpTouched, setFollowUpTouched] = useState(false);
  const [followUpDate, setFollowUpDate] = useState("");
  const [markLost, setMarkLost] = useState(false);
  const [lostReason, setLostReason] = useState<string | null>(null);
  const [summary, setSummary] = useState("");

  const fieldErrors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const lostOffer = canMarkLost && !!suggestedLostReason(outcome);

  function pickOutcome(v: string | null) {
    setOutcome(v);
    if (!followUpTouched) setFollowUp(suggestedFollowUp(v));
    const lost = suggestedLostReason(v);
    if (lost) {
      // preselect the matching lost reason only when it is in settings lists.lostReasons
      if (lostReasons.some((r) => r.key === lost)) setLostReason(lost);
    } else setMarkLost(false);
  }

  function toggleLost(on: boolean) {
    setMarkLost(on);
    // a lost contact needs no follow-up unless the user already chose one
    if (on && !followUpTouched) setFollowUp("none");
  }

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => formAction(fd));
      }}
      className="flex min-h-0 flex-1 flex-col"
      noValidate
    >
      <input type="hidden" name="return" value={returnTo} />
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-5 sm:px-6">
        <RadioChips<InteractionType>
          name="type"
          legend="Type"
          options={LOG_TYPES}
          value={type}
          onChange={(v) => setType(v)}
          error={fieldErrors.type}
          legendExtra={
            <div className="flex rounded-lg border border-border p-0.5" role="radiogroup" aria-label="Direction">
              {(
                [
                  ["out", "Outgoing"],
                  ["in", "Incoming"],
                ] as const
              ).map(([v, label]) => (
                <label key={v} className="cursor-pointer">
                  <input
                    type="radio"
                    name="direction"
                    value={v}
                    checked={direction === v}
                    onChange={() => setDirection(v)}
                    className="peer sr-only"
                  />
                  <span
                    className={cn(
                      "inline-flex h-10 items-center rounded-md px-3 text-xs font-medium peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
                      direction === v ? "bg-foreground text-white" : "text-muted hover:text-foreground",
                    )}
                  >
                    {label}
                  </span>
                </label>
              ))}
            </div>
          }
        />

        <RadioChips
          name="outcome"
          legend={
            <>
              Outcome <span className="font-normal text-muted">(optional)</span>
            </>
          }
          options={outcomes.map((o) => ({ value: o.key, label: o.label }))}
          value={outcome}
          onChange={pickOutcome}
          allowClear
          size="sm"
          error={fieldErrors.outcome}
        />

        {lostOffer && (
          <div className="rounded-xl border border-border bg-surface-muted/60 p-3">
            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                name="markLost"
                checked={markLost}
                onChange={(e) => toggleLost(e.target.checked)}
                className="h-5 w-5 rounded border-border accent-black"
              />
              <span className="text-sm">
                <span className="font-medium">Mark as lost</span>
                <span className="block text-xs text-muted">Moves them to Lost. A new enquiry or payment brings them back.</span>
              </span>
            </label>
            {markLost && (
              <RadioChips
                className="mt-3"
                name="lostReason"
                legend="Why"
                options={lostReasons.map((r) => ({ value: r.key, label: r.label }))}
                value={lostReason}
                onChange={setLostReason}
                size="sm"
                error={fieldErrors.lostReason}
              />
            )}
          </div>
        )}

        <div>
          <RadioChips<FollowUpChoice>
            name="followUp"
            legend="Next follow-up"
            options={FOLLOW_UP_CHOICES.map((c) => ({ value: c.value, label: c.label, hint: followUpHints[c.value] }))}
            value={followUp}
            onChange={(v) => {
              setFollowUp(v ?? "none");
              setFollowUpTouched(true);
            }}
            size="sm"
            error={fieldErrors.followUp}
          />
          {followUp && followUp !== "none" && followUp !== "custom" && followUpHints[followUp] && (
            <p className="mt-1.5 text-xs text-muted">On your Today list {followUpHints[followUp]}</p>
          )}
          {followUp === "custom" && (
            <div className="mt-2">
              <label htmlFor="followUpDate" className="mb-1 block text-xs font-medium text-muted">
                Follow-up date (10:00 am your time)
              </label>
              <input
                id="followUpDate"
                type="date"
                name="followUpDate"
                min={minDate}
                value={followUpDate}
                onChange={(e) => setFollowUpDate(e.target.value)}
                className="h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm focus:border-foreground focus:outline-none focus:ring-2 focus:ring-black/10 sm:w-56"
                required
              />
            </div>
          )}
        </div>

        <div>
          <label htmlFor="summary" className="mb-2 block text-sm font-semibold">
            Note <span className="font-normal text-muted">(optional)</span>
          </label>
          <Textarea
            id="summary"
            name="summary"
            rows={3}
            maxLength={2000}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="What happened? One line is enough."
            aria-invalid={!!fieldErrors.summary}
          />
        </div>
      </div>

      <div className="border-t border-border bg-surface px-4 py-3 safe-bottom sm:px-6">
        {state && !state.ok && (
          <p role="alert" className="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
            {state.error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending || !type}
          aria-busy={pending}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand text-base font-semibold text-brand-foreground hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {pending ? "Saving…" : markLost ? "Save and mark lost" : "Save"}
        </button>
      </div>
    </form>
  );
}

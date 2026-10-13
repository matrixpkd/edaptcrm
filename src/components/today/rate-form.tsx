"use client";
import { useActionState, useMemo, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import type { FieldSource } from "@/db/schema";
import { Badge } from "@/components/ui/badge";
import { StarInput } from "@/components/ui/chips";
import { Textarea } from "@/components/ui/form";
import type { ActionResult } from "@/lib/action";
import { scoreContact, type ScoreContactInput } from "@/lib/metrics/scoring";
import type { LocationConfig, ScoringConfig } from "@/lib/settings/defaults";
import {
  AI_KNOWLEDGE_SCALE,
  SPENDING_POWER_HINT,
  SPENDING_POWER_SCALE,
  UMER_FAMILIARITY_SCALE,
} from "@/lib/today/rating-scales";
import { RadioChips, ScaleRadios } from "./choice";
import { ScorePreview } from "./score-preview";

type Item = { key: string; label: string };

export type RateValues = {
  aiLevel: number | null;
  umerLevel: number | null;
  spendingBand: number | null;
  gutStars: number | null;
  ageBand: string | null;
  industry: string | null;
};

export type RatePreviewProps = {
  scoring: ScoringConfig;
  locations: LocationConfig;
  gccCountries: string[];
  base: {
    country: string | null;
    state: string | null;
    city: string | null;
    phoneCountry: string | null;
    ltvInr: number;
    purchaseCount: number;
    familyCount: number;
    referralCount: number;
    lastPurchaseAt: string | null;
    lastInterestAt: string | null;
  };
  now: string;
};

const SOURCE_LABEL: Partial<Record<FieldSource, string>> = { self: "Self-rated", import: "Imported" };

function SourceBadge({ source, changed }: { source?: FieldSource; changed: boolean }) {
  const label = source ? SOURCE_LABEL[source] : undefined;
  if (!label || changed) return null;
  return <Badge tone="info">{label}</Badge>;
}

/**
 * Rate customer: the four anchored scales, age band and industry (they feed Fit), gut stars and notes, with
 * a live score preview from the same pure scoring the server uses. A stored value cannot be emptied here (a
 * rating only adds), so "Reset" goes back to the stored value.
 */
export function RateForm({
  action,
  initial,
  sources,
  ageBands,
  industries,
  gcc,
  preview,
  returnTo,
  lastRated,
}: {
  action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  initial: RateValues;
  sources: Record<string, FieldSource>;
  ageBands: Item[];
  industries: Item[];
  gcc: boolean;
  preview: RatePreviewProps;
  returnTo: string;
  /** "Last rated by Asha Nair on 7 Oct" */
  lastRated?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [, startTransition] = useTransition();
  const [v, setV] = useState<RateValues>(initial);
  const [notes, setNotes] = useState("");
  const [showGcc, setShowGcc] = useState(gcc);
  const [starKey, setStarKey] = useState(0);

  const set = <K extends keyof RateValues>(k: K, value: RateValues[K] | null) =>
    setV((prev) => ({ ...prev, [k]: value === null ? initial[k] : value }));

  const scores = useMemo(() => {
    const now = new Date(preview.now);
    const base: ScoreContactInput = {
      ...preview.base,
      lastPurchaseAt: preview.base.lastPurchaseAt ? new Date(preview.base.lastPurchaseAt) : null,
      lastInterestAt: preview.base.lastInterestAt ? new Date(preview.base.lastInterestAt) : null,
    };
    const ctx = { locations: preview.locations, gccCountries: preview.gccCountries };
    return {
      before: scoreContact({ ...base, ...initial }, preview.scoring, ctx, now),
      after: scoreContact({ ...base, ...v }, preview.scoring, ctx, now),
    };
  }, [preview, initial, v]);

  const fieldErrors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const changed = (k: keyof RateValues) => v[k] !== initial[k];
  const changedCount = (Object.keys(v) as (keyof RateValues)[]).filter(changed).length;
  // nothing chosen and no note: the server would refuse an empty rating, so don't offer it
  const nothingToSave = Object.values(v).every((x) => x === null) && !notes.trim();
  const resetButton = (k: keyof RateValues) =>
    changed(k) ? (
      <button
        type="button"
        onClick={() => set(k, null)}
        className="-my-2 inline-flex h-10 items-center rounded-md px-2 text-xs font-medium text-muted underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Reset
      </button>
    ) : null;

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => formAction(fd));
      }}
      className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start"
      noValidate
    >
      <input type="hidden" name="return" value={returnTo} />
      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-4 py-5 sm:px-6 lg:overflow-visible lg:border-r lg:border-border">
        {lastRated && <p className="rounded-lg bg-surface-muted px-3 py-2 text-xs text-muted sm:hidden">{lastRated}</p>}
        <ScaleRadios
          name="aiLevel"
          legend="AI knowledge"
          hint="What you hear on the call"
          badge={<SourceBadge source={sources.ai_level} changed={changed("aiLevel")} />}
          anchors={AI_KNOWLEDGE_SCALE}
          value={v.aiLevel}
          onChange={(x) => set("aiLevel", x)}
          canClear={changed("aiLevel")}
          clearLabel="Reset"
        />
        <ScaleRadios
          name="umerLevel"
          legend="Umer familiarity"
          hint="What you hear on the call"
          badge={<SourceBadge source={sources.umer_level} changed={changed("umerLevel")} />}
          anchors={UMER_FAMILIARITY_SCALE}
          value={v.umerLevel}
          onChange={(x) => set("umerLevel", x)}
          canClear={changed("umerLevel")}
          clearLabel="Reset"
        />
        <ScaleRadios
          name="spendingBand"
          legend="Spending power"
          hint={
            <>
              {SPENDING_POWER_HINT}.{" "}
              <span className="font-medium text-foreground">
                {showGcc ? "GCC, monthly income" : "India, yearly income"}
              </span>{" "}
              <button
                type="button"
                onClick={() => setShowGcc((g) => !g)}
                className="-my-2 inline-flex h-10 items-center font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {showGcc ? "Show India bands" : "Show GCC bands"}
              </button>
            </>
          }
          badge={<SourceBadge source={sources.spending_band} changed={changed("spendingBand")} />}
          anchors={SPENDING_POWER_SCALE.map((b) => ({
            value: b.value,
            label: String(b.value),
            text: b.name,
            sub: showGcc ? b.gcc : b.india,
          }))}
          value={v.spendingBand}
          onChange={(x) => set("spendingBand", x)}
          canClear={changed("spendingBand")}
          clearLabel="Reset"
        />

        <RadioChips
          name="ageBand"
          legend="Age band"
          legendExtra={
            <span className="flex items-center gap-2">
              <SourceBadge source={sources.age_band} changed={changed("ageBand")} />
              {resetButton("ageBand")}
            </span>
          }
          options={ageBands.map((a) => ({ value: a.key, label: a.label }))}
          value={v.ageBand}
          onChange={(x) => set("ageBand", x)}
          size="sm"
          error={fieldErrors.ageBand}
        />

        <RadioChips
          name="industry"
          legend="Industry or role"
          legendExtra={
            <span className="flex items-center gap-2">
              <SourceBadge source={sources.industry} changed={changed("industry")} />
              {resetButton("industry")}
            </span>
          }
          options={industries.map((a) => ({ value: a.key, label: a.label }))}
          value={v.industry}
          onChange={(x) => set("industry", x)}
          size="sm"
          error={fieldErrors.industry}
        />

        <div>
          <div className="mb-1 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold" id="gut-label">
              Gut rating
            </p>
            <span className="flex items-center gap-2">
              <SourceBadge source={sources.gut_stars} changed={changed("gutStars")} />
              {changed("gutStars") && (
                <button
                  type="button"
                  onClick={() => {
                    set("gutStars", null);
                    setStarKey((k) => k + 1);
                  }}
                  className="-my-2 inline-flex h-10 items-center rounded-md px-2 text-xs font-medium text-muted underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Reset
                </button>
              )}
            </span>
          </div>
          <p className="mb-2 text-xs text-muted">Your call on overall potential</p>
          <StarInput
            key={starKey}
            name="gutStars"
            defaultValue={v.gutStars}
            onChange={(x) => {
              if (x === null && initial.gutStars !== null) {
                // a stored gut rating cannot be emptied: snap back to it
                set("gutStars", null);
                setStarKey((k) => k + 1);
              } else {
                setV((prev) => ({ ...prev, gutStars: x }));
              }
            }}
          />
        </div>

        <div>
          <label htmlFor="notes" className="mb-1 block text-sm font-semibold">
            Notes <span className="font-normal text-muted">(optional)</span>
          </label>
          <p className="mb-2 text-xs text-muted">What the scales miss, such as “runs three supermarkets, wants AI for stock control”</p>
          <Textarea
            id="notes"
            name="notes"
            rows={3}
            maxLength={2000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            aria-invalid={!!fieldErrors.notes}
          />
        </div>
      </div>

      {/* phone: preview + save pinned at the bottom; laptop: a sticky side card */}
      <div className="border-t border-border bg-surface px-4 py-3 safe-bottom sm:px-6 lg:sticky lg:top-6 lg:border-t-0 lg:px-5 lg:py-5">
        <div className="lg:hidden">
          <ScorePreview after={scores.after} before={scores.before} layout="bar" />
        </div>
        <div className="hidden lg:block">
          <p className="mb-3 text-sm font-semibold">Live score</p>
          <ScorePreview after={scores.after} before={scores.before} layout="card" />
        </div>
        {state && !state.ok && (
          <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
            {state.error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending || nothingToSave}
          aria-busy={pending}
          title={nothingToSave ? "Tap at least one scale, or write a note" : undefined}
          className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand text-base font-semibold text-brand-foreground hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 lg:mt-5"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {pending ? "Saving…" : nothingToSave || changedCount || notes.trim() ? "Save rating" : "Confirm rating"}
        </button>
      </div>
    </form>
  );
}

"use client";
/**
 * Client pieces shared by the payment forms: a server-action hook that keeps typed values on error,
 * the proof picker (checked before upload), and the "money received" fields (mode, reference, date, proof).
 */
import { startTransition, useActionState, useCallback, useEffect, useId, useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import type { PaymentMode } from "@/db/schema";
import type { ActionResult } from "@/lib/action";
import { RadioChips } from "@/components/today/choice";
import { PAYMENT_MODE_LABELS } from "@/components/contacts/labels";
import { Checkbox, Field, Input } from "@/components/ui/form";
import { cn } from "@/lib/utils";
import { MAX_PROOF_MB, MODE_ORDER, PROOF_ACCEPT, proofProblem, referenceFieldLabel, referenceRequired } from "./rules";

export { unshownFailure } from "./rules";

export type FormAction = (prev: ActionResult, fd: FormData) => Promise<ActionResult>;

/**
 * useActionState without React's automatic form reset, so typed values (and the chosen file) stay put when
 * the server sends back an error. Moves focus to the first invalid field, or the message, after an error.
 */
export function useFormAction(
  action: FormAction,
  opts: { onSuccess?: (state: ActionResult) => void; confirm?: string } = {},
) {
  // onSuccess runs as soon as the action answers, before React applies the refreshed page: the row holding
  // this form may disappear in that refresh (e.g. a verified payment leaves the queue), so an effect would never run.
  const onSuccessRef = useRef(opts.onSuccess);
  useEffect(() => {
    onSuccessRef.current = opts.onSuccess;
  });
  const run = useCallback(
    async (prev: ActionResult, fd: FormData): Promise<ActionResult> => {
      const res = await action(prev, fd);
      if (res?.ok) onSuccessRef.current?.(res);
      return res;
    },
    [action],
  );
  const [state, dispatch, pending] = useActionState(run, null);
  const formRef = useRef<HTMLFormElement>(null);
  const seen = useRef<ActionResult>(null);
  useEffect(() => {
    if (!state || state === seen.current) return;
    seen.current = state;
    if (state.ok) return;
    const form = formRef.current;
    const target =
      form?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? form?.querySelector<HTMLElement>('[role="alert"]');
    target?.focus();
  }, [state]);
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (opts.confirm && !window.confirm(opts.confirm)) return;
    const fd = new FormData(e.currentTarget);
    startTransition(() => dispatch(fd));
  }
  const fieldErrors: Record<string, string> = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  return { state, pending, onSubmit, formRef, fieldErrors };
}

/** The action's headline error (or success message) under a form. Focusable so it can be announced. */
export function FormAlert({ state, className }: { state: ActionResult; className?: string }) {
  if (!state) return null;
  if (state.ok && !state.message) return null;
  return (
    <p
      role={state.ok ? "status" : "alert"}
      tabIndex={-1}
      className={cn(
        "rounded-lg px-3 py-2 text-sm focus:outline-none",
        state.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger",
        className,
      )}
    >
      {state.ok ? state.message : state.error}
    </p>
  );
}

/** The fields ReceiptFields shows. */
export const RECEIPT_FIELD_NAMES = ["mode", "reference", "paidDate", "proof", "verify"] as const;

/** Image or PDF picker, checked in the browser first (the server checks again). */
export function ProofInput({
  name = "proof",
  id,
  label = "Proof (screenshot or PDF)",
  hint,
  error,
}: {
  name?: string;
  id?: string;
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
}) {
  const auto = useId();
  const inputId = id ?? `proof-${auto}`;
  const ref = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<{ name: string; size: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = problem ?? error ?? null;
  return (
    <Field label={label} htmlFor={inputId} error={shown} hint={hint ?? `Image or PDF, up to ${MAX_PROOF_MB} MB.`}>
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={inputId}
          className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium hover:bg-surface-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
        >
          <Paperclip className="h-4 w-4" aria-hidden />
          {picked ? "Change file" : "Attach file"}
          <input
            ref={ref}
            id={inputId}
            name={name}
            type="file"
            accept={PROOF_ACCEPT}
            className="sr-only"
            aria-invalid={!!shown}
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (!f) {
                setPicked(null);
                setProblem(null);
                return;
              }
              const p = proofProblem({ size: f.size, type: f.type, name: f.name });
              if (p) {
                e.currentTarget.value = "";
                setPicked(null);
                setProblem(p);
                return;
              }
              setProblem(null);
              setPicked({ name: f.name, size: `${(f.size / 1024 / 1024).toFixed(f.size > 1024 * 1024 ? 1 : 2)} MB` });
            }}
          />
        </label>
        {picked && (
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg bg-surface-muted px-2 py-1 text-xs">
            <span className="truncate">{picked.name}</span>
            <span className="shrink-0 text-muted">{picked.size}</span>
            <button
              type="button"
              className="-mr-1 rounded p-0.5 text-muted hover:text-foreground max-sm:-my-2 max-sm:p-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Remove file"
              onClick={() => {
                if (ref.current) ref.current.value = "";
                setPicked(null);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
      </div>
    </Field>
  );
}

const MODE_CHOICES = MODE_ORDER.map((m) => ({ value: m, label: PAYMENT_MODE_LABELS[m] }));

/**
 * Money received: how they paid (chips), the reference (UTR required for bank and UPI, order id for TagMango),
 * the date it came in, the proof, and, for managers, "verified now".
 */
export function ReceiptFields({
  idPrefix,
  defaultMode,
  today,
  errors,
  canVerify,
  dateName = "paidDate",
  dateLabel = "Paid on",
}: {
  idPrefix: string;
  defaultMode?: PaymentMode | null;
  today: string;
  errors: Record<string, string>;
  canVerify: boolean;
  dateName?: string;
  dateLabel?: string;
}) {
  const [mode, setMode] = useState<PaymentMode | null>(defaultMode ?? null);
  const needsRef = referenceRequired(mode);
  return (
    <div className="space-y-4">
      <RadioChips<PaymentMode>
        name="mode"
        legend="How did they pay?"
        options={MODE_CHOICES}
        value={mode}
        onChange={(v) => setMode(v)}
        size="sm"
        error={errors.mode}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={referenceFieldLabel(mode)} htmlFor={`${idPrefix}-reference`} required={needsRef} error={errors.reference}>
          <Input
            id={`${idPrefix}-reference`}
            name="reference"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder={needsRef ? (mode === "tagmango" ? "Order id" : "e.g. 412345678901") : "Optional"}
            aria-invalid={!!errors.reference}
            aria-required={needsRef}
          />
        </Field>
        <Field label={dateLabel} htmlFor={`${idPrefix}-date`} required error={errors[dateName]}>
          <Input
            id={`${idPrefix}-date`}
            name={dateName}
            type="date"
            defaultValue={today}
            max={today}
            required
            aria-invalid={!!errors[dateName]}
          />
        </Field>
      </div>
      <ProofInput id={`${idPrefix}-proof`} error={errors.proof} />
      {canVerify && (
        <div>
          <Checkbox name="verify" label="I've checked the bank: mark it verified now" aria-invalid={!!errors.verify} />
          {errors.verify && <p className="mt-1 text-xs text-danger">{errors.verify}</p>}
        </div>
      )}
    </div>
  );
}

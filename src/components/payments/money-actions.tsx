"use client";
/**
 * The buttons that move money on the payments desk and the purchase page. Each opens a sheet (a bottom sheet on
 * phones, a dialog on laptops) with a small form bound to a server action passed in by the page. The server
 * checks every permission again; these only hide what the user cannot do.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { Ban, Check, Loader2, Plus, RotateCcw, Wallet, X } from "lucide-react";
import type { PaymentMode } from "@/db/schema";
import type { ActionResult } from "@/lib/action";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Sheet } from "@/components/ui/sheet";
import { formatAmount } from "@/components/contacts/labels";
import { cn } from "@/lib/utils";
import { FormAlert, RECEIPT_FIELD_NAMES, ReceiptFields, unshownFailure, useFormAction, type FormAction } from "./form-kit";

// ---------------------------------------------------------------------------
// Page-level announcements (the row that held the button may disappear after a save)
// ---------------------------------------------------------------------------

const EVENT = "edapt:payments-toast";

export function announce(message: string) {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: message }));
}

/** Put once on a page: shows the last success message for a few seconds and reads it to screen readers. */
export function PaymentsToaster() {
  const [msg, setMsg] = useState<{ text: string; key: number } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setMsg({ text: (e as CustomEvent<string>).detail, key: Date.now() });
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(null), 5000);
    return () => window.clearTimeout(t);
  }, [msg]);
  return (
    <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 lg:bottom-8">
      {msg && (
        <div
          key={msg.key}
          className="pointer-events-auto flex max-w-md items-center gap-2 rounded-xl bg-foreground px-4 py-3 text-sm text-white shadow-lg"
        >
          <Check className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0">{msg.text}</span>
          <button
            type="button"
            onClick={() => setMsg(null)}
            className="-mr-1 rounded p-0.5 text-white/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

/** Small buttons stay 40px tall on phones (tap target). */
const TAP = "max-sm:h-10";

function useSheet() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return { open, setOpen, close };
}

function SubmitRow({ pending, label, pendingLabel, onCancel, variant = "primary" }: {
  pending: boolean;
  label: string;
  pendingLabel: string;
  onCancel: () => void;
  variant?: ButtonProps["variant"];
}) {
  return (
    <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" variant={variant} disabled={pending} aria-busy={pending}>
        {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {pending ? pendingLabel : label}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verify / reject
// ---------------------------------------------------------------------------

export function VerifyButton({
  action,
  paymentId,
  label = "Verify",
  size = "sm",
  className,
}: {
  action: FormAction;
  paymentId: string;
  label?: string;
  size?: ButtonProps["size"];
  className?: string;
}) {
  const onSuccess = useCallback((s: ActionResult) => {
    if (s?.ok && s.message) announce(s.message);
  }, []);
  const { state, pending, onSubmit, formRef } = useFormAction(action, { onSuccess });
  return (
    <form ref={formRef} onSubmit={onSubmit} className={cn("inline-flex flex-col items-start", className)}>
      <input type="hidden" name="paymentId" value={paymentId} />
      <Button type="submit" variant="success" size={size} className={TAP} disabled={pending} aria-busy={pending}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
        {label}
      </Button>
      {state && !state.ok && (
        <p role="alert" tabIndex={-1} className="mt-1 max-w-56 text-xs text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}

const QUICK_REASONS = [
  "UTR not in the bank statement",
  "Amount doesn't match",
  "Duplicate of another payment",
  "Screenshot unclear",
];

export function RejectButton({
  action,
  paymentId,
  summary,
  size = "sm",
}: {
  action: FormAction;
  paymentId: string;
  /** e.g. "₹24,999 from Asha · UTR 4123…" */
  summary: React.ReactNode;
  size?: ButtonProps["size"];
}) {
  const { open, setOpen, close } = useSheet();
  const id = useId();
  const [reason, setReason] = useState("");
  const onSuccess = useCallback(
    (s: ActionResult) => {
      close();
      setReason("");
      if (s?.ok && s.message) announce(s.message);
    },
    [close],
  );
  const { state, pending, onSubmit, formRef, fieldErrors } = useFormAction(action, { onSuccess });
  return (
    <>
      <Button variant="outline" size={size} className={TAP} onClick={() => setOpen(true)}>
        <X className="h-4 w-4" aria-hidden />
        Reject
      </Button>
      <Sheet className="text-left" open={open} onClose={close} title="Reject payment">
        <form ref={formRef} onSubmit={onSubmit} className="space-y-4" noValidate>
          <input type="hidden" name="paymentId" value={paymentId} />
          <p className="text-sm text-muted">{summary}</p>
          <Field label="Why is it rejected?" htmlFor={`${id}-reason`} required error={fieldErrors.reason}>
            <Textarea
              id={`${id}-reason`}
              name="reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              aria-invalid={!!fieldErrors.reason}
            />
          </Field>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Common reasons">
            {QUICK_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className="rounded-full border border-border px-3 py-1.5 text-xs font-medium max-sm:min-h-10 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {r}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted">
            The money stays out of LTV. If it was an instalment, the amount goes back on the schedule to collect.
          </p>
          <FormAlert state={unshownFailure(state, ["reason"])} />
          <SubmitRow pending={pending} label="Reject payment" pendingLabel="Rejecting…" onCancel={close} variant="danger" />
        </form>
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------------------
// Money in
// ---------------------------------------------------------------------------

export type InstalmentInfo = {
  id: string;
  seq: number;
  amount: number;
  currency: string;
  mode: PaymentMode | null;
  /** "Due 14 Nov · 2 days overdue" */
  dueText: string;
};

/** Pay a scheduled instalment: amount (defaults to the instalment), mode, UTR, date and proof. */
export function RecordInstalmentButton({
  action,
  instalment,
  contactName,
  today,
  canVerify,
  label = "Record payment",
  size = "sm",
  variant = "primary",
}: {
  action: FormAction;
  instalment: InstalmentInfo;
  contactName: string;
  today: string;
  canVerify: boolean;
  label?: string;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
}) {
  const { open, setOpen, close } = useSheet();
  const id = useId();
  const onSuccess = useCallback(
    (s: ActionResult) => {
      close();
      if (s?.ok && s.message) announce(s.message);
    },
    [close],
  );
  const { state, pending, onSubmit, formRef, fieldErrors } = useFormAction(action, { onSuccess });
  return (
    <>
      <Button variant={variant} size={size} className={TAP} onClick={() => setOpen(true)}>
        <Wallet className="h-4 w-4" aria-hidden />
        {label}
      </Button>
      <Sheet className="text-left" open={open} onClose={close} title={`Instalment ${instalment.seq} · ${contactName}`}>
        <form ref={formRef} onSubmit={onSubmit} className="space-y-4" noValidate encType="multipart/form-data">
          <input type="hidden" name="paymentId" value={instalment.id} />
          <p className="text-sm text-muted">
            {formatAmount(instalment.amount, instalment.currency)} · {instalment.dueText}
          </p>
          <Field
            label={`Amount received (${instalment.currency})`}
            htmlFor={`${id}-amount`}
            required
            error={fieldErrors.amount}
            hint="Less than the instalment leaves the balance due on the same date. More comes off the last instalments."
          >
            <Input
              id={`${id}-amount`}
              name="amount"
              inputMode="decimal"
              defaultValue={String(instalment.amount)}
              aria-invalid={!!fieldErrors.amount}
              className="tabular"
            />
          </Field>
          <ReceiptFields idPrefix={id} defaultMode={instalment.mode} today={today} errors={fieldErrors} canVerify={canVerify} />
          <FormAlert state={unshownFailure(state, ["amount", ...RECEIPT_FIELD_NAMES])} />
          <SubmitRow pending={pending} label="Save payment" pendingLabel="Saving…" onCancel={close} />
        </form>
      </Sheet>
    </>
  );
}

/** A part payment outside the schedule, up to what is left to collect. */
export function AddPaymentButton({
  action,
  purchaseId,
  currency,
  currencies,
  collectable,
  defaultMode,
  today,
  canVerify,
}: {
  action: FormAction;
  purchaseId: string;
  currency: string;
  currencies: string[];
  collectable: number;
  defaultMode: PaymentMode | null;
  today: string;
  canVerify: boolean;
}) {
  const { open, setOpen, close } = useSheet();
  const id = useId();
  const onSuccess = useCallback(
    (s: ActionResult) => {
      close();
      if (s?.ok && s.message) announce(s.message);
    },
    [close],
  );
  const { state, pending, onSubmit, formRef, fieldErrors } = useFormAction(action, { onSuccess });
  const options = currencies.includes(currency) ? currencies : [currency, ...currencies];
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden />
        Add part payment
      </Button>
      <Sheet className="text-left" open={open} onClose={close} title="Add part payment">
        <form ref={formRef} onSubmit={onSubmit} className="space-y-4" noValidate encType="multipart/form-data">
          <input type="hidden" name="purchaseId" value={purchaseId} />
          <p className="text-sm text-muted">Up to {formatAmount(collectable, currency)} is left to collect on this purchase.</p>
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <Field label="Amount received" htmlFor={`${id}-amount`} required error={fieldErrors.amount}>
              <Input
                id={`${id}-amount`}
                name="amount"
                inputMode="decimal"
                defaultValue={collectable > 0 ? String(collectable) : ""}
                aria-invalid={!!fieldErrors.amount}
                className="tabular"
              />
            </Field>
            <Field label="Currency" htmlFor={`${id}-currency`} error={fieldErrors.currency}>
              <Select id={`${id}-currency`} name="currency" defaultValue={currency} options={options.map((c) => ({ value: c, label: c }))} />
            </Field>
          </div>
          <ReceiptFields idPrefix={id} defaultMode={defaultMode} today={today} errors={fieldErrors} canVerify={canVerify} />
          <FormAlert state={unshownFailure(state, ["amount", "currency", ...RECEIPT_FIELD_NAMES])} />
          <SubmitRow pending={pending} label="Save payment" pendingLabel="Saving…" onCancel={close} />
        </form>
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------------------
// Refund, cancel, credit
// ---------------------------------------------------------------------------

export function RefundButton({
  action,
  purchaseId,
  currency,
  maxRefund,
  today,
}: {
  action: FormAction;
  purchaseId: string;
  currency: string;
  /** verified money net of earlier refunds, in the purchase currency */
  maxRefund: number;
  today: string;
}) {
  const { open, setOpen, close } = useSheet();
  const id = useId();
  const onSuccess = useCallback(
    (s: ActionResult) => {
      close();
      if (s?.ok && s.message) announce(s.message);
    },
    [close],
  );
  const { state, pending, onSubmit, formRef, fieldErrors } = useFormAction(action, { onSuccess });
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <RotateCcw className="h-4 w-4" aria-hidden />
        Record refund
      </Button>
      <Sheet className="text-left" open={open} onClose={close} title="Record refund">
        <form ref={formRef} onSubmit={onSubmit} className="space-y-4" noValidate>
          <input type="hidden" name="purchaseId" value={purchaseId} />
          <p className="text-sm text-muted">
            You can refund up to {formatAmount(maxRefund, currency)}, the verified money received. LTV drops by the refund.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={`Amount refunded (${currency})`} htmlFor={`${id}-amount`} required error={fieldErrors.amount}>
              <Input
                id={`${id}-amount`}
                name="amount"
                inputMode="decimal"
                defaultValue={String(maxRefund)}
                aria-invalid={!!fieldErrors.amount}
                className="tabular"
              />
            </Field>
            <Field label="Refunded on" htmlFor={`${id}-date`} required error={fieldErrors.refundDate}>
              <Input id={`${id}-date`} name="refundDate" type="date" defaultValue={today} max={today} aria-invalid={!!fieldErrors.refundDate} />
            </Field>
          </div>
          <Field label="Reason" htmlFor={`${id}-reason`} required error={fieldErrors.reason}>
            <Textarea id={`${id}-reason`} name="reason" rows={2} maxLength={500} aria-invalid={!!fieldErrors.reason} />
          </Field>
          <Field label="Refund reference" htmlFor={`${id}-ref`} hint="Bank reference of the refund, if any." error={fieldErrors.reference}>
            <Input id={`${id}-ref`} name="reference" autoComplete="off" spellCheck={false} aria-invalid={!!fieldErrors.reference} />
          </Field>
          <FormAlert state={unshownFailure(state, ["amount", "refundDate", "reason", "reference"])} />
          <SubmitRow pending={pending} label="Record refund" pendingLabel="Saving…" onCancel={close} variant="danger" />
        </form>
      </Sheet>
    </>
  );
}

export function CancelPurchaseButton({ action, purchaseId }: { action: FormAction; purchaseId: string }) {
  const { open, setOpen, close } = useSheet();
  const id = useId();
  const onSuccess = useCallback(
    (s: ActionResult) => {
      close();
      if (s?.ok && s.message) announce(s.message);
    },
    [close],
  );
  const { state, pending, onSubmit, formRef, fieldErrors } = useFormAction(action, { onSuccess });
  return (
    <>
      <Button variant="ghost" className="text-danger hover:bg-danger/10" onClick={() => setOpen(true)}>
        <Ban className="h-4 w-4" aria-hidden />
        Cancel purchase
      </Button>
      <Sheet className="text-left" open={open} onClose={close} title="Cancel this purchase?">
        <form ref={formRef} onSubmit={onSubmit} className="space-y-4" noValidate>
          <input type="hidden" name="purchaseId" value={purchaseId} />
          <p className="text-sm text-muted">
            Use this for a purchase recorded by mistake or abandoned before any money was verified. Scheduled instalments and
            unverified claims are rejected, and its UTRs can be recorded again.
          </p>
          <Field label="Reason" htmlFor={`${id}-reason`} required error={fieldErrors.reason}>
            <Textarea
              id={`${id}-reason`}
              name="reason"
              rows={2}
              maxLength={500}
              placeholder="e.g. Recorded on the wrong contact"
              aria-invalid={!!fieldErrors.reason}
            />
          </Field>
          <FormAlert state={unshownFailure(state, ["reason"])} />
          <SubmitRow pending={pending} label="Cancel purchase" pendingLabel="Cancelling…" onCancel={close} variant="danger" />
        </form>
      </Sheet>
    </>
  );
}

export function CreditForm({
  action,
  purchaseId,
  current,
  options,
}: {
  action: FormAction;
  purchaseId: string;
  /** user id, or "self" for self-serve */
  current: string;
  options: { value: string; label: string }[];
}) {
  const id = useId();
  const [value, setValue] = useState(current);
  const onSuccess = useCallback((s: ActionResult) => {
    if (s?.ok && s.message) announce(s.message);
  }, []);
  const { state, pending, onSubmit, formRef, fieldErrors } = useFormAction(action, { onSuccess });
  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-2" noValidate>
      <input type="hidden" name="purchaseId" value={purchaseId} />
      <label htmlFor={`${id}-credit`} className="text-xs font-medium text-muted">
        Change credit
      </label>
      <div className="flex gap-2">
        <Select
          id={`${id}-credit`}
          name="creditedUserId"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={!!fieldErrors.creditedUserId}
          className="min-w-0 flex-1"
        >
          <option value="self">Self-serve</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="outline" disabled={pending || value === current} aria-busy={pending}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Save
        </Button>
      </div>
      {state && !state.ok && (
        <p role="alert" tabIndex={-1} className="text-xs text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}

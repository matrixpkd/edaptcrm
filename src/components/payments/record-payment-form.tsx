"use client";
/**
 * Record payment: product (catalogue grouped by ladder rung, or Other), list price / discount / final amount,
 * currency with the live INR value at the month's rate, date, mode, UTR, proof, B2B organisation, notes and an
 * optional instalment schedule. Laptop-first, works at 390px. The server action re-validates everything.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarClock, Info, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import type { PaymentMode } from "@/db/schema";
import type { CurrencyConfig, ProductFamily } from "@/lib/settings/defaults";
import { rateFromTable, roundMoney, toInr } from "@/lib/money/fx";
import { RadioChips } from "@/components/today/choice";
import { PAYMENT_MODE_LABELS, formatAmount } from "@/components/contacts/labels";
import { Button, buttonClass } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { cn, formatINR } from "@/lib/utils";
import { FormAlert, ProofInput, useFormAction, type FormAction } from "./form-kit";
import {
  MAX_INSTALMENTS,
  MIN_INSTALMENTS,
  MODE_ORDER,
  addMonthsYmd,
  convertPrice,
  discountFromFinal,
  finalFromDiscount,
  groupProducts,
  isYmd,
  monthlyDueDates,
  parseAmount,
  referenceFieldLabel,
  referenceRequired,
  scheduleProblem,
  scheduleTotal,
  sortSchedule,
  splitEvenly,
  type ProductOption,
  type ScheduleInterval,
  type ScheduleRow,
} from "./rules";

export type RecordPaymentFormProps = {
  action: FormAction;
  cancelHref: string;
  products: ProductOption[];
  families: ProductFamily[];
  /** enabled currencies that have a rate, INR first */
  currencies: string[];
  rates: CurrencyConfig["rates"];
  organisations: { id: string; name: string; city: string | null }[];
  defaultOrganisationId: string | null;
  /** "YYYY-MM-DD" in the user's time zone */
  today: string;
  canVerify: boolean;
};

const MODE_CHOICES = MODE_ORDER.map((m) => ({ value: m, label: PAYMENT_MODE_LABELS[m] }));
const MONTH_LABEL = new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/** Noon in India on a local calendar date: the month the rate table is read for. */
function ymdMoment(ymd: string): Date {
  return new Date(`${ymd}T12:00:00+05:30`);
}

function familyLabel(families: ProductFamily[], key: string): string {
  const f = families.find((x) => x.key === key);
  if (!f) return key;
  return f.rung != null ? `${f.label} · rung ${f.rung}` : `${f.label} · ${f.group ?? "side group"}`;
}

export function RecordPaymentForm(props: RecordPaymentFormProps) {
  const { action, products, families, currencies, rates, organisations, today, canVerify } = props;
  const { state, pending, onSubmit, formRef, fieldErrors: fe } = useFormAction(action);

  const groups = useMemo(() => groupProducts(products, families), [products, families]);

  // --- product and amounts
  const [productId, setProductId] = useState("");
  const product = products.find((p) => p.id === productId) ?? null;
  const [currency, setCurrency] = useState(currencies[0] ?? "INR");
  const [listPrice, setListPrice] = useState("");
  const [listTouched, setListTouched] = useState(false);
  const [discount, setDiscount] = useState("");
  const [amount, setAmount] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(today);
  const [mode, setMode] = useState<PaymentMode | null>(null);
  const [verifyNow, setVerifyNow] = useState(false);

  // --- instalments
  const [useInst, setUseInst] = useState(false);
  const [count, setCount] = useState(3);
  const [firstDue, setFirstDue] = useState(today);
  const [repeat, setRepeat] = useState<ScheduleInterval>("monthly");
  const [customDates, setCustomDates] = useState<string[]>([]);
  const [customAmounts, setCustomAmounts] = useState<string[] | null>(null);
  const [firstPaidNow, setFirstPaidNow] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);

  const dateForRates = isYmd(purchaseDate) ? purchaseDate : today;
  const rateFor = (cur: string): number | null => {
    try {
      return rateFromTable(rates, cur, ymdMoment(dateForRates));
    } catch {
      return null;
    }
  };
  const priceIn = (p: ProductOption, cur: string): number | null => {
    if (!(p.listPrice > 0)) return null;
    if (p.currency === cur) return p.listPrice;
    const from = rateFor(p.currency);
    const to = rateFor(cur);
    return from != null && to != null ? convertPrice(p.listPrice, from, to) : null;
  };
  const asText = (n: number | null) => (n == null ? "" : String(n));

  function pickProduct(id: string) {
    setProductId(id);
    setListTouched(false);
    const p = products.find((x) => x.id === id);
    if (!p) {
      if (id === "other") {
        setListPrice("");
        setDiscount("");
      }
      return;
    }
    const cur = currencies.includes(p.currency) ? p.currency : currency;
    setCurrency(cur);
    const price = asText(priceIn(p, cur));
    setListPrice(price);
    setDiscount("");
    setAmount(price);
    setCustomAmounts(null);
  }

  function changeCurrency(cur: string) {
    const prev = currency;
    setCurrency(cur);
    if (!product || listTouched) return;
    // the catalogue price follows the currency; a typed discount is converted with it
    const price = priceIn(product, cur);
    setListPrice(asText(price));
    const d = parseAmount(discount);
    const from = rateFor(prev);
    const to = rateFor(cur);
    const nextDiscount = d != null && from != null && to != null ? convertPrice(d, from, to) : null;
    setDiscount(nextDiscount ? String(nextDiscount) : "");
    const f = finalFromDiscount(price, nextDiscount);
    if (f != null) setAmount(String(f));
  }

  function changeList(v: string) {
    setListPrice(v);
    setListTouched(true);
    const f = finalFromDiscount(parseAmount(v), parseAmount(discount));
    if (f != null) setAmount(String(f));
  }
  function changeDiscount(v: string) {
    setDiscount(v);
    const f = finalFromDiscount(parseAmount(listPrice), parseAmount(v));
    if (f != null) setAmount(String(f));
  }
  function changeAmount(v: string) {
    setAmount(v);
    const lp = parseAmount(listPrice);
    if (lp != null) {
      const d = discountFromFinal(lp, parseAmount(v));
      setDiscount(d ? String(d) : "");
    }
  }

  // --- derived money
  const total = parseAmount(amount);
  const rate = rateFor(currency);
  const inr = total != null && total > 0 && rate != null ? toInr(total, rate) : null;

  // --- derived schedule
  const monthly = monthlyDueDates(isYmd(firstDue) ? firstDue : today, count);
  const dates = repeat === "monthly" ? monthly : Array.from({ length: count }, (_, i) => customDates[i] ?? monthly[i]);
  const autoAmounts = total != null && total > 0 ? splitEvenly(total, count).map(String) : Array<string>(count).fill("");
  const amountTexts = customAmounts ? Array.from({ length: count }, (_, i) => customAmounts[i] ?? "") : autoAmounts;
  const rows: ScheduleRow[] = dates.map((d, i) => ({ dueDate: d, amount: parseAmount(amountTexts[i]) ?? Number.NaN }));
  const sorted = sortSchedule(rows);
  const outOfOrder = sorted.some((r, i) => r !== rows[i]);
  const scheduleIssue = useInst ? (total != null && total > 0 ? scheduleProblem(rows, total) : "Enter the final amount first.") : null;
  const scheduleSum = scheduleTotal(rows.filter((r) => Number.isFinite(r.amount)));

  const paysNow = !useInst || firstPaidNow;
  const paidNowAmount = !total ? 0 : !useInst ? total : firstPaidNow ? (Number.isFinite(sorted[0]?.amount) ? sorted[0].amount : 0) : 0;
  const laterAmount = total ? Math.max(0, roundMoney(total - paidNowAmount)) : 0;

  function changeCount(n: number) {
    const next = Math.min(MAX_INSTALMENTS, Math.max(MIN_INSTALMENTS, n));
    if (repeat === "custom") {
      const extended = Array.from({ length: next }, (_, i) => {
        if (dates[i]) return dates[i];
        const last = dates[dates.length - 1] ?? today;
        return addMonthsYmd(last, i - dates.length + 1) ?? last;
      });
      setCustomDates(extended);
    }
    setCount(next);
    setCustomAmounts(null);
  }
  function editDate(i: number, v: string) {
    const next = [...dates];
    next[i] = v;
    setCustomDates(next);
    setRepeat("custom");
  }
  function editAmount(i: number, v: string) {
    const next = [...amountTexts];
    next[i] = v;
    setCustomAmounts(next);
  }
  function changeInterval(v: ScheduleInterval) {
    if (v === "custom") setCustomDates(dates);
    setRepeat(v);
  }

  const groupError = fe.instalments ?? localError;
  const scheduleJson = JSON.stringify(rows.map((r) => ({ dueDate: r.dueDate, amount: Number.isFinite(r.amount) ? r.amount : null })));
  const unknownRate = rate == null;

  return (
    <form
      ref={formRef}
      noValidate
      encType="multipart/form-data"
      onSubmit={(e) => {
        if (useInst && scheduleIssue) {
          e.preventDefault();
          setLocalError(scheduleIssue);
          document.getElementById("rp-schedule")?.focus();
          return;
        }
        setLocalError(null);
        onSubmit(e);
      }}
      className="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6"
    >
      <div className="space-y-4">
        {/* ---------------- Product */}
        <Section id="rp-s-product" title="What did they buy?">
          <Field label="Product" htmlFor="rp-product" required error={fe.productId}>
            <Select
              id="rp-product"
              name="productId"
              value={productId}
              onChange={(e) => pickProduct(e.target.value)}
              aria-invalid={!!fe.productId}
            >
              <option value="">Choose a product…</option>
              {groups.map((g) => (
                <optgroup key={g.key} label={g.label}>
                  {g.products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {formatAmount(p.listPrice, p.currency)}
                    </option>
                  ))}
                </optgroup>
              ))}
              <option value="other">Other (not in the catalogue)</option>
            </Select>
          </Field>
          {product && (
            <p className="-mt-2 text-xs text-muted">
              {familyLabel(families, product.family)} · list price {formatAmount(product.listPrice, product.currency)}
            </p>
          )}
          {productId === "other" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Product name" htmlFor="rp-name" required error={fe.productName}>
                <Input id="rp-name" name="productName" maxLength={200} autoComplete="off" aria-invalid={!!fe.productName} />
              </Field>
              <Field label="Product family" htmlFor="rp-family" required error={fe.family} hint="Decides the ladder rung it counts for.">
                <Select id="rp-family" name="family" defaultValue="" aria-invalid={!!fe.family}>
                  <option value="">Choose a family…</option>
                  {families.map((f) => (
                    <option key={f.key} value={f.key}>
                      {familyLabel(families, f.key)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          <Field
            label="B2B organisation"
            htmlFor="rp-org"
            error={fe.organisationId}
            hint="For a school, constituency office or company deal. The contact is the person who signed."
          >
            <Select id="rp-org" name="organisationId" defaultValue={props.defaultOrganisationId ?? ""} aria-invalid={!!fe.organisationId}>
              <option value="">None (individual purchase)</option>
              {organisations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.city ? ` · ${o.city}` : ""}
                </option>
              ))}
            </Select>
          </Field>
        </Section>

        {/* ---------------- Amount */}
        <Section id="rp-s-amount" title="Amount">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Currency" htmlFor="rp-currency" error={fe.currency} className="col-span-2 sm:col-span-1">
              <Select
                id="rp-currency"
                name="currency"
                value={currency}
                onChange={(e) => changeCurrency(e.target.value)}
                aria-invalid={!!fe.currency}
                options={currencies.map((c) => ({ value: c, label: c }))}
              />
            </Field>
            <Field label="List price" htmlFor="rp-list" error={fe.listPrice}>
              <Input
                id="rp-list"
                name="listPrice"
                inputMode="decimal"
                value={listPrice}
                onChange={(e) => changeList(e.target.value)}
                placeholder="—"
                className="tabular"
                aria-invalid={!!fe.listPrice}
              />
            </Field>
            <Field label="Discount" htmlFor="rp-discount" error={fe.discount}>
              <Input
                id="rp-discount"
                name="discount"
                inputMode="decimal"
                value={discount}
                onChange={(e) => changeDiscount(e.target.value)}
                placeholder="0"
                className="tabular"
                aria-invalid={!!fe.discount}
              />
            </Field>
            <Field label="Final amount" htmlFor="rp-amount" required error={fe.amount} className="col-span-2 sm:col-span-1">
              <Input
                id="rp-amount"
                name="amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => changeAmount(e.target.value)}
                className="tabular font-semibold"
                aria-invalid={!!fe.amount}
                aria-describedby="rp-inr"
              />
            </Field>
          </div>
          <p id="rp-inr" className="text-sm" aria-live="polite">
            {currency === "INR" ? (
              <span className="text-muted">Recorded in INR, the base currency.</span>
            ) : unknownRate ? (
              <span className="text-danger">No INR rate is set for {currency}. Add it in Settings &gt; Currency.</span>
            ) : (
              <>
                <span className="font-medium">≈ {inr != null ? formatINR(inr) : "₹—"}</span>
                <span className="text-muted">
                  {" "}
                  at ₹{rate} per {currency} ({MONTH_LABEL.format(ymdMoment(dateForRates))} rate). Saved with the payment so LTV never shifts.
                </span>
              </>
            )}
          </p>
        </Section>

        {/* ---------------- Payment */}
        <Section id="rp-s-payment" title="Payment">
          <RadioChips<PaymentMode>
            name="mode"
            legend="How did they pay?"
            options={MODE_CHOICES}
            value={mode}
            onChange={setMode}
            size="sm"
            error={fe.mode}
          />
          <Field label="Purchase date" htmlFor="rp-date" required error={fe.purchaseDate} className="sm:max-w-[12rem]">
            <Input
              id="rp-date"
              name="purchaseDate"
              type="date"
              value={purchaseDate}
              max={today}
              onChange={(e) => setPurchaseDate(e.target.value)}
              aria-invalid={!!fe.purchaseDate}
            />
          </Field>

          {/* instalments switch */}
          <div className="rounded-lg border border-border">
            <label className="flex cursor-pointer items-center justify-between gap-3 px-3 py-3">
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <CalendarClock className="h-4 w-4" aria-hidden /> Pay in instalments
                </span>
                <span className="block text-xs text-muted">One purchase with a schedule; each instalment has its own due date and status.</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                name="instalments"
                checked={useInst}
                onChange={(e) => {
                  setUseInst(e.target.checked);
                  setLocalError(null);
                }}
                aria-checked={useInst}
                className="peer sr-only"
              />
              <span
                aria-hidden
                className="relative h-6 w-11 shrink-0 rounded-full bg-border transition-colors peer-checked:bg-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5"
              />
            </label>

            {useInst && (
              <div
                id="rp-schedule"
                tabIndex={-1}
                className="space-y-4 border-t border-border px-3 py-4 focus:outline-none"
                aria-describedby={groupError ? "rp-schedule-error" : undefined}
              >
                <input type="hidden" name="schedule" value={scheduleJson} />
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Field label="Instalments" htmlFor="rp-count">
                    <Select id="rp-count" value={String(count)} onChange={(e) => changeCount(Number(e.target.value))}>
                      {Array.from({ length: MAX_INSTALMENTS - MIN_INSTALMENTS + 1 }, (_, i) => i + MIN_INSTALMENTS).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Repeats" htmlFor="rp-interval">
                    <Select id="rp-interval" value={repeat} onChange={(e) => changeInterval(e.target.value as ScheduleInterval)}>
                      <option value="monthly">Monthly</option>
                      <option value="custom">Custom dates</option>
                    </Select>
                  </Field>
                  {repeat === "monthly" && (
                    <Field label="First due" htmlFor="rp-first" className="col-span-2 sm:col-span-1">
                      <Input id="rp-first" type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
                    </Field>
                  )}
                </div>

                <div className="overflow-hidden rounded-lg border border-border">
                  <table className="w-full table-fixed text-sm">
                    <caption className="sr-only">Instalment schedule</caption>
                    <colgroup>
                      <col className="w-9 sm:w-12" />
                      <col className="w-[55%] sm:w-auto" />
                      <col />
                    </colgroup>
                    <thead className="bg-surface-muted/60 text-left text-xs uppercase tracking-wide text-muted">
                      <tr>
                        <th scope="col" className="px-2 py-2 font-medium sm:px-3">
                          #
                        </th>
                        <th scope="col" className="px-2 py-2 font-medium">
                          Due date
                        </th>
                        <th scope="col" className="px-2 py-2 font-medium">
                          Amount ({currency})
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const isFirst = sorted[0] === r;
                        return (
                          <tr key={i} className="border-t border-border">
                            <td className="px-2 py-1.5 align-middle text-muted tabular sm:px-3">{i + 1}</td>
                            <td className="px-2 py-1.5">
                              <Input
                                type="date"
                                aria-label={`Instalment ${i + 1} due date`}
                                value={r.dueDate}
                                onChange={(e) => editDate(i, e.target.value)}
                                className="h-9 min-w-0 px-2 sm:px-3"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <div className="flex items-center gap-2">
                                <Input
                                  inputMode="decimal"
                                  aria-label={`Instalment ${i + 1} amount`}
                                  value={amountTexts[i]}
                                  onChange={(e) => editAmount(i, e.target.value)}
                                  className="tabular h-9 min-w-0 px-2 sm:px-3"
                                />
                                {isFirst && firstPaidNow && (
                                  <span className="hidden shrink-0 rounded-full bg-foreground px-2 py-0.5 text-[11px] font-medium text-white sm:inline">
                                    Paid now
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border bg-surface-muted/40">
                        <td className="px-2 py-2 sm:px-3" />
                        <td className="px-2 py-2 text-xs text-muted">Total</td>
                        <td className="px-2 py-2 text-sm font-semibold tabular">
                          {formatAmount(scheduleSum, currency)}
                          {total != null && total > 0 && (
                            <span className="font-normal text-muted"> of {formatAmount(total, currency)}</span>
                          )}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p
                    id="rp-schedule-error"
                    className={cn("text-xs", groupError || scheduleIssue ? "text-danger" : "text-success")}
                    aria-live="polite"
                  >
                    {groupError ?? scheduleIssue ?? "Adds up to the final amount."}
                    {outOfOrder && !groupError && " Dates are saved in due-date order."}
                  </p>
                  {customAmounts && (
                    <Button variant="ghost" size="sm" onClick={() => setCustomAmounts(null)}>
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Split evenly
                    </Button>
                  )}
                </div>

                <Checkbox
                  name="firstPaidNow"
                  checked={firstPaidNow}
                  onChange={(e) => setFirstPaidNow(e.target.checked)}
                  label={
                    <span>
                      The first instalment is paid now
                      {Number.isFinite(sorted[0]?.amount) && total ? (
                        <span className="text-muted"> ({formatAmount(sorted[0].amount, currency)})</span>
                      ) : null}
                    </span>
                  }
                />
              </div>
            )}
          </div>

          {paysNow ? (
            <div className="space-y-4">
              <Field
                label={referenceFieldLabel(mode)}
                htmlFor="rp-reference"
                required={referenceRequired(mode)}
                error={fe.reference}
                hint={
                  referenceRequired(mode)
                    ? "Each UTR or order id can be recorded once, so nothing is counted twice."
                    : mode
                      ? "Optional for cash and other payments."
                      : "Required for bank transfer, UPI and TagMango."
                }
              >
                <Input
                  id="rp-reference"
                  name="reference"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={100}
                  className="font-mono sm:max-w-sm"
                  aria-invalid={!!fe.reference}
                  aria-required={referenceRequired(mode)}
                />
              </Field>
              <ProofInput id="rp-proof" error={fe.proof} hint="The bank or UPI screenshot, or a PDF receipt. Image or PDF, up to 10 MB." />
            </div>
          ) : (
            <p className="flex items-start gap-2 rounded-lg bg-surface-muted px-3 py-2 text-sm text-muted">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              Nothing is paid yet. Record each instalment&apos;s UTR and proof when it comes in, from the Payments desk.
            </p>
          )}
        </Section>

        {/* ---------------- Notes */}
        <Section id="rp-s-notes" title="Notes">
          <div className="space-y-1.5">
            <Textarea
              id="rp-notes"
              name="notes"
              rows={3}
              maxLength={2000}
              aria-label="Notes"
              aria-describedby="rp-notes-hint"
              aria-invalid={!!fe.notes}
            />
            <p id="rp-notes-hint" className={cn("text-xs", fe.notes ? "text-danger" : "text-muted")}>
              {fe.notes ?? "Anything the manager should know when verifying. Optional."}
            </p>
          </div>
        </Section>
      </div>

      {/* ---------------- Summary */}
      <aside className="mt-4 lg:sticky lg:top-8 lg:mt-0" aria-label="Summary">
        <div className="rounded-xl border border-border bg-surface">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Summary</h2>
          </div>
          <dl className="space-y-2.5 px-4 py-3 text-sm">
            <SummaryRow label="Product">
              {product ? product.name : productId === "other" ? "Other product" : <span className="text-muted">Not chosen</span>}
            </SummaryRow>
            <SummaryRow label="Total">
              <span className="font-semibold tabular">{total ? formatAmount(total, currency) : "—"}</span>
            </SummaryRow>
            {currency !== "INR" && (
              <SummaryRow label="In INR">
                <span className="tabular">{inr != null ? formatINR(inr) : "—"}</span>
              </SummaryRow>
            )}
            <SummaryRow label="Paid now">
              <span className="tabular">{paidNowAmount ? formatAmount(paidNowAmount, currency) : formatAmount(0, currency)}</span>
            </SummaryRow>
            {useInst && (
              <SummaryRow label="Scheduled">
                <span className="tabular">
                  {formatAmount(laterAmount, currency)}
                  <span className="text-muted"> in {firstPaidNow ? count - 1 : count}</span>
                </span>
              </SummaryRow>
            )}
            <SummaryRow label="Mode">{mode ? PAYMENT_MODE_LABELS[mode] : <span className="text-muted">Not chosen</span>}</SummaryRow>
          </dl>
          <div className="space-y-3 border-t border-border px-4 py-3">
            <p className="flex items-start gap-2 rounded-lg bg-surface-muted px-3 py-2 text-xs leading-relaxed">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                <strong className="font-semibold">Bank and UPI payments count toward LTV only after a manager verifies them.</strong>{" "}
                {paysNow
                  ? canVerify
                    ? "Tick below if you have already checked the bank."
                    : "It shows as Unverified on the Payments desk until then."
                  : "Nothing counts until an instalment is paid and verified."}
              </span>
            </p>
            {canVerify && paysNow && (
              <div>
                <Checkbox
                  name="verifyNow"
                  checked={verifyNow}
                  onChange={(e) => setVerifyNow(e.target.checked)}
                  label="I've checked the bank: mark it verified"
                />
                {fe.verifyNow && <p className="mt-1 text-xs text-danger">{fe.verifyNow}</p>}
              </div>
            )}
            <FormAlert state={state && !state.ok ? state : null} />
            <Button type="submit" size="lg" className="w-full" disabled={pending} aria-busy={pending}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {pending ? "Saving…" : useInst ? "Save purchase and schedule" : "Record payment"}
            </Button>
            <Link href={props.cancelHref} className={buttonClass("ghost", "md", "w-full")}>
              Cancel
            </Link>
          </div>
        </div>
      </aside>
    </form>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-xl border border-border bg-surface">
      <div className="border-b border-border px-4 py-3">
        <h2 id={id} className="text-sm font-semibold">
          {title}
        </h2>
      </div>
      <div className="space-y-4 p-4">{children}</div>
    </section>
  );
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

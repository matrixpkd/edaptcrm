"use client";
import Link from "next/link";
import { startTransition, useActionState, useEffect, useId, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, UserRound } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { Field, FormMessage, Input, Select, Textarea, type Option } from "@/components/ui/form";
import { ChipGroup } from "@/components/ui/chips";
import { GradeBadge, STAGE_LABELS } from "@/components/ui/badge";
import { ActionForm } from "@/components/contacts/action-form";
import { SubmitButton } from "@/components/ui/submit-button";
import { countryName } from "@/components/contacts/labels";
import type { Stage } from "@/db/schema";
import { cn } from "@/lib/utils";
import { quickAddAction } from "./actions";
import { requestTransferAction } from "../[id]/actions";
import type { PhoneCheckResponse } from "./types";

type Check =
  | { status: "idle" }
  | { status: "checking"; last: PhoneCheckResponse | null }
  | { status: "done"; result: PhoneCheckResponse; phone: string }
  | { status: "error" };

const MIN_DIGITS = 6;
const FORM_ID = "quick-add-form";
const MORE_FIELDS = ["email", "campaign", "language", "tags", "note", "referrerPhone", "ownerId"];

export function QuickAddForm({
  commonChannels,
  otherChannels,
  firstDoors,
  campaigns,
  languages,
  tags,
  owners,
  canRequestTransfer,
  defaultPhone,
  cities = [],
}: {
  commonChannels: Option[];
  otherChannels: Option[];
  firstDoors: Option[];
  campaigns: Option[];
  languages: Option[];
  tags: Option[];
  /** manager/admin only: who may own the new lead */
  owners: Option[] | null;
  canRequestTransfer: boolean;
  defaultPhone?: string;
  /** city search dropdown suggestions (free text still allowed) */
  cities?: string[];
}) {
  const [state, dispatch, pending] = useActionState(quickAddAction, null);
  const [phone, setPhone] = useState(defaultPhone ?? "");
  const [phoneBlurred, setPhoneBlurred] = useState(false);
  const [check, setCheck] = useState<Check>({ status: "idle" });
  const [channel, setChannel] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const ids = { phone: useId(), name: useId(), door: useId(), other: useId(), status: useId() };

  // the live duplicate check, ~300 ms after typing stops; stale requests are cancelled
  useEffect(() => {
    const raw = phone.trim();
    const digits = raw.replace(/\D/g, "");
    if (digits.length < MIN_DIGITS) {
      setCheck({ status: "idle" });
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setCheck((c) => ({
        status: "checking",
        last: c.status === "done" ? c.result : c.status === "checking" ? c.last : null,
      }));
      try {
        const res = await fetch(`/contacts/new/check?phone=${encodeURIComponent(raw)}`, {
          signal: ctrl.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        const result = (await res.json()) as PhoneCheckResponse;
        setCheck({ status: "done", result, phone: raw });
      } catch {
        if (!ctrl.signal.aborted) setCheck({ status: "error" });
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [phone]);

  // only ever show a result for what is in the box now (a slow answer for an older value is ignored)
  const current = phone.trim();
  const fresh = check.status === "done" && check.phone === current;
  const result = fresh ? check.result : check.status === "checking" ? check.last : null;
  const existing = result?.existing ?? null;
  // a known number the user may open: the enquiry can be added to that record (rule 2: the owner stays)
  const attachTo = existing?.visible ? existing.id : null;
  const digits = phone.replace(/\D/g, "");
  const showInvalid = fresh && !check.result.valid && (phoneBlurred || digits.length >= 10);
  const fe = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const otherSelected = otherChannels.some((o) => o.value === channel);

  // an error on an optional field must never hide behind a closed "More"
  useEffect(() => {
    if (!state || state.ok || !state.fieldErrors) return;
    if (MORE_FIELDS.some((f) => state.fieldErrors?.[f])) setMoreOpen(true);
  }, [state]);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (existing && !attachTo) return;
    const fd = new FormData(e.currentTarget);
    // dispatching by hand keeps what was typed when the server sends back an error
    startTransition(() => dispatch(fd));
  }

  return (
    <div className="space-y-5">
      {/* Phone sits outside the main form (it is linked with form=…) so the duplicate card can hold its own form */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.phone} className="text-sm font-medium">
          Phone<span className="ml-0.5 text-danger">*</span>
        </label>
        <Input
          id={ids.phone}
          name="phone"
          form={FORM_ID}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          autoFocus
          required
          placeholder="98470 12345 or 050 123 4567"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            setPhoneBlurred(false);
          }}
          onBlur={() => setPhoneBlurred(true)}
          aria-invalid={!!fe.phone || showInvalid || !!existing}
          aria-describedby={`${ids.phone}-status`}
          className="h-12 text-lg tracking-wide"
        />
        <div id={`${ids.phone}-status`} aria-live="polite" className="min-h-5 text-sm">
          {check.status === "idle" && !fe.phone && (
            <span className="text-muted">Known numbers show up here as you type, before anything is saved.</span>
          )}
          {check.status === "checking" && !existing && (
            <span className="inline-flex items-center gap-1.5 text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Checking the number…
            </span>
          )}
          {fresh && result?.valid && !existing && (
            <span className="flex items-start gap-1.5 text-success">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                New number <span className="tabular whitespace-nowrap font-semibold">{result.international}</span>
                {result.country && <span className="text-muted"> · {countryName(result.country)}</span>}
              </span>
            </span>
          )}
          {showInvalid && (
            <span className="text-danger">Not a valid number yet. Add the country code for numbers outside India.</span>
          )}
          {check.status === "error" && (
            <span className="text-muted">Could not check the number. It is checked again when you save.</span>
          )}
          {fe.phone && !existing && <span className="block text-danger">{fe.phone}</span>}
        </div>
        {existing && result && (
          <ExistingContact
            existing={existing}
            international={result.international}
            canRequestTransfer={canRequestTransfer}
          />
        )}
      </div>

      <form id={FORM_ID} onSubmit={submit} noValidate className="space-y-5" aria-describedby={ids.status}>
        {/* Name and first door are kept from the record when the enquiry joins a known contact */}
        <div hidden={!!attachTo}>
          {/* Name */}
          <Field label="Name" htmlFor={ids.name} required error={fe.name}>
            <Input
              id={ids.name}
              name="name"
              autoComplete="off"
              autoCapitalize="words"
              required
              className="h-12 text-base"
              aria-invalid={!!fe.name}
            />
          </Field>
        </div>

        {/* Channel */}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">
            Channel<span className="ml-0.5 text-danger">*</span>
            <span className="ml-2 font-normal text-muted">How did this enquiry reach us?</span>
          </legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Most used channels">
            {commonChannels.map((o) => {
              const on = channel === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setChannel(on ? "" : o.value)}
                  className={cn(
                    "min-h-11 rounded-full border px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    on
                      ? "border-foreground bg-foreground text-white"
                      : "border-border bg-surface hover:bg-surface-muted",
                  )}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          {otherChannels.length > 0 && (
            <div>
              <label htmlFor={ids.other} className="sr-only">
                Other channel
              </label>
              <Select
                id={ids.other}
                value={otherSelected ? channel : ""}
                onChange={(e) => setChannel(e.target.value)}
                className={cn("h-11", otherSelected && "border-foreground")}
                placeholder="Other channel…"
                options={otherChannels}
              />
            </div>
          )}
          <input type="hidden" name="channel" value={channel} />
          {fe.channel && <p className="text-xs text-danger">{fe.channel}</p>}
        </fieldset>

        <div hidden={!!attachTo}>
          {/* First door */}
          <Field
            label="First door"
            htmlFor={ids.door}
            required
            error={fe.firstDoor}
            hint="How they first came to know Edapt or Umer. Stored forever."
          >
            <Select
              id={ids.door}
              name="firstDoor"
              required
              defaultValue=""
              placeholder="Choose…"
              options={firstDoors}
              className="h-12"
              aria-invalid={!!fe.firstDoor}
            />
          </Field>
        </div>

        {/* More */}
        <div className="rounded-xl border border-border">
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            aria-expanded={moreOpen}
            aria-controls="quick-add-more"
            className="flex w-full items-center justify-between rounded-xl px-4 py-3 text-left text-sm font-medium hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>
              More{" "}
              <span className="font-normal text-muted">
                (optional: email, campaign, city, language, tags, note, referrer)
              </span>
            </span>
            <ChevronDown
              className={cn("h-4 w-4 shrink-0 transition-transform", moreOpen && "rotate-180")}
              aria-hidden
            />
          </button>
          {/* kept in the DOM when closed so typed values are not lost */}
          <div id="quick-add-more" hidden={!moreOpen} className="space-y-4 border-t border-border px-4 py-4">
            <Field label="Email" htmlFor="qa-email" error={fe.email}>
              <Input
                id="qa-email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="off"
                aria-invalid={!!fe.email}
              />
            </Field>
            {campaigns.length > 0 && (
              <Field label="Campaign" htmlFor="qa-campaign" error={fe.campaign}>
                <Select id="qa-campaign" name="campaign" defaultValue="" placeholder="None" options={campaigns} />
              </Field>
            )}
            <Field label="City" htmlFor="qa-city">
              <Input id="qa-city" name="city" autoComplete="off" autoCapitalize="words" list="qa-city-list" />
              <datalist id="qa-city-list">
                {cities.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium" id="qa-lang">
                Preferred language
              </span>
              <div role="group" aria-labelledby="qa-lang">
                <ChipGroup name="language" options={languages} />
              </div>
              {fe.language && <p className="text-xs text-danger">{fe.language}</p>}
            </div>
            {tags.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium" id="qa-tags">
                  Tags
                </span>
                <div role="group" aria-labelledby="qa-tags">
                  <ChipGroup name="tags" options={tags} multiple />
                </div>
              </div>
            )}
            <Field label="Note" htmlFor="qa-note" error={fe.note} hint="What they asked about, in a line or two.">
              <Textarea id="qa-note" name="note" rows={2} />
            </Field>
            <Field
              label="Referred by (phone)"
              htmlFor="qa-ref"
              error={fe.referrerPhone}
              hint="Links the person who sent them; new numbers are added too."
            >
              <Input id="qa-ref" name="referrerPhone" type="tel" inputMode="tel" autoComplete="off" />
            </Field>
            {owners && (
              <Field
                label="Owner"
                htmlFor="qa-owner"
                error={fe.ownerId}
                hint="Auto-assign follows the team and round robin rules."
              >
                <Select id="qa-owner" name="ownerId" defaultValue="auto">
                  <option value="auto">Auto-assign</option>
                  <option value="me">Me</option>
                  {owners.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        </div>

        <div id={ids.status}>{state && !state.ok && <FormMessage state={state} />}</div>

        {attachTo && <input type="hidden" name="attachTo" value={attachTo} />}
        <Button type="submit" size="lg" className="w-full" disabled={pending || (!!existing && !attachTo)} aria-busy={pending}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {pending
            ? "Saving…"
            : existing
              ? attachTo
                ? `Add this enquiry to ${existing.name}`
                : "Already in the CRM"
              : "Save contact"}
        </Button>
      </form>
    </div>
  );
}

function ExistingContact({
  existing,
  international,
  canRequestTransfer,
}: {
  existing: NonNullable<PhoneCheckResponse["existing"]>;
  international: string | null;
  canRequestTransfer: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const stage = STAGE_LABELS[existing.stage as Stage] ?? existing.stage;
  return (
    <div role="alert" className="mt-1 rounded-xl border border-warning/40 bg-warning/5 p-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-warning">
        <AlertTriangle className="h-4 w-4" aria-hidden /> Already in the CRM
      </p>
      <div className="mt-2 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-muted" aria-hidden>
          <UserRound className="h-5 w-5 text-muted" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{existing.name}</p>
          <p className="tabular text-sm text-muted">{international}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <GradeBadge grade={existing.grade} size="sm" />
            <span>{stage}</span>
            <span className="text-muted">·</span>
            <span>
              {existing.ownerIsMe ? "Yours" : existing.ownerName ? `Owner: ${existing.ownerName}` : "In the pool"}
            </span>
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {existing.visible ? (
          <>
            <Link href={`/contacts/${existing.id}`} className={buttonClass("primary", "md", "flex-1 sm:flex-none")}>
              Open contact
            </Link>
            <p className="w-full text-sm text-muted">
              A new enquiry from them? Pick the channel below and add it to this record. Name and first door are kept.
            </p>
          </>
        ) : canRequestTransfer ? (
          asking ? null : (
            <Button variant="outline" onClick={() => setAsking(true)} className="flex-1 sm:flex-none">
              Request transfer
            </Button>
          )
        ) : (
          <p className="text-sm text-muted">
            Only {existing.ownerName ?? "their owner"} and managers can open this contact.
          </p>
        )}
      </div>
      {asking && (
        <ActionForm action={requestTransferAction} className="mt-3 space-y-2" aria-label="Request transfer">
          <input type="hidden" name="contactId" value={existing.id} />
          <Field label="Why do you need this contact?" htmlFor="qa-transfer-reason">
            <Input id="qa-transfer-reason" name="reason" required defaultValue="They contacted me directly" />
          </Field>
          <SubmitButton pendingText="Sending…">Send to manager</SubmitButton>
        </ActionForm>
      )}
    </div>
  );
}

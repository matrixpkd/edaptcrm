import Link from "next/link";
import { Lock } from "lucide-react";
import { HIDDEN_CONTACT_LABEL, type ContactHeader } from "@/lib/contacts/queries";
import { GradeBadge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { CONTACT_TYPE_LABELS, SPENDING_BAND_LABELS, countryName } from "@/components/contacts/labels";
import { daysSince } from "@/lib/metrics/scoring";
import { formatPhone } from "@/lib/phone";
import { formatDate, formatDateTime, formatINR, pct } from "@/lib/utils";
import type { Labels } from "./labels";

type Item = { label: string; value: React.ReactNode; hint?: string; wide?: boolean };

function Section({ title, items, note }: { title: string; items: Item[]; note?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {note}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-4 sm:gap-x-6">
        {items.map((i) => (
          <div key={i.label} className={i.wide ? "col-span-2 min-w-0" : "min-w-0"}>
            <dt className="text-xs text-muted">{i.label}</dt>
            <dd className="mt-0.5 break-words text-sm font-medium">
              {i.value === null || i.value === undefined || i.value === "" ? (
                <span className="font-normal text-muted">–</span>
              ) : (
                i.value
              )}
              {i.hint && <span className="ml-1 text-xs font-normal text-muted">({i.hint})</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Where a profile value came from, when it was not a salesperson. "system" on country means a guess from the number. */
const sourceHint = (src: string | undefined, field?: "country") =>
  src === "self"
    ? "self-rated"
    : src === "import"
      ? "imported"
      : src === "system"
        ? field === "country"
          ? "from the phone number"
          : "from an enquiry"
        : undefined;

export function DetailsTab({
  c,
  labels,
  canEdit,
  canRate,
  referrerVisible,
  tz,
}: {
  c: ContactHeader;
  labels: Labels;
  canEdit: boolean;
  canRate: boolean;
  referrerVisible: boolean;
  tz: string;
}) {
  const now = new Date();
  const fs = c.fieldSources ?? {};
  const level = (v: number | null) => (v == null ? null : `${v} / 5`);
  return (
    <div className="space-y-4">
      {(canEdit || canRate) && (
        <div className="flex flex-wrap justify-end gap-2">
          {canRate && (
            <ButtonLink href={`/contacts/${c.id}/rate`} variant="outline" size="md">
              Rate
            </ButtonLink>
          )}
          {canEdit && (
            <ButtonLink href={`/contacts/${c.id}/edit`} size="md">
              Edit details
            </ButtonLink>
          )}
        </div>
      )}
      <Section
        title="Contact"
        items={[
          { label: "Phone", value: <span className="tabular">{formatPhone(c.phoneE164)}</span> },
          { label: "Alternate phones", value: c.altPhones.length ? c.altPhones.map(formatPhone).join(", ") : null },
          { label: "Email", value: c.email },
          { label: "Alternate emails", value: c.altEmails.length ? c.altEmails.join(", ") : null },
          { label: "Contact type", value: CONTACT_TYPE_LABELS[c.type] },
          {
            label: "Organisation",
            value: c.organisation ? (
              <Link href={`/organisations/${c.organisation.id}`} className="underline-offset-2 hover:underline">
                {c.organisation.name}
              </Link>
            ) : null,
          },
          { label: "Company name", value: c.companyName },
          { label: "Designation", value: c.designation },
        ]}
      />
      <Section
        title="Location and language"
        items={[
          { label: "City", value: c.city },
          { label: "State", value: c.state },
          {
            label: "Country",
            value: c.country ? countryName(c.country) : null,
            hint: sourceHint(fs.country, "country"),
          },
          { label: "Preferred language", value: labels.language(c.language) },
        ]}
      />
      <Section
        title="Profile and ratings"
        items={[
          { label: "Age band", value: labels.ageBand(c.ageBand), hint: sourceHint(fs.age_band) },
          { label: "Industry or role", value: labels.industry(c.industry), hint: sourceHint(fs.industry) },
          {
            label: "Spending power",
            value: c.spendingBand ? SPENDING_BAND_LABELS[c.spendingBand] : null,
            hint: sourceHint(fs.spending_band),
          },
          { label: "AI knowledge", value: level(c.aiLevel), hint: sourceHint(fs.ai_level) },
          { label: "Umer familiarity", value: level(c.umerLevel), hint: sourceHint(fs.umer_level) },
          { label: "Gut rating", value: c.gutStars ? "★".repeat(c.gutStars) + "☆".repeat(5 - c.gutStars) : null },
          {
            label: "Sales notes",
            value: c.salesNotes ? <span className="whitespace-pre-line font-normal">{c.salesNotes}</span> : null,
            wide: true,
          },
        ]}
      />
      <Section
        title="Labels"
        items={[
          { label: "First door", value: labels.door(c.firstDoor), hint: "stored forever" },
          { label: "First channel", value: labels.channel(c.firstChannel) },
          { label: "First campaign", value: labels.campaign(c.firstCampaign) },
          { label: "Latest channel", value: labels.channel(c.lastChannel) },
          { label: "Latest campaign", value: labels.campaign(c.lastCampaign) },
          { label: "Tags", value: c.tags.length ? c.tags.map((t) => labels.tag(t)).join(", ") : null },
          {
            label: "Referred by",
            value: c.referrer ? (
              referrerVisible ? (
                <Link href={`/contacts/${c.referrer.id}`} className="underline-offset-2 hover:underline">
                  {c.referrer.name}
                </Link>
              ) : (
                <span className="text-muted">{HIDDEN_CONTACT_LABEL}</span>
              )
            ) : null,
          },
          {
            label: "Marketing consent",
            value:
              c.consent == null
                ? null
                : c.consent
                  ? `Yes${c.consentAt ? `, since ${formatDate(c.consentAt, tz)}` : ""}`
                  : "No",
          },
        ]}
      />
      <Section
        title="Ownership"
        items={[
          {
            label: "Owner",
            value: c.ownerName ?? "In the pool",
            hint: c.ownerId && c.ownerActive === false ? "inactive" : undefined,
          },
          { label: "First owner", value: c.firstOwnerName },
          { label: "Assigned", value: c.ownerAssignedAt ? formatDateTime(c.ownerAssignedAt, tz) : null },
          {
            label: "Added",
            value: `${formatDateTime(c.createdAt, tz)}${c.createdByName ? ` by ${c.createdByName}` : ""}`,
          },
        ]}
      />
      <Section
        title="Calculated"
        note={
          <span className="inline-flex items-center gap-1 text-xs text-muted">
            <Lock className="h-3 w-3" aria-hidden /> Read-only, recalculated after every change
          </span>
        }
        items={[
          { label: "Lifetime value (LTV)", value: <span className="tabular">{formatINR(c.ltvInr)}</span> },
          { label: "Network value", value: <span className="tabular">{formatINR(c.networkValueInr)}</span> },
          { label: "Purchases", value: c.purchaseCount },
          {
            label: "Product families bought",
            value: c.families.length ? c.families.map((f) => labels.family(f)).join(", ") : null,
          },
          { label: "First purchase", value: c.firstPurchaseAt ? formatDate(c.firstPurchaseAt, tz) : null },
          { label: "Last purchase", value: c.lastPurchaseAt ? formatDate(c.lastPurchaseAt, tz) : null },
          {
            // spec "Repeat purchase": days since last purchase = today minus the last paid purchase date
            label: "Days since last purchase",
            value: c.lastPurchaseAt ? <span className="tabular">{daysSince(c.lastPurchaseAt, now)}</span> : null,
          },
          { label: "Average gap", value: c.avgGapDays != null ? `${Math.round(c.avgGapDays)} days` : null },
          {
            label: "Expected next purchase",
            value: c.nextExpectedAt ? formatDate(c.nextExpectedAt, tz) : null,
            hint: c.atRisk ? "at risk" : undefined,
          },
          { label: "Repeat probability (90 days)", value: c.repeatProb90d != null ? pct(c.repeatProb90d) : null },
          { label: "Expected 90-day revenue", value: c.expected90dInr != null ? formatINR(c.expected90dInr) : null },
          { label: "Next best offer", value: c.nextOffer, wide: true },
          { label: "Fit", value: c.fit },
          { label: "Readiness", value: c.readiness },
          { label: "Value", value: c.value, hint: c.value == null ? "not used for leads" : undefined },
          {
            label: "Edapt Score and grade",
            value:
              c.edaptScore != null ? (
                <span className="inline-flex items-center gap-2">
                  <GradeBadge grade={c.grade} size="sm" /> {c.edaptScore}
                </span>
              ) : null,
          },
          { label: "Paying referrals", value: c.referralCount },
          { label: "Last activity", value: c.lastActivityAt ? formatDateTime(c.lastActivityAt, tz) : null },
          { label: "Scored", value: c.scoredAt ? formatDateTime(c.scoredAt, tz) : null },
        ]}
      />
    </div>
  );
}

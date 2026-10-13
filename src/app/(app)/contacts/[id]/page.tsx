import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { Building2, Pencil, Star, Wallet } from "lucide-react";
import { Badge, GradeBadge, StageBadge } from "@/components/ui/badge";
import { Tabs } from "@/components/ui/tabs";
import { ContactQuickActions } from "@/components/contacts/quick-actions";
import { ActiveTabIntoView } from "@/components/contacts/active-tab-into-view";
import { FlashBanner } from "@/components/contacts/flash-banner";
import { LadderCard } from "@/components/contacts/ladder";
import { ScoreBars } from "@/components/contacts/score-bars";
import { countryName } from "@/components/contacts/labels";
import { can, canEditContact, canViewContact } from "@/lib/auth/permissions";
import { getCurrentUser, requireUser } from "@/lib/auth/session";
import { resolveSurvivor } from "@/lib/contacts/internal";
import {
  getContactFootprint,
  getContactHeader,
  getContactRatings,
  getContactReferrals,
  getContactTimeline,
  getMergeHistory,
  listAssignableUsers,
  searchContactsForPicker,
} from "@/lib/contacts/queries";
import { nboProducts } from "@/lib/admin/nbo";
import { offerRung } from "@/lib/metrics/ladder";
import { getContactPurchases } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { activeItems, getSettings } from "@/lib/settings";
import { formatINR, isUuid } from "@/lib/utils";
import { DetailsTab } from "./_components/details-tab";
import { makeLabels } from "./_components/labels";
import { ManageControls } from "./_components/manage-controls";
import { MergeTab } from "./_components/merge-tab";
import { PurchasesTab } from "./_components/purchases-tab";
import { RatingsTab } from "./_components/ratings-tab";
import { ReferralsTab } from "./_components/referrals-tab";
import { Timeline } from "./_components/timeline";

type SP = Record<string, string | string[] | undefined>;
const TABS = ["timeline", "purchases", "ratings", "referrals", "details", "merge"] as const;
type Tab = (typeof TABS)[number];

/** Rate / Payment / Edit: big enough to tap, compact enough for three across a phone. */
const SECONDARY_ACTION =
  "flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-1 text-sm font-medium hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98]";

const loadContact = cache((id: string) => getContactHeader(id));

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const user = await getCurrentUser();
  const c = user ? await loadContact(id) : null;
  return { title: c && user && !c.mergedIntoId && canViewContact(user, c) ? c.name : "Contact" };
}

function one(sp: SP, key: string): string | null {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() ? s.trim() : null;
}

export default async function ContactPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SP>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const c = await loadContact(id);
  if (!c) notFound();
  if (c.mergedIntoId) {
    // a merged record lives on in the surviving contact
    const survivor = await resolveSurvivor(c);
    if (survivor && canViewContact(user, survivor)) redirect(`/contacts/${survivor.id}`);
    notFound();
  }
  if (!canViewContact(user, c)) notFound();

  const tz = user.timezone || "Asia/Kolkata";
  const isOwner = c.ownerId !== null && c.ownerId === user.id;
  const canEdit = can(user, "contacts.edit") && canEditContact(user, c);
  const canRate = can(user, "ratings.edit") && canEditContact(user, c);
  const canRecord = can(user, "payments.record") && canEditContact(user, c);
  const canStage = can(user, "contacts.setStage") && canEditContact(user, c);
  const canMerge = can(user, "contacts.merge");
  const canReassign = can(user, "contacts.reassign");
  const canRequest = can(user, "contacts.requestTransfer");
  const canReopen = c.stage === "lost" && (user.role === "admin" || user.role === "manager" || isOwner);
  const ownerMode = canReassign ? "reassign" : canRequest ? (isOwner ? "handover" : "request") : null;

  const requested = one(sp, "tab") as Tab | null;
  const tab: Tab =
    requested && TABS.includes(requested) && (requested !== "merge" || canMerge) ? requested : "timeline";
  const timelinePage = Math.max(1, Number.parseInt(one(sp, "tp") ?? "1", 10) || 1);
  const mergeQuery = one(sp, "mq")?.slice(0, 100) ?? "";
  const mergeWith = one(sp, "with");

  const settings = await getSettings([
    "lists.channels",
    "lists.campaigns",
    "lists.firstDoors",
    "lists.languages",
    "lists.ageBands",
    "lists.industries",
    "lists.outcomes",
    "lists.lostReasons",
    "lists.tags",
    "ladder.rungs",
    "ladder.families",
    "nbo.rules",
    "thresholds",
  ]);
  const labels = makeLabels({
    channels: settings["lists.channels"],
    campaigns: settings["lists.campaigns"],
    doors: settings["lists.firstDoors"],
    languages: settings["lists.languages"],
    ageBands: settings["lists.ageBands"],
    industries: settings["lists.industries"],
    outcomes: settings["lists.outcomes"],
    lostReasons: settings["lists.lostReasons"],
    tags: settings["lists.tags"],
    families: settings["ladder.families"],
  });

  const needsPeople = ownerMode === "reassign" || ownerMode === "handover";
  const [footprint, people, timeline, purchases, ratings, referrals, history, pickResults, otherRaw, catalogue] =
    await Promise.all([
      getContactFootprint(c.id),
      needsPeople ? listAssignableUsers() : Promise.resolve([]),
      tab === "timeline" ? getContactTimeline(c.id, { page: timelinePage }) : null,
      tab === "purchases" ? getContactPurchases(c.id) : null,
      tab === "ratings" ? getContactRatings(c.id) : null,
      tab === "referrals" ? getContactReferrals(c.id, user) : null,
      tab === "merge" ? getMergeHistory(c.id) : null,
      tab === "merge" && mergeQuery && !mergeWith
        ? searchContactsForPicker(user, mergeQuery, { excludeId: c.id })
        : null,
      tab === "merge" && mergeWith && isUuid(mergeWith) && mergeWith !== c.id ? loadContact(mergeWith) : null,
      // the catalogue is small: it places the next best offer on the ladder
      nboProducts(),
    ]);
  // the other side of a merge must be live and visible to this manager
  const other = otherRaw && !otherRaw.mergedIntoId && canViewContact(user, otherRaw) ? otherRaw : null;
  const otherFootprint = other ? await getContactFootprint(other.id) : null;

  const tabHref = (t: Tab) => `/contacts/${c.id}${t === "timeline" ? "" : `?tab=${t}`}`;
  const tabs = [
    { key: "timeline", label: "Timeline", href: tabHref("timeline") },
    { key: "purchases", label: "Purchases", href: tabHref("purchases"), count: footprint.purchases || undefined },
    { key: "ratings", label: "Ratings", href: tabHref("ratings"), count: footprint.ratings || undefined },
    { key: "referrals", label: "Referrals", href: tabHref("referrals"), count: footprint.referred || undefined },
    { key: "details", label: "Details", href: tabHref("details") },
    ...(canMerge ? [{ key: "merge", label: "Merge", href: tabHref("merge") }] : []),
  ];

  const referrerVisible = !!c.referrer && canViewContact(user, { ownerId: c.referrer.ownerId });
  const added = one(sp, "added");
  const people4Select = people
    .filter((p) => p.id !== user.id || ownerMode === "reassign")
    .map((p) => ({ value: p.id, label: p.name }));
  const networkBeatsLtv = c.networkValueInr > c.ltvInr && c.networkValueInr > 0;

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[auto_1fr] lg:gap-x-6">
      {/* ---- header (phone: first; laptop: top left) */}
      <div className="space-y-4 lg:col-start-1 lg:row-start-1">
        {added === "1" && (
          <FlashBanner
            param="added"
            message={
              <>
                Contact saved
                {c.ownerName ? (isOwner ? ". It is yours." : `. Assigned to ${c.ownerName}.`) : ". It is in the pool."}
              </>
            }
          />
        )}
        {added === "existing" && (
          <FlashBanner
            param="added"
            message="This number was already here, so the enquiry was added to this contact."
          />
        )}
        {one(sp, "merged") && (
          <FlashBanner param="merged" message="Merged. Everything from the other record is now on this contact." />
        )}
        {one(sp, "saved") && <FlashBanner param="saved" message="Details saved." />}
        {one(sp, "undone") && <FlashBanner param="undone" message="Merge undone. Both records are separate again." />}

        <div>
          <Link href="/contacts" className="text-sm text-muted hover:underline">
            ← Contacts
          </Link>
          <div className="mt-1 flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="break-words text-2xl font-semibold tracking-tight">{c.name}</h1>
              <p className="tabular mt-0.5 text-sm text-muted">
                <a href={`tel:${c.phoneE164}`} className="hover:underline">
                  {formatPhone(c.phoneE164)}
                </a>
                {c.country && <> · {countryName(c.country)}</>}
              </p>
              {c.email && (
                <p className="truncate text-sm text-muted">
                  <a href={`mailto:${c.email}`} className="hover:underline">
                    {c.email}
                  </a>
                </p>
              )}
            </div>
            <GradeBadge grade={c.grade} score={c.edaptScore} size="lg" />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StageBadge stage={c.stage} />
            {c.stage === "lost" && c.lostReason && <Badge tone="danger">{labels.lostReason(c.lostReason)}</Badge>}
            {c.atRisk && <Badge tone="danger">At risk</Badge>}
            {c.type === "business" && <Badge>Business</Badge>}
            {c.tags.map((t) => (
              <Badge key={t} tone="neutral">
                {labels.tag(t)}
              </Badge>
            ))}
          </div>
          <p className="mt-2 text-sm">
            <span className="text-muted">Owner </span>
            <span className="font-medium">
              {c.ownerName ? (isOwner ? `${c.ownerName} (you)` : c.ownerName) : "Pool"}
            </span>
            {c.ownerId && c.ownerActive === false && <span className="text-danger"> (inactive)</span>}
            {c.firstOwnerName && c.firstOwnerId !== c.ownerId && (
              <>
                <span className="text-muted"> · first owner </span>
                <span className="font-medium">{c.firstOwnerName}</span>
              </>
            )}
            {c.organisation && (
              <>
                <span className="text-muted"> · </span>
                <Link
                  href={`/organisations/${c.organisation.id}`}
                  className="inline-flex items-center gap-1 font-medium hover:underline"
                >
                  <Building2 className="h-3.5 w-3.5" aria-hidden />
                  {c.organisation.name}
                </Link>
              </>
            )}
          </p>
        </div>

        <ScoreBars fit={c.fit} readiness={c.readiness} value={c.value} />

        <ContactQuickActions contact={{ id: c.id, name: c.name, phoneE164: c.phoneE164 }} variant="full" />
        {(canRate || canRecord || canEdit) && (
          <div className="grid grid-cols-3 gap-2">
            {canRate && (
              <Link href={`/contacts/${c.id}/rate`} className={SECONDARY_ACTION}>
                <Star className="h-4 w-4 shrink-0" aria-hidden /> Rate
              </Link>
            )}
            {canRecord && (
              <Link href={`/contacts/${c.id}/payment`} className={SECONDARY_ACTION} aria-label="Record payment">
                <Wallet className="h-4 w-4 shrink-0" aria-hidden /> Payment
              </Link>
            )}
            {canEdit && (
              <Link href={`/contacts/${c.id}/edit`} className={SECONDARY_ACTION}>
                <Pencil className="h-4 w-4 shrink-0" aria-hidden /> Edit
              </Link>
            )}
          </div>
        )}
      </div>

      {/* ---- the ladder, money, stage and owner (phone: after the header; laptop: right column) */}
      <aside
        className="mt-4 space-y-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:mt-0"
        aria-label="Value and next steps"
      >
        <LadderCard
          currentRung={c.currentRung}
          rungs={settings["ladder.rungs"]}
          families={settings["ladder.families"]}
          bought={c.families}
          nextOffer={c.nextOffer}
          offerRung={offerRung(
            { productId: c.nextOfferProductId, text: c.nextOffer },
            { products: catalogue, families: settings["ladder.families"], rules: settings["nbo.rules"] },
          )}
          expected90dInr={c.expected90dInr}
          repeatProb90d={c.repeatProb90d}
          nextExpectedAt={c.nextExpectedAt}
          atRisk={c.atRisk}
          purchaseCount={c.purchaseCount}
          nextRungDays={settings.thresholds.nextRungDays}
          timeZone={tz}
        />
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-border bg-surface p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">LTV</p>
            <p className="tabular mt-1 text-xl font-semibold">{formatINR(c.ltvInr)}</p>
            <p className="mt-0.5 text-xs text-muted">
              {c.purchaseCount === 0
                ? "No paid purchase yet"
                : `${c.purchaseCount} purchase${c.purchaseCount === 1 ? "" : "s"}, verified cash`}
            </p>
          </div>
          <Link
            href={tabHref("referrals")}
            className="rounded-xl border border-border bg-surface p-4 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Network value</p>
            <p className="tabular mt-1 text-xl font-semibold">{formatINR(c.networkValueInr)}</p>
            <p className="mt-0.5 text-xs text-muted">
              {networkBeatsLtv
                ? "Worth more as a referrer"
                : `${c.referralCount} paying referral${c.referralCount === 1 ? "" : "s"}`}
            </p>
          </Link>
        </div>
        {(canStage || canReopen || ownerMode) && (
          <section className="rounded-xl border border-border bg-surface p-4" aria-labelledby="manage-title">
            <h2 id="manage-title" className="mb-3 text-sm font-semibold">
              Stage and owner
            </h2>
            <ManageControls
              contactId={c.id}
              canQualify={canStage && c.purchaseCount === 0 && c.stage !== "qualified"}
              canLose={canStage && c.stage !== "lost"}
              canReopen={canReopen}
              lostReasons={activeItems(settings["lists.lostReasons"]).map((r) => ({ value: r.key, label: r.label }))}
              ownerMode={ownerMode}
              people={people4Select}
              currentOwnerId={c.ownerId}
            />
          </section>
        )}
      </aside>

      {/* ---- tabs (phone: last; laptop: below the header) */}
      <div className="mt-6 lg:col-start-1 lg:row-start-2">
        <Tabs tabs={tabs} active={tab} />
        <ActiveTabIntoView active={tab} />
        <div className="pt-4">
          {tab === "timeline" && timeline && (
            <Timeline
              items={timeline.items}
              page={timeline.page}
              hasMore={timeline.hasMore}
              contactId={c.id}
              labels={labels}
              tz={tz}
            />
          )}
          {tab === "purchases" && purchases && (
            <PurchasesTab purchases={purchases} contactId={c.id} canRecord={canRecord} labels={labels} tz={tz} />
          )}
          {tab === "ratings" && ratings && (
            <RatingsTab ratings={ratings} contactId={c.id} canRate={canRate} labels={labels} tz={tz} />
          )}
          {tab === "referrals" && referrals && (
            <ReferralsTab
              referrer={c.referrer}
              referrerVisible={referrerVisible}
              referred={referrals}
              networkValueInr={c.networkValueInr}
              referralCount={c.referralCount}
              tz={tz}
            />
          )}
          {tab === "details" && (
            <DetailsTab
              c={c}
              labels={labels}
              canEdit={canEdit}
              canRate={canRate}
              referrerVisible={referrerVisible}
              tz={tz}
            />
          )}
          {tab === "merge" && canMerge && (
            <MergeTab
              c={c}
              q={mergeQuery}
              results={pickResults ?? []}
              other={other}
              otherFootprint={otherFootprint}
              otherVisible={!!other}
              history={history ?? []}
              labels={labels}
              tz={tz}
            />
          )}
        </div>
      </div>
    </div>
  );
}

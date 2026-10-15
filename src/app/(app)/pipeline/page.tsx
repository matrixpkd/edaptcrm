import Link from "next/link";
import { buttonClass } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/card";
import { PipelineBoard, type BoardColumnView } from "@/components/pipeline/board";
import { can, canEditContact } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { listOwnerOptions } from "@/lib/contacts/queries";
import { getBoard, type BoardFilters } from "@/lib/pipeline/board";
import { activeItems, getSettings, labelFor } from "@/lib/settings";
import { formatINRCompact, isUuid } from "@/lib/utils";

export const metadata = { title: "Pipeline" };
export const dynamic = "force-dynamic";

type SP = { owner?: string; grade?: string; door?: string };

const GRADE_OPTIONS = ["A", "B", "C", "D", "none"] as const;

export default async function PipelinePage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser(["admin", "manager", "sales"]);
  const sp = await searchParams;
  const filters: BoardFilters = {
    owner: sp.owner === "mine" || sp.owner === "pool" || (sp.owner && isUuid(sp.owner)) ? sp.owner : null,
    grade: (GRADE_OPTIONS as readonly string[]).includes(sp.grade ?? "") ? (sp.grade as BoardFilters["grade"]) : null,
    firstDoor: sp.door?.trim() ? sp.door.trim().slice(0, 80) : null,
  };
  const seesAll = can(user, "contacts.viewAll");
  const [columns, settings, owners] = await Promise.all([
    getBoard(user, filters),
    getSettings(["lists.firstDoors", "lists.lostReasons"]),
    seesAll ? listOwnerOptions() : Promise.resolve([]),
  ]);
  const canStage = can(user, "contacts.setStage");
  const contactsQuery = (stage: string) => {
    const q = new URLSearchParams({ stage });
    if (filters.owner) q.set("owner", filters.owner);
    if (filters.grade && filters.grade !== "none") q.set("grade", filters.grade);
    if (filters.firstDoor) q.set("door", filters.firstDoor);
    return `/contacts?${q.toString()}`;
  };
  const view: BoardColumnView[] = columns.map((col) => ({
    stage: col.stage,
    count: col.count,
    ltv: formatINRCompact(col.ltvInr),
    moreHref: col.count > col.cards.length ? contactsQuery(col.stage) : null,
    cards: col.cards.map((card) => ({
      id: card.id,
      name: card.name,
      stage: card.stage,
      grade: card.grade,
      ownerName: card.ownerName,
      nextOffer: card.nextOffer,
      ltv: card.ltvInr > 0 ? formatINRCompact(card.ltvInr) : "No payment yet",
      purchaseCount: card.purchaseCount,
      lostReasonLabel: card.stage === "lost" && card.lostReason ? labelFor(settings["lists.lostReasons"], card.lostReason) : null,
      // Lost and Qualified: the stage rights; Reopen: the owner or a manager (the lifecycle service checks again)
      movable:
        card.stage === "lost"
          ? user.role === "admin" || user.role === "manager" || card.ownerId === user.id
          : canStage && canEditContact(user, card),
    })),
  }));
  const total = columns.reduce((n, c) => n + c.count, 0);
  const filtered = !!(filters.owner || filters.grade || filters.firstDoor);

  return (
    <div className="max-w-none">
      <PageHeader
        title="Pipeline"
        description={`${total.toLocaleString("en-IN")} contact${total === 1 ? "" : "s"} by lifecycle stage${seesAll ? "" : " (yours and the pool)"}.`}
      />
      <form method="get" action="/pipeline" className="mb-4 flex flex-wrap items-end gap-2" aria-label="Filter the board">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Owner
          <select name="owner" defaultValue={filters.owner ?? ""} className="h-10 rounded-lg border border-border bg-surface px-3 text-sm">
            <option value="">{seesAll ? "Everyone" : "Mine and the pool"}</option>
            <option value="mine">Mine</option>
            <option value="pool">Pool (unassigned)</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.active ? "" : " (inactive)"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Grade
          <select name="grade" defaultValue={filters.grade ?? ""} className="h-10 rounded-lg border border-border bg-surface px-3 text-sm">
            <option value="">Any</option>
            {GRADE_OPTIONS.map((g) => (
              <option key={g} value={g}>
                {g === "none" ? "Not scored" : g}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          First door
          <select name="door" defaultValue={filters.firstDoor ?? ""} className="h-10 max-w-[14rem] rounded-lg border border-border bg-surface px-3 text-sm">
            <option value="">Any</option>
            {activeItems(settings["lists.firstDoors"]).map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={buttonClass("primary", "md")}>
          Apply
        </button>
        {filtered && (
          <Link href="/pipeline" className={buttonClass("ghost", "md")}>
            Clear
          </Link>
        )}
      </form>
      {total === 0 && !filtered ? (
        <div className="mb-4 rounded-2xl border border-border bg-surface px-6 py-10 text-center">
          <p className="font-medium">No contacts yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
            Leads appear here as they arrive: from Quick Add, TagMango, WhatsApp, forms and imports.
          </p>
          <Link href="/contacts/new" className={buttonClass("primary", "md", "mt-4")}>
            Add a lead
          </Link>
        </div>
      ) : null}
      <PipelineBoard
        columns={view}
        lostReasons={activeItems(settings["lists.lostReasons"]).map((r) => ({ value: r.key, label: r.label }))}
      />
    </div>
  );
}

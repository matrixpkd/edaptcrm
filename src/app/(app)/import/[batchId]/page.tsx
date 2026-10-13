import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Download, FileWarning } from "lucide-react";
import { db } from "@/db";
import { products, users } from "@/db/schema";
import { BatchStatusBadge } from "@/components/import/batch-status";
import { CommitButton, UndoButton } from "@/components/import/commit-controls";
import { MappingForm, type ProductValue } from "@/components/import/mapping-form";
import { PhaseRunner } from "@/components/import/phase-runner";
import { ReviewRows } from "@/components/import/review-rows";
import { DiscardButton, ResolveAllConflictsButton, SheetPicker } from "@/components/import/row-actions";
import { Stepper } from "@/components/import/stepper";
import { ButtonLink, buttonClass } from "@/components/ui/button";
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { can } from "@/lib/auth/permissions";
import { requireUser, type SessionUser } from "@/lib/auth/session";
import { looseKey } from "@/lib/contacts/rules";
import {
  batchColumnSamples,
  commitPreview,
  getBatchView,
  listRows,
  productValues,
  ROW_VIEWS,
  uniqueCustomerCount,
  type BatchView,
  type RowView,
} from "@/lib/import/batches";
import {
  SOURCE_INFO,
  isImportSource,
  type ColumnMapping,
  type ImportSource,
  type TargetField,
} from "@/lib/import/types";
import { getSettings, labelFor } from "@/lib/settings";
import { formatDateTime } from "@/lib/utils";
import { getCountries } from "libphonenumber-js/max";

export const metadata = { title: "Import" };
// uploads, AI mapping and every chunk of a 50,000-row import run as server actions of these pages
export const maxDuration = 300;

type SP = { step?: string; view?: string; page?: string };

const EDITABLE = ["uploaded", "mapped", "cleaned", "matched"];
const n = (v: number | undefined) => (v ?? 0).toLocaleString("en-IN");

function stepOf(status: string, wantsMap: boolean): number {
  if (wantsMap && EDITABLE.includes(status)) return 2;
  return (
    {
      uploaded: 2,
      mapped: 3,
      cleaned: 4,
      matched: 5,
      committing: 6,
      committed: 6,
      undone: 6,
      failed: 2,
    }[status] ?? 2
  );
}

const COMMON_COUNTRIES = ["IN", "AE", "SA", "QA", "KW", "BH", "OM", "US", "GB"];

function countryOptions() {
  const dn = new Intl.DisplayNames(["en"], { type: "region" });
  const all = (getCountries() as string[])
    .map((c) => ({ value: c, label: dn.of(c) ?? c }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const common = COMMON_COUNTRIES.map((c) => all.find((o) => o.value === c)!).filter(Boolean);
  return [...common, ...all.filter((o) => !COMMON_COUNTRIES.includes(o.value))];
}

// ---------------------------------------------------------------------------
// Step 2
// ---------------------------------------------------------------------------

async function MappingStep({ b }: { b: NonNullable<BatchView> }) {
  const headers = b.settings.file.headers;
  const mapping = (b.mapping ?? {}) as ColumnMapping;
  const productColumn = headers.find((h) => mapping[h] === "product") ?? null;
  const [samples, s, team, catalogue, values] = await Promise.all([
    batchColumnSamples(b.id, headers),
    getSettings(["lists.firstDoors", "lists.campaigns", "lists.tags", "ladder.families", "currency"]),
    db
      .select({
        id: users.id,
        name: users.name,
        role: users.role,
        active: users.active,
      })
      .from(users)
      .orderBy(users.name),
    db
      .select({
        id: products.id,
        name: products.name,
        family: products.family,
        externalIds: products.externalIds,
      })
      .from(products)
      .orderBy(products.name),
    productColumn ? productValues(b.id, productColumn) : Promise.resolve([]),
  ]);
  const productMap = b.settings.productMap ?? {};
  const pv: ProductValue[] = values.map((v) => {
    const key = looseKey(v.value);
    const auto = catalogue.find((p) => looseKey(p.name) === key || p.externalIds.some((e) => looseKey(e) === key));
    const choice = productMap[key]?.productId
      ? `p:${productMap[key].productId}`
      : productMap[key]?.family
        ? `f:${productMap[key].family}`
        : "";
    return { value: v.value, key, n: v.n, auto: auto?.name ?? null, choice };
  });
  const active = (list: { key: string; label: string; active?: boolean }[]) =>
    list.filter((i) => i.active !== false).map((i) => ({ value: i.key, label: i.label }));
  const families = s["ladder.families"].map((f) => ({
    value: f.key,
    label: f.label,
  }));

  return (
    <div className="space-y-5">
      {b.settings.file.kind === "xlsx" && (b.settings.file.sheets?.length ?? 0) > 1 && (
        <Card>
          <CardBody>
            <SheetPicker batchId={b.id} sheets={b.settings.file.sheets!} current={b.settings.file.sheet ?? null} />
            <p className="mt-2 text-xs text-muted">
              This workbook has {b.settings.file.sheets!.length} sheets. The rows below come from &ldquo;
              {b.settings.file.sheet}&rdquo;.
            </p>
          </CardBody>
        </Card>
      )}
      <MappingForm
        batchId={b.id}
        source={b.source as ImportSource}
        columns={samples.map((c) => ({
          header: c.header,
          samples: c.samples,
          field: (mapping[c.header] ?? "ignore") as TargetField,
        }))}
        mappingBy={b.settings.mappingBy}
        mappingNote={b.settings.mappingNote ?? null}
        defaults={b.settings}
        productColumn={productColumn}
        productValues={pv}
        options={{
          firstDoors: active(s["lists.firstDoors"]),
          campaigns: active(s["lists.campaigns"]),
          tags: s["lists.tags"].filter((t) => t.active !== false).map((t) => t.key),
          families,
          currencies: ["INR", ...Object.keys(s.currency.rates ?? {}).map((c) => c.toUpperCase())],
          owners: team
            .filter((u) => u.active && u.role !== "support")
            .map((u) => ({ value: u.id, label: `${u.name} (${u.role})` })),
          countries: countryOptions(),
          products: catalogue.map((p) => ({
            value: p.id,
            label: `${p.name} (${labelFor(s["ladder.families"], p.family)})`,
          })),
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows with views and pages
// ---------------------------------------------------------------------------

async function RowsCard({
  user,
  b,
  sp,
  views,
  editable,
  tz,
  title,
}: {
  user: SessionUser;
  b: NonNullable<BatchView>;
  sp: SP;
  views: { key: RowView; label: string; count?: number }[];
  editable: boolean;
  tz: string;
  title: string;
}) {
  const view: RowView = views.some((v) => v.key === sp.view) ? (sp.view as RowView) : views[0].key;
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const { rows, total, pageSize, page: current } = await listRows(b.id, user, { view, page, pageSize: 50 });
  const href = (v: string, p = 1) => `/import/${b.id}?view=${v}${p > 1 ? `&page=${p}` : ""}`;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <Card>
      <CardHeader title={title} />
      <div className="px-4 pt-2">
        <Tabs
          tabs={views.map((v) => ({
            key: v.key,
            label: v.label,
            count: v.count,
            href: href(v.key),
          }))}
          active={view}
        />
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No rows here" description="Choose another filter above." />
      ) : (
        <ReviewRows rows={rows} batchId={b.id} editable={editable} tz={tz} />
      )}
      {pages > 1 && (
        <nav
          className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm"
          aria-label="Pages"
        >
          <span className="tabular text-muted">
            Rows {((current - 1) * pageSize + 1).toLocaleString("en-IN")}–
            {Math.min(current * pageSize, total).toLocaleString("en-IN")} of {total.toLocaleString("en-IN")}
          </span>
          <span className="flex gap-2">
            {current > 1 ? (
              <ButtonLink href={href(view, current - 1)} variant="outline" size="sm" scroll={false} className="max-md:h-10">
                Previous
              </ButtonLink>
            ) : (
              <span className={buttonClass("outline", "sm", "pointer-events-none opacity-40 max-md:h-10")} aria-disabled>
                Previous
              </span>
            )}
            {current < pages ? (
              <ButtonLink href={href(view, current + 1)} variant="outline" size="sm" scroll={false} className="max-md:h-10">
                Next
              </ButtonLink>
            ) : (
              <span className={buttonClass("outline", "sm", "pointer-events-none opacity-40 max-md:h-10")} aria-disabled>
                Next
              </span>
            )}
          </span>
        </nav>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export default async function ImportBatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<SP>;
}) {
  const user = await requireUser();
  if (!can(user, "import.run")) redirect("/today?denied=1");
  const tz = user.timezone || "Asia/Kolkata";
  const [{ batchId }, sp] = await Promise.all([params, searchParams]);
  const b = await getBatchView(batchId, user);
  if (!b) notFound();
  if (sp.view && !(ROW_VIEWS as readonly string[]).includes(sp.view)) sp.view = undefined;

  const c = b.countsT;
  const source = isImportSource(b.source) ? SOURCE_INFO[b.source] : null;
  const wantsMap = sp.step === "map";
  const step = stepOf(b.status, wantsMap);
  const undoing = b.status === "committed" && !!b.settings.progress?.undoStartedAt;
  const canDiscard = EDITABLE.includes(b.status) || b.status === "failed";

  return (
    <div className="space-y-5">
      <PageHeader
        back={
          <Link href="/import" className="inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Imports
          </Link>
        }
        title={<span className="break-all">{b.fileName}</span>}
        description={
          <>
            {source?.label ?? b.source} · {n(c.total ?? b.settings.file.rowCount)} rows · uploaded by{" "}
            {b.uploadedByName ?? "someone"}, {formatDateTime(b.createdAt, tz)}
          </>
        }
        actions={
          <>
            <BatchStatusBadge status={b.status} undoing={undoing} />
            {canDiscard && <DiscardButton batchId={b.id} />}
          </>
        }
      />
      <Stepper current={step} complete={b.status === "committed" || b.status === "undone"} />

      {b.status === "failed" && (
        <Card>
          <CardBody>
            <p role="alert" className="text-sm text-danger">
              {b.error ?? "This import failed."}
            </p>
          </CardBody>
        </Card>
      )}

      {/* Step 2: map */}
      {(b.status === "uploaded" || (wantsMap && EDITABLE.includes(b.status))) && <MappingStep b={b} />}

      {/* Steps 3-4: clean and match, automatically */}
      {!wantsMap && (b.status === "mapped" || b.status === "cleaned") && (
        <Card>
          <CardHeader
            title={b.status === "mapped" ? "Cleaning and matching" : "Matching"}
            description="Phones normalised, names in proper case, dates and amounts parsed; then every row is matched by phone, then email, against the CRM and the earlier rows of this file."
          />
          <CardBody>
            <PhaseRunner
              batchId={b.id}
              phases={b.status === "mapped" ? ["clean", "match"] : ["match"]}
              autoStart
              initial={{
                done: b.status === "mapped" ? (c.cleaned ?? 0) : (c.matched ?? 0),
                total: c.total ?? 0,
              }}
            />
            <p className="mt-4 text-sm">
              <Link href={`/import/${b.id}?step=map`} className="underline underline-offset-2">
                Back to the mapping
              </Link>
            </p>
          </CardBody>
        </Card>
      )}

      {/* Step 5: review */}
      {!wantsMap && b.status === "matched" && <ReviewStep user={user} b={b} sp={sp} tz={tz} />}

      {/* Step 6: commit */}
      {b.status === "committing" && (
        <Card>
          <CardHeader
            title="Committing"
            description="Rows are imported in chunks; every chunk is saved, so this can be paused and continued."
          />
          <CardBody>
            <PhaseRunner
              batchId={b.id}
              phases={["commit"]}
              autoStart={false}
              startLabel="Continue committing"
              initial={{ done: c.committed ?? 0, total: c.toCommit ?? 0 }}
            />
          </CardBody>
        </Card>
      )}

      {(b.status === "committed" || b.status === "undone") && (
        <ResultStep user={user} b={b} sp={sp} tz={tz} undoing={undoing} />
      )}
    </div>
  );
}

async function ReviewStep({ user, b, sp, tz }: { user: SessionUser; b: NonNullable<BatchView>; sp: SP; tz: string }) {
  const c = b.countsT;
  const preview = await commitPreview(b.id);
  const unresolved = c.unresolved ?? 0;
  const tiles: { key: RowView; label: string; value: number; hint?: string }[] = [
    { key: "new", label: "New", value: c.new ?? 0, hint: "New contacts" },
    {
      key: "merge",
      label: "Will merge",
      value: c.merge ?? 0,
      hint: "Same phone or email",
    },
    {
      key: "conflict",
      label: "Conflict",
      value: c.conflict ?? 0,
      hint: unresolved ? `${n(unresolved)} to decide` : (c.conflict ?? 0) > 0 ? "All decided" : "Same name, same city",
    },
    {
      key: "invalid",
      label: "Invalid",
      value: c.invalid ?? 0,
      hint: "See each row",
    },
    {
      key: "skip",
      label: "Skipped",
      value: c.skip ?? 0,
      hint: "Duplicates, skipped",
    },
  ];
  const summary = `${n(preview.create)} new contact${preview.create === 1 ? "" : "s"}, ${n(preview.merge)} merge${preview.merge === 1 ? "" : "s"} into existing contacts${preview.purchases ? `, ${n(preview.purchases)} purchase${preview.purchases === 1 ? "" : "s"}` : ""}.`;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => (
          <Link
            key={t.key}
            href={`/import/${b.id}?view=${t.key}`}
            scroll={false}
            className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-current={sp.view === t.key ? "true" : undefined}
          >
            <Stat
              label={t.label}
              value={n(t.value)}
              hint={t.hint}
              className={sp.view === t.key ? "border-foreground" : "hover:bg-surface-muted/40"}
            />
          </Link>
        ))}
      </div>

      <Card>
        <CardBody className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 space-y-1">
            <h2 className="text-base font-semibold">
              {unresolved ? "So far " : "Ready to commit "}
              {n(preview.rows)} row{preview.rows === 1 ? "" : "s"}
              {unresolved ? " ready to commit" : ""}
            </h2>
            <p className="text-sm text-muted">
              {summary} Invalid and skipped rows are left out; every raw row stays with the import.
            </p>
            <p className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-sm">
              <Link href={`/import/${b.id}?step=map`} className="underline underline-offset-2">
                Edit the mapping
              </Link>
              {(c.invalid ?? 0) > 0 && (
                <a
                  href={`/import/${b.id}/invalid-rows`}
                  className="inline-flex items-center gap-1 underline underline-offset-2"
                  download
                >
                  <Download className="h-3.5 w-3.5" aria-hidden /> Invalid rows (CSV)
                </a>
              )}
            </p>
          </div>
          <div className="shrink-0">
            <CommitButton
              batchId={b.id}
              rows={preview.rows}
              summary={summary}
              disabledReason={
                unresolved
                  ? `Decide the ${n(unresolved)} conflict${unresolved === 1 ? "" : "s"} first (below), or send them all to new.`
                  : preview.rows === 0
                    ? "Nothing to import: every row is invalid or skipped."
                    : null
              }
            />
          </div>
        </CardBody>
      </Card>

      {unresolved > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-start gap-2 text-sm">
            <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <span>
              {n(unresolved)} row{unresolved === 1 ? " has" : "s have"} the same name in the same city as someone else,
              with a different phone. Same name is never merged on its own: treat each as new, or merge it.
            </span>
          </p>
          <ResolveAllConflictsButton batchId={b.id} count={unresolved} />
        </div>
      )}

      <RowsCard
        user={user}
        b={b}
        sp={{ ...sp, view: sp.view ?? (unresolved ? "conflict" : "all") }}
        editable
        tz={tz}
        title="Rows"
        views={[
          { key: "all", label: "All", count: c.total },
          { key: "new", label: "New", count: c.new },
          { key: "merge", label: "Will merge", count: c.merge },
          { key: "conflict", label: "Conflict", count: c.conflict },
          { key: "invalid", label: "Invalid", count: c.invalid },
          { key: "skip", label: "Skipped", count: c.skip },
        ]}
      />
    </div>
  );
}

async function ResultStep({
  user,
  b,
  sp,
  tz,
  undoing,
}: {
  user: SessionUser;
  b: NonNullable<BatchView>;
  sp: SP;
  tz: string;
  undoing: boolean;
}) {
  const c = b.countsT;
  const unique = await uniqueCustomerCount();
  const isUndone = b.status === "undone";
  return (
    <div className="space-y-5">
      {isUndone ? (
        <Card>
          <CardBody className="space-y-1">
            <h2 className="text-base font-semibold">
              Undone {b.undoneAt ? formatDateTime(b.undoneAt, tz) : ""}
              {b.undoneByName ? ` by ${b.undoneByName}` : ""}
            </h2>
            <p className="text-sm text-muted">
              {n(c.deletedContacts)} contact{c.deletedContacts === 1 ? "" : "s"} deleted, {n(c.revertedContacts)}{" "}
              existing contact
              {c.revertedContacts === 1 ? "" : "s"} put back as they were, {n(c.deletedPurchases)} purchase
              {c.deletedPurchases === 1 ? "" : "s"} removed.
              {c.keptContacts
                ? ` ${n(c.keptContacts)} contact${c.keptContacts === 1 ? " was" : "s were"} kept because they had activity after the import (see "Kept").`
                : ""}
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="grid gap-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div className="bg-foreground p-5 text-white">
              <p className="text-xs font-medium uppercase tracking-wide text-white/70">
                Edapt&apos;s true count of unique customers
              </p>
              <p className="tabular mt-1 text-4xl font-semibold sm:text-5xl">{unique.toLocaleString("en-IN")}</p>
              <p className="mt-2 text-xs text-white/70">
                Every person with a verified payment, counted once, across all imports and sources.
              </p>
            </div>
            <div className="space-y-2 p-5">
              <h2 className="text-base font-semibold">
                Committed {b.committedAt ? formatDateTime(b.committedAt, tz) : ""}
              </h2>
              <p className="text-sm text-muted">
                {n(c.total)} rows in the file became {n(c.uniqueContacts)} unique{" "}
                {c.uniqueContacts === 1 ? "person" : "people"}: {n(c.created)} new contact{c.created === 1 ? "" : "s"},
                and {n(c.updated)} row{c.updated === 1 ? "" : "s"} merged into a contact already in the CRM or created
                from an earlier row.
                {c.purchases
                  ? ` ${n(c.purchases)} purchase${c.purchases === 1 ? "" : "s"} recorded${b.settings.verified ? " as verified payments" : ""}.`
                  : ""}
              </p>
              <div className="pt-1">
                <UndoButton
                  batchId={b.id}
                  fileName={b.fileName}
                  created={c.created ?? 0}
                  updated={c.updated ?? 0}
                  resume={undoing}
                />
              </div>
            </div>
          </div>
        </Card>
      )}

      {!isUndone && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="New contacts" value={n(c.created)} />
          <Stat label="Merged rows" value={n(c.updated)} />
          <Stat
            label="Purchases"
            value={n(c.purchases)}
            hint={c.purchasesSkipped ? `${n(c.purchasesSkipped)} already recorded` : undefined}
          />
          <Stat label="Skipped or invalid" value={n((c.skip ?? 0) + (c.invalid ?? 0))} />
          <Stat
            label="Failed rows"
            value={n(c.failed)}
            hint={c.failed ? "See the Failed filter" : "None"}
            className={c.failed ? "border-danger/40" : undefined}
          />
        </div>
      )}

      <RowsCard
        user={user}
        b={b}
        sp={sp}
        editable={false}
        tz={tz}
        title="Rows"
        views={[
          { key: "all", label: "All", count: c.total },
          ...(c.failed ? [{ key: "failed" as RowView, label: "Failed", count: c.failed }] : []),
          ...(isUndone && c.keptContacts ? [{ key: "kept" as RowView, label: "Kept", count: c.keptContacts }] : []),
          { key: "invalid", label: "Invalid", count: c.invalid },
          { key: "skip", label: "Skipped", count: c.skip },
        ]}
      />
    </div>
  );
}

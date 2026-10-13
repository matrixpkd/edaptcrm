import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckCircle2, Circle, FileSpreadsheet } from "lucide-react";
import { BatchStatusBadge } from "@/components/import/batch-status";
import { UndoButton } from "@/components/import/commit-controls";
import { UploadForm } from "@/components/import/upload-form";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { aiAvailable } from "@/lib/import/ai";
import { committedSources, listBatches, uniqueCustomerCount, type BatchListItem } from "@/lib/import/batches";
import { IMPORT_ORDER, SOURCE_INFO, isImportSource } from "@/lib/import/types";
import { directUploadAvailable } from "@/lib/storage";
import { formatDate, formatDateTime } from "@/lib/utils";

export const metadata = { title: "Import" };
// uploads, AI mapping and every chunk of a 50,000-row import run as server actions of these pages
export const maxDuration = 300;

function n(v: number | undefined) {
  return (v ?? 0).toLocaleString("en-IN");
}

/** "12,000 rows · 8,000 new · 3,500 merged" */
function summary(b: BatchListItem): string {
  const c = b.counts;
  if (b.status === "undone") {
    const parts = [`${n(c.total)} rows`, `undone: ${n(c.deletedContacts)} contacts removed`];
    if (c.keptContacts) parts.push(`${n(c.keptContacts)} kept`);
    return parts.join(" · ");
  }
  if (b.status === "committed") {
    const parts = [`${n(c.total)} rows`, `${n(c.created)} new`, `${n(c.updated)} merged`];
    if (c.purchases) parts.push(`${n(c.purchases)} purchases`);
    return parts.join(" · ");
  }
  if (b.status === "matched") return `${n(c.total)} rows · ${n(c.new)} new · ${n(c.merge)} merge · ${n(c.conflict)} conflict · ${n(c.invalid)} invalid`;
  return `${n(c.total)} rows`;
}

function sourceLabel(s: string) {
  return isImportSource(s) ? SOURCE_INFO[s].short : s;
}

export default async function ImportPage() {
  const user = await requireUser();
  if (!can(user, "import.run")) redirect("/today?denied=1");
  const tz = user.timezone || "Asia/Kolkata";
  const [batches, done, unique] = await Promise.all([listBatches(user), committedSources(), uniqueCustomerCount()]);
  const suggested = IMPORT_ORDER.find((s) => !done[s]) ?? "other";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import"
        description="Bring the old records in, one file at a time: upload, map, clean, match, review, commit. Every import can be undone in one click."
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Card>
          <CardHeader title="New import" description="Step 1 of 6: where the file comes from, and the file." />
          <CardBody>
            <UploadForm aiEnabled={aiAvailable()} suggested={suggested} directUpload={directUploadAvailable()} />
          </CardBody>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardBody>
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Edapt&apos;s true count of unique customers</p>
              <p className="tabular mt-1 text-3xl font-semibold">{unique.toLocaleString("en-IN")}</p>
              <p className="mt-1 text-xs text-muted">People with at least one verified payment, each counted once.</p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Recommended order" description="Payment records first, so they form the backbone." />
            <CardBody>
              <ol className="space-y-2.5">
                {IMPORT_ORDER.map((s, i) => (
                  <li key={s} className="flex items-start gap-2.5 text-sm">
                    {done[s] ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Imported" />
                    ) : (
                      <Circle className="mt-0.5 h-4 w-4 shrink-0 text-border" aria-label="Not imported yet" />
                    )}
                    <span className="min-w-0">
                      <span className="font-medium">
                        {i + 1}. {SOURCE_INFO[s].label}
                      </span>
                      {done[s] && <span className="block text-xs text-muted">Committed {formatDate(done[s], tz)}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader title="Imports" description={batches.length ? `${batches.length} so far, newest first` : undefined} />
        {batches.length === 0 ? (
          <EmptyState
            icon={<FileSpreadsheet className="h-8 w-8" aria-hidden />}
            title="No imports yet"
            description="Start with the TagMango customers and orders export: every row is a real payment, so it gives Edapt's true count of unique customers."
          />
        ) : (
          <>
            {/* phones: one card per import */}
            <ul className="divide-y divide-border md:hidden">
              {batches.map((b) => (
                <li key={b.id} className="space-y-2 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <Link href={`/import/${b.id}`} className="min-w-0 font-medium underline-offset-2 hover:underline">
                      <span className="block break-all">{b.fileName}</span>
                    </Link>
                    <BatchStatusBadge status={b.status} undoing={b.undoing} />
                  </div>
                  <p className="text-xs text-muted">
                    {sourceLabel(b.source)} · {b.uploadedByName ?? "Someone"} · {formatDateTime(b.createdAt, tz)}
                  </p>
                  <p className="tabular text-xs">{summary(b)}</p>
                  {b.status === "committed" && (
                    <UndoButton batchId={b.id} fileName={b.fileName} created={b.counts.created ?? 0} updated={b.counts.updated ?? 0} resume={b.undoing} size="sm" />
                  )}
                </li>
              ))}
            </ul>
            {/* laptops: a table */}
            <div className="hidden md:block">
              <Table>
                <thead>
                  <tr>
                    <Th>File</Th>
                    <Th>Status</Th>
                    <Th>Rows</Th>
                    <Th>By</Th>
                    <Th>When</Th>
                    <Th className="text-right">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id} className="hover:bg-surface-muted/40">
                      <Td className="max-w-72">
                        <Link href={`/import/${b.id}`} className="block truncate font-medium underline-offset-2 hover:underline" title={b.fileName}>
                          {b.fileName}
                        </Link>
                        <span className="text-xs text-muted">{sourceLabel(b.source)}</span>
                      </Td>
                      <Td>
                        <BatchStatusBadge status={b.status} undoing={b.undoing} />
                      </Td>
                      <Td className="tabular text-xs">{summary(b)}</Td>
                      <Td className="whitespace-nowrap text-sm">{b.uploadedByName ?? "—"}</Td>
                      <Td className="whitespace-nowrap text-sm text-muted">
                        {formatDateTime(b.createdAt, tz)}
                        {b.undoneAt && <span className="block text-xs">Undone {formatDate(b.undoneAt, tz)}</span>}
                      </Td>
                      <Td className="text-right">
                        {b.status === "committed" ? (
                          <div className="flex justify-end">
                            <UndoButton
                              batchId={b.id}
                              fileName={b.fileName}
                              created={b.counts.created ?? 0}
                              updated={b.counts.updated ?? 0}
                              resume={b.undoing}
                              size="sm"
                            />
                          </div>
                        ) : (
                          <Link href={`/import/${b.id}`} className="text-sm font-medium underline-offset-2 hover:underline">
                            {["uploaded", "mapped", "cleaned", "matched", "committing"].includes(b.status) ? "Continue" : "Open"}
                          </Link>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

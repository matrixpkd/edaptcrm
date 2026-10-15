import Link from "next/link";
import { desc, eq, lt } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, EmptyState, PageHeader } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { db } from "@/db";
import { appErrors, users } from "@/db/schema";
import { requireUser } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/utils";

export const metadata = { title: "Error log" };
export const dynamic = "force-dynamic";

const PAGE = 100;

/** Admin: the latest errors the app hit on the server and in people's browsers. */
export default async function ErrorLogPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const user = await requireUser(["admin"]);
  const { before } = await searchParams;
  const beforeId = before && /^\d+$/.test(before) ? Number(before) : null;
  const rows = await db
    .select({
      id: appErrors.id,
      kind: appErrors.kind,
      source: appErrors.source,
      message: appErrors.message,
      stack: appErrors.stack,
      digest: appErrors.digest,
      path: appErrors.path,
      method: appErrors.method,
      createdAt: appErrors.createdAt,
      userName: users.name,
    })
    .from(appErrors)
    .leftJoin(users, eq(users.id, appErrors.userId))
    .where(beforeId ? lt(appErrors.id, beforeId) : undefined)
    .orderBy(desc(appErrors.id))
    .limit(PAGE);
  return (
    <div>
      <PageHeader
        back={<Link href="/settings">← Settings</Link>}
        title="Error log"
        description="Errors the CRM hit on the server and in people's browsers, newest first. Kept for 30 days."
      />
      <Card>
        {rows.length === 0 ? (
          <EmptyState title="No errors recorded" description="When something fails, it shows up here with the screen it happened on." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Where</Th>
                <Th>What</Th>
                <Th>Who</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap align-top text-xs text-muted">{formatDateTime(r.createdAt, user.timezone)}</Td>
                  <Td className="align-top">
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge tone={r.kind === "server" ? "danger" : "warning"}>{r.kind}</Badge>
                      {r.source && <Badge>{r.source}</Badge>}
                    </div>
                    <p className="mt-1 break-all font-mono text-xs">
                      {r.method ? `${r.method} ` : ""}
                      {r.path}
                    </p>
                  </Td>
                  <Td className="max-w-xl align-top">
                    <p className="break-words text-sm">{r.message}</p>
                    {r.digest && <p className="mt-1 font-mono text-xs text-muted">ref {r.digest}</p>}
                    {r.stack && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-muted">Stack</summary>
                        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-muted p-2 text-[11px]">{r.stack}</pre>
                      </details>
                    )}
                  </Td>
                  <Td className="align-top text-sm">{r.userName ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {rows.length === PAGE && (
        <div className="mt-4 text-right">
          <Link className="text-sm font-medium underline" href={`/settings/errors?before=${rows[rows.length - 1].id}`}>
            Older errors →
          </Link>
        </div>
      )}
    </div>
  );
}

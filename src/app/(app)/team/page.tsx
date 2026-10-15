import Link from "next/link";
import { AlertTriangle, ChevronRight, UserPlus } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { listUsers, type AdminUserRow } from "@/lib/admin/users";
import { ROLE_LABELS, can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";
import { cn, formatRelative } from "@/lib/utils";

export const metadata = { title: "Team" };
export const dynamic = "force-dynamic";

/**
 * The team (admins and managers): who is on it, their role and team, whether they can sign in, when they last did,
 * and how much each one holds. Admins add, edit, reset, deactivate and reactivate people from here.
 */
export default async function TeamPage() {
  const me = await requireUser(["admin", "manager"]);
  const isAdmin = can(me, "users.manage");
  const now = new Date();
  const [rows, s] = await Promise.all([listUsers(), getSettings(["teams", "assignment"])]);
  const teamLabel = (k: string | null) => (k ? (s.teams.find((t) => t.key === k)?.label ?? k) : null);
  const active = rows.filter((r) => r.active);
  const sellers = (team: string) => active.filter((r) => r.role === "sales" && r.team === team);
  const leadTeams = [...new Set([s.assignment.defaultTeam, s.assignment.gccTeam])];
  const emptyLeadTeams = leadTeams.filter((t) => sellers(t).length === 0);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Team"
        description={`${active.length} active${rows.length > active.length ? `, ${rows.length - active.length} deactivated` : ""}. Roles decide what people see and do; teams decide which new leads they get.`}
        actions={
          isAdmin ? (
            <ButtonLink href="/team/new">
              <UserPlus className="h-4 w-4" aria-hidden /> Add teammate
            </ButtonLink>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-5">
        {emptyLeadTeams.length > 0 && (
          <div role="status" className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <p>
              {emptyLeadTeams.map((t) => teamLabel(t)).join(" and ")} {emptyLeadTeams.length === 1 ? "has" : "have"} no active salesperson, so{" "}
              {emptyLeadTeams.length === 1 ? "its" : "their"} new leads wait in the pool.{" "}
              {isAdmin ? (
                <>
                  <Link href="/team/new" className="font-medium underline underline-offset-2">
                    Add a salesperson
                  </Link>{" "}
                  or change the routing in{" "}
                  <Link href="/settings/teams-assignment" className="font-medium underline underline-offset-2">
                    Teams and assignment
                  </Link>
                  .
                </>
              ) : (
                "Ask an admin to add a salesperson."
              )}
            </p>
          </div>
        )}

        <Card>
          {/* phones: one card per person */}
          <ul className="divide-y divide-border md:hidden" aria-label="Team members">
            {rows.map((u) => (
              <li key={u.id}>
                <Link href={`/team/${u.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Avatar name={u.name} className={cn(!u.active && "opacity-60")} />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate font-medium", !u.active && "text-muted")}>
                      {u.name}
                      {u.id === me.id && <span className="ml-1 text-xs font-normal text-muted">(you)</span>}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      <span>{ROLE_LABELS[u.role]}</span>
                      {teamLabel(u.team) && <span>· {teamLabel(u.team)}</span>}
                      {!u.active && <Badge>Deactivated</Badge>}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">{stats(u, now)}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
          {/* laptops: a table */}
          <div className="hidden md:block">
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Role</Th>
                  <Th>Team</Th>
                  <Th>Status</Th>
                  <Th>Last sign-in</Th>
                  <Th className="text-right">Open tasks</Th>
                  <Th className="text-right">Contacts</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id} className={cn("hover:bg-surface-muted/50", !u.active && "text-muted")}>
                    <Td>
                      <Link
                        href={`/team/${u.id}`}
                        className="flex min-w-0 items-center gap-2.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Avatar name={u.name} className={cn(!u.active && "opacity-60")} />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-foreground underline-offset-2 hover:underline">
                            {u.name}
                            {u.id === me.id && <span className="ml-1 text-xs font-normal text-muted">(you)</span>}
                          </span>
                          <span className="block truncate text-xs text-muted">{u.email}</span>
                        </span>
                      </Link>
                    </Td>
                    <Td>{ROLE_LABELS[u.role]}</Td>
                    <Td>{teamLabel(u.team) ?? "—"}</Td>
                    <Td>{u.active ? <Badge tone="success">Active</Badge> : <Badge>Deactivated</Badge>}</Td>
                    <Td className="text-xs">{u.lastLoginAt ? formatRelative(u.lastLoginAt, now) : "Never"}</Td>
                    <Td className="tabular text-right">{u.openTaskCount.toLocaleString("en-IN")}</Td>
                    <Td className="tabular text-right">{u.contactCount.toLocaleString("en-IN")}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Who gets new leads"
            description="GCC numbers go to one team, all others to another, then round robin among that team's active salespeople."
            actions={
              isAdmin ? (
                <Link href="/settings/teams-assignment" className="text-xs font-medium underline-offset-2 hover:underline">
                  Change
                </Link>
              ) : undefined
            }
          />
          <ul className="divide-y divide-border">
            {s.teams.map((t) => {
              const people = sellers(t.key);
              const gets = [t.key === s.assignment.gccTeam ? "GCC numbers" : null, t.key === s.assignment.defaultTeam ? "all other numbers" : null].filter(Boolean);
              return (
                <li key={t.key} className="flex flex-col gap-0.5 px-4 py-3 text-sm sm:flex-row sm:items-baseline sm:gap-3">
                  <span className="font-medium sm:w-40">{t.label}</span>
                  <span className="text-xs text-muted sm:w-44">{gets.length ? `Gets ${gets.join(" and ")}` : "Gets no new leads"}</span>
                  <span className="min-w-0 flex-1">
                    {people.length ? people.map((p) => p.name).join(", ") : <span className="text-muted">No active salespeople</span>}
                  </span>
                </li>
              );
            })}
          </ul>
          {!s.assignment.autoAssign && <p className="border-t border-border px-4 py-3 text-xs text-muted">Automatic assignment is off: every new lead waits in the pool.</p>}
        </Card>
      </div>
    </div>
  );
}

function stats(u: AdminUserRow, now: Date): string {
  const parts = [
    `${u.contactCount.toLocaleString("en-IN")} contact${u.contactCount === 1 ? "" : "s"}`,
    `${u.openTaskCount.toLocaleString("en-IN")} open task${u.openTaskCount === 1 ? "" : "s"}`,
    u.lastLoginAt ? `signed in ${formatRelative(u.lastLoginAt, now)}` : "never signed in",
  ];
  return parts.join(" · ");
}

import Link from "next/link";
import { UserPlus } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { listUsers } from "@/lib/admin/users";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { getSetting } from "@/lib/settings";
import { cn, formatRelative } from "@/lib/utils";
import { SettingsHeader } from "../_components/settings-header";

export const metadata = { title: "Users" };

export default async function UsersPage() {
  const me = await requireUser(["admin"]);
  const now = new Date();
  const [rows, teams] = await Promise.all([listUsers(), getSetting("teams")]);
  const teamLabel = (k: string | null) => (k ? (teams.find((t) => t.key === k)?.label ?? k) : "—");
  const active = rows.filter((r) => r.active).length;

  return (
    <div className="mx-auto max-w-5xl">
      <SettingsHeader
        title="Users"
        description={`${active} active of ${rows.length}. Roles decide what people see and do; teams decide which leads they get.`}
        actions={
          <ButtonLink href="/settings/users/new">
            <UserPlus className="h-4 w-4" aria-hidden /> Add user
          </ButtonLink>
        }
      />
      <Card>
        {rows.length === 0 ? (
          <EmptyState title="No team members yet" description="Add the first salesperson to start assigning leads." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Role</Th>
                <Th className="hidden md:table-cell">Team</Th>
                <Th className="hidden lg:table-cell">Time zone</Th>
                <Th className="hidden sm:table-cell text-right">Contacts</Th>
                <Th className="hidden md:table-cell">Last sign-in</Th>
                <Th className="hidden sm:table-cell">Status</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className={cn("hover:bg-surface-muted/50", !u.active && "text-muted")}>
                  <Td>
                    <Link
                      href={`/settings/users/${u.id}`}
                      className="flex min-w-0 items-center gap-2.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Avatar name={u.name} className={cn(!u.active && "opacity-60")} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-foreground underline-offset-2 hover:underline">
                          {u.name}
                          {u.id === me.id && <span className="ml-1 text-xs font-normal text-muted">(you)</span>}
                        </span>
                        <span className="block truncate text-xs text-muted">{u.email}</span>
                        {!u.active && <span className="mt-0.5 block text-xs font-medium sm:hidden">Deactivated</span>}
                      </span>
                    </Link>
                  </Td>
                  <Td>{ROLE_LABELS[u.role]}</Td>
                  <Td className="hidden md:table-cell">{teamLabel(u.team)}</Td>
                  <Td className="hidden lg:table-cell text-xs">{u.timezone}</Td>
                  <Td className="hidden sm:table-cell tabular text-right">{u.contactCount.toLocaleString("en-IN")}</Td>
                  <Td className="hidden md:table-cell text-xs">{u.lastLoginAt ? formatRelative(u.lastLoginAt, now) : "Never"}</Td>
                  <Td className="hidden sm:table-cell">{u.active ? <Badge tone="success">Active</Badge> : <Badge>Deactivated</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

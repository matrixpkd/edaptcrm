import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { ArrowLeft, ArrowRightLeft, ListChecks, UserCheck, Users, UserX } from "lucide-react";
import { FlashBanner } from "@/components/contacts/flash-banner";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { db } from "@/db";
import { auditLog, users } from "@/db/schema";
import { showValue } from "@/lib/admin/diff";
import { defaultHandoverTarget, getAdminUser, listHandoverTargets } from "@/lib/admin/users";
import { ROLE_LABELS, can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { formatPhone } from "@/lib/phone";
import { getSetting } from "@/lib/settings";
import { siteOrigin } from "@/lib/site";
import { formatDateTime, formatRelative } from "@/lib/utils";
import { FieldError, FormSubmit, SettingsForm } from "../../settings/_components/settings-form";
import { ROLE_HELP, ROLE_OPTIONS, timeZoneOptions } from "../../settings/_lib/options";
import { ResetPassword } from "../../settings/users/_components/reset-password";
import { deactivateUserAction, handoverContactsAction, reactivateUserAction, updateUserAction } from "../../settings/users/actions";

export const metadata = { title: "Teammate" };
export const dynamic = "force-dynamic";

/**
 * One teammate. Admins edit the profile, reset the password, hand over contacts, deactivate (with handover) and
 * reactivate; managers see the same facts read-only, with links to the person's contacts and queue.
 */
export default async function TeammatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ deactivated?: string }>;
}) {
  const me = await requireUser(["admin", "manager"]);
  const isAdmin = can(me, "users.manage");
  const { id } = await params;
  const sp = await searchParams;
  const u = await getAdminUser(id);
  if (!u) notFound();
  const now = new Date();
  const tz = me.timezone || "Asia/Kolkata";
  const [teams, targets, suggested, origin, history] = await Promise.all([
    getSetting("teams"),
    listHandoverTargets(u.id),
    defaultHandoverTarget(u.id),
    siteOrigin(),
    isAdmin ? userHistory(u.id) : Promise.resolve([]),
  ]);
  const targetOptions = targets.map((t) => ({
    value: t.id,
    label: `${t.name} (${ROLE_LABELS[t.role]}${t.team ? `, ${teams.find((x) => x.key === t.team)?.label ?? t.team}` : ""})`,
  }));
  const moving = `${u.contactCount.toLocaleString("en-IN")} contact${u.contactCount === 1 ? "" : "s"} and ${u.openTaskCount.toLocaleString("en-IN")} open task${u.openTaskCount === 1 ? "" : "s"}`;
  const isMe = u.id === me.id;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        back={
          <Link href="/team" className="inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Team
          </Link>
        }
        title={
          <span className="flex items-center gap-3">
            <Avatar name={u.name} className="h-10 w-10 text-sm" />
            <span className="min-w-0">
              <span className="block truncate">{u.name}</span>
              <span className="block truncate text-sm font-normal text-muted">{u.email}</span>
            </span>
          </span>
        }
        actions={
          <>
            <Badge tone="neutral">{ROLE_LABELS[u.role]}</Badge>
            {u.active ? <Badge tone="success">Active</Badge> : <Badge>Deactivated</Badge>}
          </>
        }
      />

      <div className="flex flex-col gap-5">
        {sp.deactivated !== undefined && !u.active && (
          <FlashBanner
            param="deactivated"
            message={`${u.name} is deactivated and signed out everywhere. ${Number(sp.deactivated) || 0} contact${Number(sp.deactivated) === 1 ? "" : "s"} moved, with full history.`}
          />
        )}

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Contacts owned", u.contactCount.toLocaleString("en-IN")],
            ["Open tasks", u.openTaskCount.toLocaleString("en-IN")],
            ["Last sign-in", u.lastLoginAt ? formatRelative(u.lastLoginAt, now) : "Never"],
            ["Last lead", u.lastAssignedAt ? formatRelative(u.lastAssignedAt, now) : "—"],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-border bg-surface px-3 py-2.5">
              <dt className="text-xs text-muted">{k}</dt>
              <dd className="tabular mt-0.5 font-semibold">{v}</dd>
            </div>
          ))}
        </dl>

        <div className="flex flex-wrap gap-2">
          {u.role !== "support" && (
            <ButtonLink href={`/contacts?owner=${u.id}`} variant="outline" size="sm">
              <Users className="h-4 w-4" aria-hidden /> Their contacts
            </ButtonLink>
          )}
          <ButtonLink href="/today?view=team" variant="outline" size="sm">
            <ListChecks className="h-4 w-4" aria-hidden /> Team queue
          </ButtonLink>
        </div>

        {!isAdmin && (
          <Card>
            <CardHeader title="Profile" description="Only an admin changes roles, teams, passwords and who is active." />
            <dl className="grid gap-x-6 gap-y-3 px-4 py-4 text-sm sm:grid-cols-2">
              {[
                ["Role", ROLE_LABELS[u.role]],
                ["Team", u.team ? (teams.find((t) => t.key === u.team)?.label ?? u.team) : "No team"],
                ["Time zone", u.timezone],
                ["Phone", u.phone ? formatPhone(u.phone) : "—"],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd className="mt-0.5">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
        )}

        {isAdmin && (
          <>
            <Card>
              <CardHeader title="Profile" description="Role decides what they can see and do. A role change takes effect on their next click." />
              <CardBody>
                <SettingsForm action={updateUserAction} aria-label="Profile" inlineFieldErrors>
                  <input type="hidden" name="id" value={u.id} />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Name" htmlFor="name" required>
                      <Input id="name" name="name" defaultValue={u.name} required maxLength={100} />
                      <FieldError field="name" />
                    </Field>
                    <Field label="Phone" htmlFor="phone" hint="Optional.">
                      <Input id="phone" name="phone" type="tel" inputMode="tel" defaultValue={u.phone ? formatPhone(u.phone) : ""} />
                      <FieldError field="phone" />
                    </Field>
                    <Field label="Role" htmlFor="role" required hint={ROLE_HELP[u.role]}>
                      <Select id="role" name="role" defaultValue={u.role} options={ROLE_OPTIONS} />
                      <FieldError field="role" />
                    </Field>
                    <Field label="Team" htmlFor="team">
                      <Select id="team" name="team" defaultValue={u.team ?? ""} placeholder="No team" options={teams.map((t) => ({ value: t.key, label: t.label }))} />
                      <FieldError field="team" />
                    </Field>
                    <Field label="Time zone" htmlFor="timezone" className="sm:col-span-2">
                      <Select id="timezone" name="timezone" defaultValue={u.timezone} options={timeZoneOptions()} />
                      <FieldError field="timezone" />
                    </Field>
                  </div>
                  <div className="mt-4">
                    <FormSubmit pendingText="Saving…">Save profile</FormSubmit>
                  </div>
                </SettingsForm>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Password" description="Creates a new temporary password and signs them out on every device." />
              <CardBody>
                <ResetPassword id={u.id} name={u.name} share={{ email: u.email, phone: u.phone, loginUrl: `${origin}/login` }} />
              </CardBody>
            </Card>

            {u.active && (u.contactCount > 0 || u.openTaskCount > 0) && (
              <Card>
                <CardHeader
                  title="Hand over contacts"
                  description={`Move their ${moving} to someone else and keep them active, for example before they move to support.`}
                />
                <CardBody>
                  <SettingsForm action={handoverContactsAction} confirm={`Move ${moving} away from ${u.name}?`} aria-label="Hand over contacts" inlineFieldErrors>
                    <input type="hidden" name="id" value={u.id} />
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                      <Field label="Hand over to" htmlFor="handover-to" className="flex-1">
                        <Select id="handover-to" name="handoverTo" defaultValue={suggested ?? ""} placeholder="Choose a person" options={targetOptions} required />
                      </Field>
                      <FormSubmit variant="outline" pendingText="Moving…">
                        <ArrowRightLeft className="h-4 w-4" aria-hidden /> Hand over
                      </FormSubmit>
                    </div>
                    <FieldError field="handoverTo" />
                  </SettingsForm>
                </CardBody>
              </Card>
            )}

            {u.active ? (
              <Card className="border-danger/30">
                <CardHeader
                  title="Deactivate"
                  description="When someone leaves: their contacts and open tasks move to the person you choose, with full history, the account is switched off and they are signed out everywhere."
                />
                <CardBody>
                  {isMe ? (
                    <p className="text-sm text-muted">You cannot deactivate your own account. Ask another admin.</p>
                  ) : (
                    <SettingsForm action={deactivateUserAction} aria-label="Deactivate" inlineFieldErrors>
                      <input type="hidden" name="id" value={u.id} />
                      <div className="flex flex-col gap-4">
                        <Field
                          label="Who receives their contacts?"
                          htmlFor="deactivate-to"
                          required
                          hint={`${moving} will move. The manager is suggested; anyone but support can receive them.`}
                        >
                          <Select id="deactivate-to" name="handoverTo" defaultValue={suggested ?? ""} placeholder="Choose a person" options={targetOptions} required />
                          <FieldError field="handoverTo" />
                        </Field>
                        <div>
                          <Checkbox name="confirm" label={`Yes, deactivate ${u.name}`} required />
                          <FieldError field="confirm" />
                        </div>
                        <div>
                          <FormSubmit variant="danger" pendingText="Deactivating…">
                            <UserX className="h-4 w-4" aria-hidden /> Deactivate and hand over
                          </FormSubmit>
                        </div>
                      </div>
                    </SettingsForm>
                  )}
                </CardBody>
              </Card>
            ) : (
              <Card>
                <CardHeader title="Reactivate" description="They can sign in again. Contacts handed over earlier stay where they are." />
                <CardBody>
                  <SettingsForm action={reactivateUserAction} aria-label="Reactivate">
                    <input type="hidden" name="id" value={u.id} />
                    <FormSubmit variant="outline" pendingText="Reactivating…">
                      <UserCheck className="h-4 w-4" aria-hidden /> Reactivate {u.name}
                    </FormSubmit>
                  </SettingsForm>
                </CardBody>
              </Card>
            )}


            <Card>
              <CardHeader
                title="Recent changes"
                actions={
                  <Link href={`/settings/audit?table=users&row=${u.id}`} className="text-xs font-medium underline-offset-2 hover:underline">
                    Full history
                  </Link>
                }
              />
              {history.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted">No changes recorded yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {history.map((h) => (
                    <li key={h.id} className="flex flex-col gap-0.5 px-4 py-2.5 text-sm sm:flex-row sm:items-baseline sm:gap-3">
                      <span className="shrink-0 text-xs text-muted sm:w-32">{formatDateTime(h.changedAt, tz)}</span>
                      <span className="min-w-0 flex-1 break-words">
                        {describeUserChange(h)}
                        <span className="text-muted"> · {h.by ?? "System"}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

/** The last changes to a person's account (admins only: the audit log is theirs). */
function userHistory(id: string) {
  return db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      field: auditLog.field,
      oldValue: auditLog.oldValue,
      newValue: auditLog.newValue,
      changedAt: auditLog.changedAt,
      by: users.name,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .where(and(eq(auditLog.tableName, "users"), eq(auditLog.rowId, id)))
    .orderBy(desc(auditLog.id))
    .limit(8);
}

function describeUserChange(h: { action: string; field: string | null; oldValue: unknown; newValue: unknown }): string {
  if (h.action === "insert") return "Added";
  if (h.action === "login") return "Signed in";
  if (h.field === "password") return "Password reset";
  if (h.field === "active") return h.newValue === false ? "Deactivated" : "Reactivated";
  if (h.field === "handover") {
    const n = (h.newValue as { contacts?: number } | null)?.contacts ?? 0;
    return `Handed over ${n} contact${n === 1 ? "" : "s"}`;
  }
  if (h.field) return `${h.field}: ${showValue(h.oldValue, 40)} → ${showValue(h.newValue, 40)}`;
  return h.action;
}

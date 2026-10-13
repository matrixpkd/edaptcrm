import { sql } from "drizzle-orm";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { countryName } from "@/components/contacts/labels";
import { db } from "@/db";
import { users } from "@/db/schema";
import { poolSize, roundRobinByTeam } from "@/lib/admin/teams";
import { requireUser } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";
import { formatRelative } from "@/lib/utils";
import { FieldError, FormSubmit, SettingsForm } from "../_components/settings-form";
import { SettingsHeader } from "../_components/settings-header";
import { timeZoneOptions } from "../_lib/options";
import { saveAssignmentAction } from "./actions";
import { TeamsEditor } from "./teams-editor";

export const metadata = { title: "Teams and assignment" };

export default async function TeamsAssignmentPage() {
  await requireUser(["admin"]);
  const now = new Date();
  const [s, rr, pool, memberRows] = await Promise.all([
    getSettings(["teams", "assignment"]),
    roundRobinByTeam(),
    poolSize(),
    db
      .select({ team: users.team, n: sql<number>`count(*)::int` })
      .from(users)
      .groupBy(users.team),
  ]);
  const members = Object.fromEntries(memberRows.filter((r) => r.team).map((r) => [r.team!, Number(r.n)]));
  const teamOptions = s.teams.map((t) => ({ value: t.key, label: t.label }));
  const a = s.assignment;
  const noTeam = rr.get("") ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <SettingsHeader
        title="Teams and assignment"
        description="New leads are assigned automatically: GCC numbers to one team, all others to another, then round robin among that team's active salespeople."
      />
      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader title="Who gets the next lead" description="Least recently assigned first. Returning contacts stay with their current owner." />
          <CardBody className="flex flex-col gap-4">
            {!a.autoAssign && (
              <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> Auto-assign is off: every new lead lands in the pool ({pool.toLocaleString("en-IN")} there now).
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              {s.teams.map((t) => {
                const list = rr.get(t.key) ?? [];
                const gets = [t.key === a.gccTeam ? "GCC numbers" : null, t.key === a.defaultTeam ? "all other numbers" : null].filter(Boolean);
                return (
                  <section key={t.key} className="rounded-lg border border-border" aria-labelledby={`rr-${t.key}`}>
                    <div className="border-b border-border px-3 py-2">
                      <h3 id={`rr-${t.key}`} className="text-sm font-semibold">
                        {t.label}
                      </h3>
                      <p className="text-xs text-muted">{gets.length ? `Gets ${gets.join(" and ")}` : "Gets no new leads"} · {t.timezone}</p>
                    </div>
                    {list.length === 0 ? (
                      <p className="px-3 py-3 text-sm text-muted">
                        {gets.length ? "No active salespeople: its new leads go to the pool." : "No active salespeople."}
                      </p>
                    ) : (
                      <ol className="divide-y divide-border">
                        {list.map((m, i) => (
                          <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                            <span className="tabular w-5 text-xs text-muted">{i + 1}.</span>
                            <span className="min-w-0 flex-1 truncate">{m.name}</span>
                            {i === 0 && gets.length > 0 && a.autoAssign && <Badge tone="brand">Next</Badge>}
                            <span className="hidden text-xs text-muted sm:inline">
                              {m.lastAssignedAt ? `last ${formatRelative(m.lastAssignedAt, now)}` : "no leads yet"}
                            </span>
                            <span className="tabular text-xs text-muted" title="Contacts owned">
                              {m.contactCount.toLocaleString("en-IN")}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                );
              })}
            </div>
            {noTeam.length > 0 && (
              <p className="text-xs text-muted">
                Not in any team (they get no automatic leads): {noTeam.map((m) => m.name).join(", ")}. Set their team in Users.
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Assignment rules" />
          <CardBody>
            <SettingsForm action={saveAssignmentAction} aria-label="Assignment rules" inlineFieldErrors>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="GCC countries"
                  htmlFor="gccCountries"
                  className="sm:col-span-2"
                  hint={`Two-letter codes, separated by commas. Now: ${a.gccCountries.map((c) => countryName(c)).join(", ") || "none"}.`}
                >
                  <Input id="gccCountries" name="gccCountries" defaultValue={a.gccCountries.join(", ")} autoCapitalize="characters" />
                  <FieldError field="gccCountries" />
                </Field>
                <Field label="Team for GCC numbers" htmlFor="gccTeam">
                  <Select id="gccTeam" name="gccTeam" defaultValue={a.gccTeam} options={teamOptions} />
                  <FieldError field="gccTeam" />
                </Field>
                <Field label="Team for all other numbers" htmlFor="defaultTeam">
                  <Select id="defaultTeam" name="defaultTeam" defaultValue={a.defaultTeam} options={teamOptions} />
                  <FieldError field="defaultTeam" />
                </Field>
                <div className="sm:col-span-2">
                  <Checkbox name="autoAssign" defaultChecked={a.autoAssign} label="Assign new leads automatically (off: they wait in the pool)" />
                </div>
              </div>
              <div className="mt-4">
                <FormSubmit pendingText="Saving…">Save rules</FormSubmit>
              </div>
            </SettingsForm>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Teams" description="The key is stored on each user and never changes. A team with members cannot be removed." />
          <CardBody>
            <TeamsEditor initial={s.teams} members={members} zones={timeZoneOptions()} />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

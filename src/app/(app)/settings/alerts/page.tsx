import { asc, eq } from "drizzle-orm";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/form";
import { db } from "@/db";
import { users } from "@/db/schema";
import { THRESHOLD_META, type ThresholdMeta } from "@/lib/admin/meta";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";
import { FieldError, FormSubmit, SettingsForm } from "../_components/settings-form";
import { SettingsHeader } from "../_components/settings-header";
import { saveDigestAction, saveThresholdsAction } from "./actions";
import { RunAlertsButton } from "./run-alerts";

export const metadata = { title: "Alerts and digests" };

const GROUPS: ThresholdMeta["group"][] = ["Leads", "Today", "Customers", "Money", "Forecast"];
const pad = (n: number) => String(n).padStart(2, "0");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AlertsPage() {
  await requireUser(["admin"]);
  const [s, people] = await Promise.all([
    getSettings(["thresholds", "digest"]),
    db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.active, true))
      .orderBy(asc(users.name)),
  ]);
  const t = s.thresholds;
  const d = s.digest;
  const picked = new Set(d.weeklyRecipients.map((r) => r.toLowerCase()));
  const isPicked = (u: { id: string; email: string }) => picked.has(u.id.toLowerCase()) || picked.has(u.email.toLowerCase());
  const others = d.weeklyRecipients.filter(
    (r) => !UUID.test(r) && !people.some((u) => u.email.toLowerCase() === r.toLowerCase()),
  );
  // a recipient saved by id whose account is gone or deactivated is kept, but cannot be shown as a checkbox
  const hiddenIds = d.weeklyRecipients.filter((r) => UUID.test(r) && !people.some((u) => u.id === r));

  return (
    <div className="mx-auto max-w-4xl">
      <SettingsHeader
        title="Alerts and digests"
        description="When each alert fires, how long the Today list is, and who gets the daily and weekly emails."
        actions={<RunAlertsButton />}
      />
      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader
            title="Thresholds"
            description="Alerts run every 15 minutes and every night; new values apply from the next run."
          />
          <CardBody>
            <SettingsForm action={saveThresholdsAction} aria-label="Thresholds" inlineFieldErrors>
              <div className="flex flex-col gap-6">
                {GROUPS.map((g) => (
                  <fieldset key={g} className="flex flex-col gap-3">
                    <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{g}</legend>
                    {THRESHOLD_META.filter((m) => m.group === g).map((m) => (
                      <div
                        key={m.key}
                        className="grid gap-1.5 border-b border-border pb-3 last:border-0 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-6"
                      >
                        <div className="min-w-0">
                          <label htmlFor={`t-${m.key}`} className="text-sm font-medium">
                            {m.label}
                          </label>
                          <p className="text-xs text-muted">{m.hint}</p>
                          <FieldError field={m.key} />
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="w-24">
                            <Input
                              id={`t-${m.key}`}
                              name={m.key}
                              type="number"
                              inputMode="numeric"
                              min={m.min}
                              max={m.max}
                              step={1}
                              defaultValue={t[m.key]}
                              required
                              className="text-right tabular"
                            />
                          </div>
                          <span className="w-20 text-sm text-muted">{m.unit}</span>
                        </div>
                      </div>
                    ))}
                  </fieldset>
                ))}
              </div>
              <div className="mt-4">
                <FormSubmit pendingText="Saving…">Save thresholds</FormSubmit>
              </div>
            </SettingsForm>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Digests"
            description="The daily digest goes to each person at this time in their own time zone. The weekly summary goes out every Monday."
          />
          <CardBody>
            <SettingsForm action={saveDigestAction} aria-label="Digests" inlineFieldErrors>
              {hiddenIds.map((id) => (
                <input key={id} type="hidden" name="recipientIds" value={id} />
              ))}
              <div className="flex flex-col gap-5">
                <Field label="Daily digest time" htmlFor="dailyTime" hint="Local time of each user.">
                  <div className="w-36">
                    <Input
                      id="dailyTime"
                      name="dailyTime"
                      type="time"
                      step={60}
                      defaultValue={`${pad(d.dailyHour)}:${pad(d.dailyMinute)}`}
                      required
                    />
                  </div>
                  <FieldError field="dailyTime" />
                </Field>
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-sm font-medium">Weekly summary and VIP digest</legend>
                  <p className="text-xs text-muted">Every admin always receives them. Add others here.</p>
                  <ul className="mt-1 grid gap-2 sm:grid-cols-2">
                    {people.map((u) =>
                      u.role === "admin" ? (
                        <li key={u.id}>
                          <Checkbox checked disabled readOnly label={`${u.name} (admin, always)`} />
                        </li>
                      ) : (
                        <li key={u.id}>
                          <Checkbox
                            name="recipientIds"
                            value={u.id}
                            defaultChecked={isPicked(u)}
                            label={`${u.name} (${ROLE_LABELS[u.role]})`}
                          />
                        </li>
                      ),
                    )}
                  </ul>
                </fieldset>
                <Field label="Other email addresses" htmlFor="otherRecipients" hint="One per line, for people outside the CRM.">
                  <Textarea
                    id="otherRecipients"
                    name="otherRecipients"
                    rows={2}
                    defaultValue={others.join("\n")}
                    placeholder="name@example.com"
                  />
                  <FieldError field="weeklyRecipients" />
                </Field>
              </div>
              <div className="mt-4">
                <FormSubmit pendingText="Saving…">Save digests</FormSubmit>
              </div>
            </SettingsForm>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

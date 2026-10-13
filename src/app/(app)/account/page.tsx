import { Monitor } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { MIN_PASSWORD_LENGTH, describeUserAgent, listOwnSessions } from "@/lib/auth/account";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { currentSessionId, requireUser } from "@/lib/auth/session";
import { getSetting, labelFor } from "@/lib/settings";
import { formatDateTime } from "@/lib/utils";
import { timeZoneOptions } from "../settings/_lib/options";
import { PasswordForm, SignOutOthersForm, TimezoneForm } from "./account-forms";

export const metadata = { title: "Your account" };

/** Every signed-in person's own account: who they are, their password, time zone and sessions. */
export default async function AccountPage() {
  const user = await requireUser();
  const tz = user.timezone || "Asia/Kolkata";
  const [teams, sessionId] = await Promise.all([getSetting("teams"), currentSessionId()]);
  const sessions = await listOwnSessions(user.id, sessionId);
  const others = sessions.filter((s) => !s.current).length;
  const details: { label: string; value: React.ReactNode }[] = [
    { label: "Name", value: user.name },
    { label: "Email", value: user.email },
    { label: "Role", value: ROLE_LABELS[user.role] },
    { label: "Team", value: user.team ? labelFor(teams, user.team) : <span className="text-muted">No team</span> },
    { label: "Time zone", value: tz.replace(/_/g, " ") },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="Your account" description="Your details, password, time zone and where you are signed in." />

      <Card>
        <CardBody className="flex items-start gap-4">
          <Avatar name={user.name} />
          <dl className="grid min-w-0 flex-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            {details.map((d) => (
              <div key={d.label} className="min-w-0">
                <dt className="text-xs text-muted">{d.label}</dt>
                <dd className="mt-0.5 break-words font-medium">{d.value}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
        <p className="border-t border-border px-4 py-3 text-xs text-muted">
          Name, email, role and team are set by an admin in Settings → Users. Ask your admin to change them.
        </p>
      </Card>

      <Card>
        <CardHeader title="Time zone" description="Dates, your Today list and the 8:30 morning digest follow it." />
        <CardBody>
          <TimezoneForm value={tz} options={timeZoneOptions()} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Password"
          description="You need your current password. Changing it signs you out everywhere else."
        />
        <CardBody>
          <PasswordForm minLength={MIN_PASSWORD_LENGTH} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Where you are signed in"
          description={others ? `This browser and ${others} other session${others === 1 ? "" : "s"}.` : "Only this browser."}
          actions={<SignOutOthersForm others={others} />}
        />
        <ul className="divide-y divide-border">
          {sessions.map((s, i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-3 text-sm">
              <Monitor className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{describeUserAgent(s.userAgent)}</span>
                <span className="block text-xs text-muted">Signed in {formatDateTime(s.createdAt, tz)}</span>
              </span>
              {s.current && <Badge tone="success">This browser</Badge>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

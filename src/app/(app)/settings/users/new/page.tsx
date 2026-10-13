import { Card, CardBody } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/session";
import { getSetting } from "@/lib/settings";
import { SettingsHeader } from "../../_components/settings-header";
import { ROLE_HELP, ROLE_OPTIONS, timeZoneOptions } from "../../_lib/options";
import { NewUserForm } from "../_components/new-user-form";

export const metadata = { title: "Add user" };

export default async function NewUserPage() {
  await requireUser(["admin"]);
  const teams = await getSetting("teams");
  return (
    <div className="mx-auto max-w-3xl">
      <SettingsHeader title="Add user" backHref="/settings/users" backLabel="Users" />
      <Card>
        <CardBody>
          <NewUserForm
            roles={ROLE_OPTIONS}
            roleHelp={ROLE_HELP}
            teams={teams.map((t) => ({ value: t.key, label: t.label, timezone: t.timezone }))}
            zones={timeZoneOptions()}
          />
        </CardBody>
      </Card>
    </div>
  );
}

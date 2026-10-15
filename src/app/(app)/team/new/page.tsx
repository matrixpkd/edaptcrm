import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card, CardBody, PageHeader } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/session";
import { getSetting } from "@/lib/settings";
import { siteOrigin } from "@/lib/site";
import { ROLE_HELP, ROLE_OPTIONS, timeZoneOptions } from "../../settings/_lib/options";
import { NewUserForm } from "../../settings/users/_components/new-user-form";

export const metadata = { title: "Add teammate" };

export default async function NewTeammatePage() {
  await requireUser(["admin"]);
  const [teams, origin] = await Promise.all([getSetting("teams"), siteOrigin()]);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        back={
          <Link href="/team" className="inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Team
          </Link>
        }
        title="Add teammate"
        description="They sign in with their email and a temporary password you send them, then choose their own."
      />
      <Card>
        <CardBody>
          <NewUserForm
            loginUrl={`${origin}/login`}
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

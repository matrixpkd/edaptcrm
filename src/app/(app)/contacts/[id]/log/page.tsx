import { notFound } from "next/navigation";
import { GradeBadge } from "@/components/ui/badge";
import { LogForm } from "@/components/today/log-form";
import { ScreenSheet } from "@/components/today/screen-sheet";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { followUpPresets } from "@/lib/contacts/follow-up";
import { formatPhone } from "@/lib/phone";
import { defaultLogType, safeReturnPath, type FollowUpChoice } from "@/lib/today/rules";
import { loadLogScreen } from "@/lib/today/screens";
import { localIsoDate, localTime, validTimeZone, weekdayDate } from "@/lib/today/time";
import { logInteractionAction } from "./actions";

export const metadata = { title: "Log interaction" };
export const dynamic = "force-dynamic";

type Search = { type?: string; fromCall?: string; return?: string };

export default async function LogInteractionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!can(user, "interactions.log")) notFound();
  const screen = await loadLogScreen(id, user);
  if (!screen) notFound();

  const tz = validTimeZone(user.timezone);
  const now = new Date();
  const presets = followUpPresets(now, tz);
  const hint = (d: Date) => `${weekdayDate(d, tz)}, ${localTime(d, tz)}`;
  const followUpHints: Partial<Record<FollowUpChoice, string>> = {
    tomorrow: hint(presets.tomorrow),
    in3Days: hint(presets.in3Days),
    in1Week: hint(presets.in1Week),
  };
  const fromCall = sp.fromCall === "1";
  const contactHref = `/contacts/${screen.contact.id}`;
  const returnTo = safeReturnPath(sp.return, contactHref);
  const c = screen.contact;

  return (
    <ScreenSheet
      title={fromCall ? "How did the call go?" : "Log interaction"}
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          <span className="font-medium text-foreground">{c.name}</span>
          <span aria-hidden>·</span>
          <span className="tabular">{formatPhone(c.phoneE164)}</span>
        </span>
      }
      closeHref={returnTo}
      headerExtra={<GradeBadge grade={c.grade} score={c.edaptScore} size="sm" />}
    >
      <LogForm
        action={logInteractionAction.bind(null, c.id)}
        defaultType={fromCall ? "call" : defaultLogType(user.role, sp.type)}
        outcomes={screen.outcomes}
        lostReasons={screen.lostReasons}
        canMarkLost={screen.canMarkLost}
        followUpHints={followUpHints}
        minDate={localIsoDate(now, tz)}
        returnTo={returnTo}
      />
    </ScreenSheet>
  );
}

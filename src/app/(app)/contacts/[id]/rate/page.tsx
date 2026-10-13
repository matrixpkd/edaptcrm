import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { GradeBadge } from "@/components/ui/badge";
import { RateForm } from "@/components/today/rate-form";
import { ScreenSheet } from "@/components/today/screen-sheet";
import { requireUser } from "@/lib/auth/session";
import { safeReturnPath } from "@/lib/today/rules";
import { loadRateScreen, type LastRating } from "@/lib/today/screens";
import { shortDate, validTimeZone } from "@/lib/today/time";
import { rateContactAction } from "./actions";

export const metadata = { title: "Rate customer" };
export const dynamic = "force-dynamic";

function lastRatedLine(last: LastRating | null, now: Date, tz: string): string {
  if (!last) return "Not rated yet";
  const when = shortDate(last.at, now, tz);
  if (last.source === "self") return `Self-rated on ${when}`;
  if (last.source === "import") return `Imported rating, ${when}`;
  return `Last rated by ${last.byName ?? "a former team member"} on ${when}`;
}

export default async function RateCustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ return?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const now = new Date();
  const screen = await loadRateScreen(id, user, now);
  if (!screen) notFound();
  const tz = validTimeZone(user.timezone);
  const c = screen.contact;
  const contactHref = `/contacts/${c.id}`;
  const returnTo = safeReturnPath(sp.return, contactHref);
  const lastRated = lastRatedLine(screen.lastRating, now, tz);
  const subtitle = (
    <span>
      <span className="font-medium text-foreground">{c.name}</span>
      <span className="hidden sm:inline">
        <span aria-hidden> · </span>
        {lastRated}
      </span>
    </span>
  );

  if (!screen.canRate) {
    return (
      <ScreenSheet title="Rate customer" subtitle={subtitle} closeHref={returnTo}>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
          <Lock className="h-8 w-8 text-muted" aria-hidden />
          <p className="font-medium">Only sales, managers and admins rate customers</p>
          <p className="max-w-sm text-sm text-muted">
            Salespeople rate their own contacts and the pool. You can still log a note or support issue.
          </p>
          <ButtonLink href={`/contacts/${c.id}/log`} variant="outline" className="mt-2">
            Log a note
          </ButtonLink>
        </div>
      </ScreenSheet>
    );
  }

  return (
    <ScreenSheet
      title="Rate customer"
      subtitle={subtitle}
      closeHref={returnTo}
      headerExtra={<GradeBadge grade={c.grade} score={c.edaptScore} size="sm" />}
      wide
    >
      <RateForm
        action={rateContactAction.bind(null, c.id)}
        initial={{
          aiLevel: c.aiLevel,
          umerLevel: c.umerLevel,
          spendingBand: c.spendingBand,
          gutStars: c.gutStars,
          ageBand: c.ageBand,
          industry: c.industry,
        }}
        sources={c.fieldSources}
        ageBands={screen.ageBands}
        industries={screen.industries}
        gcc={screen.gcc}
        preview={screen.preview}
        returnTo={returnTo}
        lastRated={lastRated}
      />
    </ScreenSheet>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { buttonClass } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/card";
import { StatTile } from "@/components/dashboard/kit";
import { DashboardPending, PendingArea, PeriodPicker } from "@/components/dashboard/period-picker";
import {
  AssistedSection,
  AtRiskSection,
  BeyondUmerSection,
  ChannelsSection,
  CheckoutsSection,
  DataHealthSection,
  DoorsSection,
  ForecastSection,
  LanguageSection,
  LostReasonsSection,
  ReferralsSection,
  RepeatSection,
  RevenueSection,
  RungsSection,
  TeamSection,
} from "@/components/dashboard/sections";
import { canViewCalibration, canViewDashboard } from "@/lib/dashboard/access";
import { count, deltaOf, plural, pointsDelta, share } from "@/lib/dashboard/format";
import {
  abandonedCheckoutsRecovered,
  assistedVsSelfServe,
  atRiskPool,
  beyondUmerShare,
  dataHealth,
  forecast90d,
  languageMix,
  leadsAndConversionByChannel,
  lostReasons,
  ltvByFirstDoor,
  medianDaysFirstToSecond,
  newCustomers,
  referralLeaderboard,
  repeatRate,
  revenueByFamily,
  rungMoves,
  teamView,
} from "@/lib/dashboard/metrics";
import { isoDateIn, PERIOD_LABELS, periodQuery, resolvePeriod } from "@/lib/dashboard/period";
import { requireUser } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";
import { validTimeZone } from "@/lib/today/time";
import { formatINR, formatINRCompact } from "@/lib/utils";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

const firstParam = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SP> }) {
  // Admin and manager only (spec: "Dashboard | The growth cockpit | Umer, manager"); others go back to Today.
  const user = await requireUser();
  if (!canViewDashboard(user)) redirect("/today?denied=1");
  const sp = await searchParams;
  const tz = validTimeZone(user.timezone);
  const now = new Date();
  const range = resolvePeriod({ period: sp.period, from: sp.from, to: sp.to }, now, tz);

  const [
    settings,
    revenue,
    customers,
    channels,
    doors,
    repeat,
    median,
    rungs,
    forecast,
    risk,
    checkouts,
    assisted,
    team,
    beyond,
    languages,
    leaderboard,
    health,
    lost,
  ] = await Promise.all([
    getSettings(["thresholds"]),
    revenueByFamily(range),
    newCustomers(range),
    leadsAndConversionByChannel(range),
    ltvByFirstDoor(),
    repeatRate(),
    medianDaysFirstToSecond(),
    rungMoves(range),
    forecast90d(),
    atRiskPool(),
    abandonedCheckoutsRecovered(range),
    assistedVsSelfServe(range),
    teamView(range),
    beyondUmerShare({ ...range, timeZone: tz }),
    languageMix(range),
    referralLeaderboard(),
    dataHealth(now),
    lostReasons(range),
  ]);
  const { thresholds } = settings;

  const isMonth = range.key === "month";
  const revenueCompare = isMonth ? revenue.totals.previousToDate : revenue.totals.previous;
  const customersCompare = isMonth ? customers.previousToDate : customers.previous;
  const presets = (["month", "30d", "90d"] as const).map((key) => ({
    key,
    label: PERIOD_LABELS[key],
    href: `/dashboard${periodQuery({ key, from: "", to: "" })}`,
  }));

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Is Edapt growing the right way, not just growing?"
        actions={
          canViewCalibration(user) ? (
            <Link href="/dashboard/calibration" className={buttonClass("outline", "sm", "h-10 sm:h-8")}>
              <FlaskConical className="h-4 w-4" aria-hidden />
              Calibration report
            </Link>
          ) : null
        }
      />

      <DashboardPending>
        <div className="mb-5">
          <PeriodPicker
            presets={presets}
            active={range.key}
            from={range.error ? firstParam(sp.from) : range.from}
            to={range.error ? firstParam(sp.to) : range.to}
            maxDate={isoDateIn(now, tz)}
            basePath="/dashboard"
            openCustom={Boolean(range.error)}
          />
          {sp.denied === "calibration" && (
            <p role="status" className="mt-3 rounded-lg bg-surface-muted px-3 py-2 text-sm">
              The calibration report is for admins, since it is used to tune the scoring weights.
            </p>
          )}
          {range.error && (
            <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              {range.error} Showing this month instead.
            </p>
          )}
        </div>

        <PendingArea>
          <section aria-label={`Headline numbers, ${range.label}`} className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatTile
              label="Revenue"
              value={formatINRCompact(revenue.totals.current)}
              title={formatINR(revenue.totals.current)}
              delta={deltaOf(revenue.totals.current, revenueCompare)}
              compare={range.compareLabel}
            />
            <StatTile
              label="New paying customers"
              value={count(customers.current)}
              delta={deltaOf(customers.current, customersCompare)}
              compare={range.compareLabel}
            />
            <StatTile
              label="Lead conversion"
              value={share(channels.totals.conversion)}
              hint={
                channels.totals.leads
                  ? `${count(channels.totals.converted)} of ${plural(channels.totals.leads, "new lead")} paid`
                  : "No new leads yet"
              }
            />
            <StatTile
              label="90-day forecast"
              value={formatINRCompact(forecast.totalInr)}
              title={formatINR(forecast.totalInr)}
              hint={forecast.customers ? `From ${plural(forecast.customers, "customer")}` : "No repeat history yet"}
            />
            <StatTile
              label="At-risk customers"
              value={count(risk.count)}
              href={risk.count > 0 ? "/contacts?risk=1" : undefined}
              hint={`${formatINRCompact(risk.expectedInr)} expected value`}
            />
            <StatTile
              label="Beyond-Umer share"
              value={share(beyond.current.share)}
              delta={pointsDelta(beyond.current.share, beyond.previous.share)}
              compare={range.prevLabel}
            />
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <RevenueSection data={revenue} range={range} className="lg:col-span-2" />
            <ChannelsSection data={channels} range={range} />
            <DoorsSection data={doors} />
            <RepeatSection rate={repeat} median={median} />
            <RungsSection data={rungs} range={range} />
            <ForecastSection data={forecast} />
            <AtRiskSection data={risk} atRiskDays={thresholds.atRiskDays} />
            <CheckoutsSection data={checkouts} range={range} />
            <AssistedSection data={assisted} range={range} creditDays={thresholds.salesCreditDays} />
            <TeamSection rows={team} range={range} className="lg:col-span-2" />
            <BeyondUmerSection data={beyond} range={range} />
            <LanguageSection data={languages} range={range} />
            <ReferralsSection data={leaderboard} />
            <DataHealthSection data={health} />
            <LostReasonsSection data={lost} range={range} />
          </div>
        </PendingArea>
      </DashboardPending>
    </div>
  );
}

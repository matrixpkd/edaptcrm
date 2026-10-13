import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Info, SlidersHorizontal } from "lucide-react";
import { buttonClass } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { StatTile } from "@/components/dashboard/kit";
import { VIZ } from "@/components/dashboard/palette";
import { requireUser } from "@/lib/auth/session";
import { canViewCalibration, canViewDashboard } from "@/lib/dashboard/access";
import { calibration, VALUE_DIMENSIONS, type CalibrationCell, type CalibrationTable } from "@/lib/dashboard/calibration";
import { count, plural, share } from "@/lib/dashboard/format";
import { validTimeZone } from "@/lib/today/time";
import { cn, DAY_MS, formatDate } from "@/lib/utils";

export const metadata = { title: "Calibration report" };
export const dynamic = "force-dynamic";

/** Where scoring weights are edited (Settings > Scoring). */
const SCORING_SETTINGS_HREF = "/settings/scoring";

export default async function CalibrationPage() {
  const user = await requireUser();
  if (!canViewDashboard(user)) redirect("/today?denied=1");
  // the report exists to tune the weights, which only an admin edits
  if (!canViewCalibration(user)) redirect("/dashboard?denied=calibration");
  const tz = validTimeZone(user.timezone);
  const now = new Date();
  const report = await calibration(now);
  const { totals, windowDays, minN } = report;
  const historyDays = report.firstContactAt || report.firstPurchaseAt
    ? Math.floor(
        (now.getTime() -
          Math.min(report.firstContactAt?.getTime() ?? Infinity, report.firstPurchaseAt?.getTime() ?? Infinity)) /
          DAY_MS,
      )
    : 0;
  const empty = totals.leads === 0 && totals.customers === 0;

  return (
    <div>
      <PageHeader
        back={
          <Link href="/dashboard" className="inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Dashboard
          </Link>
        }
        title="Calibration report"
        description="Conversion and repeat rates by score band and by each scoring input, so the data gets a vote on the weights."
        actions={
          <Link href={SCORING_SETTINGS_HREF} className={buttonClass("outline", "sm", "h-10 sm:h-8")}>
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
            Edit weights
          </Link>
        }
      />

      <div className="mb-5 flex gap-3 rounded-xl border border-border bg-surface p-4 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
        <div className="space-y-1.5">
          <p>
            Every weight is a starting hypothesis. Weights are edited in{" "}
            <Link href={SCORING_SETTINGS_HREF} className="font-medium underline underline-offset-2">
              Settings → Scoring
            </Link>
            , with no code change.
          </p>
          <p className="text-muted">
            The report becomes meaningful after about {windowDays} days: a lead is judged once it is {windowDays} days old (did it pay
            within {windowDays} days?), and a customer once their first purchase is {windowDays} days old (did they buy again within{" "}
            {windowDays} days?). Imported records and people who had paid before the CRM first saw them are not judged as leads.{" "}
            {historyDays > 0 && (
              <>
                Your data goes back {plural(historyDays, "day")}
                {historyDays < windowDays ? ", so it is still too early to read much into it." : "."}
              </>
            )}
          </p>
          <p className="text-muted">
            Grades, scores and inputs are today&apos;s values. A customer&apos;s score already counts what they bought, so the input tables
            are the cleaner signal. Rates marked <FewBadge /> come from fewer than {minN} people and are mostly noise.
          </p>
        </div>
      </div>

      {empty ? (
        <div className="rounded-xl border border-border bg-surface">
          <EmptyState
            title="Nothing to calibrate yet"
            description={`The report needs leads created at least ${windowDays} days ago, or customers whose first purchase was at least ${windowDays} days ago. Check back once the CRM has that much history.`}
          />
        </div>
      ) : (
        <>
          <section aria-label="Overall" className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Leads judged" value={count(totals.leads)} hint={`Created ${windowDays}+ days ago`} />
            <StatTile
              label={`Paid within ${windowDays} days`}
              value={share(totals.conversion)}
              hint={`${count(totals.converted)} of ${count(totals.leads)} leads`}
            />
            <StatTile label="Customers judged" value={count(totals.customers)} hint={`First purchase ${windowDays}+ days ago`} />
            <StatTile
              label={`Bought again within ${windowDays} days`}
              value={share(totals.repeatRate)}
              hint={`${count(totals.repeated)} of ${count(totals.customers)} customers`}
            />
          </section>

          <nav aria-label="Tables" className="mb-4 flex flex-wrap gap-1.5">
            {report.tables.map((t) => (
              <a
                key={t.dim}
                href={`#cal-${t.dim}`}
                className="inline-flex min-h-10 items-center rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium sm:min-h-0 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t.title}
              </a>
            ))}
          </nav>

          <div className="space-y-4">
            {report.tables.map((t) => (
              <CalibrationTableCard key={t.dim} table={t} overall={{ conversion: totals.conversion, repeat: totals.repeatRate }} windowDays={windowDays} />
            ))}
          </div>
          <p className="mt-4 text-xs text-muted">Worked out live on {formatDate(report.generatedAt, tz)} from every contact that is not merged away.</p>
        </>
      )}
    </div>
  );
}

function FewBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-surface-muted px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-muted ring-1 ring-inset ring-border">
      few
    </span>
  );
}

function CalibrationTableCard({
  table,
  overall,
  windowDays,
}: {
  table: CalibrationTable;
  overall: { conversion: number | null; repeat: number | null };
  windowDays: number;
}) {
  return (
    <section id={`cal-${table.dim}`} aria-labelledby={`cal-${table.dim}-title`} className="scroll-mt-20 rounded-xl border border-border bg-surface">
      <header className="border-b border-border px-4 py-3">
        <h2 id={`cal-${table.dim}-title`} className="text-sm font-semibold">
          {table.title}
        </h2>
        <p className="mt-0.5 text-xs text-muted">{table.note}</p>
      </header>
      {table.rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted">No one to judge here yet.</p>
      ) : (
        <Table className="md:table-fixed">
          <caption className="sr-only">
            {table.title}: conversion within {windowDays} days and repeat within {windowDays} days
          </caption>
          {/* the same column widths in every table, so rates line up down the page */}
          <colgroup>
            <col className={table.pointsLabel ? "md:w-[32%]" : "md:w-[44%]"} />
            {table.pointsLabel && <col className="md:w-[12%]" />}
            <col className="md:w-[9%]" />
            <col className="md:w-[19%]" />
            <col className="md:w-[9%]" />
            <col className="md:w-[19%]" />
          </colgroup>
          <thead>
            <tr>
              <Th>{table.title}</Th>
              {table.pointsLabel && <Th className="text-right">{table.pointsLabel}</Th>}
              <Th className="text-right">Leads</Th>
              <Th>Paid within {windowDays}d</Th>
              {/* the Value inputs are judged per purchase (VALUE_DIMENSIONS), the rest per person */}
              <Th className="text-right">{(VALUE_DIMENSIONS as readonly string[]).includes(table.dim) ? "Purchases" : "Customers"}</Th>
              <Th>Bought again</Th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r) => (
              <tr key={r.key || "none"}>
                <Td className={cn("min-w-40 md:min-w-0", r.key === "" && "text-muted")}>{r.label}</Td>
                {table.pointsLabel && <Td className="tabular text-right">{formatPoints(r, table.dim)}</Td>}
                <Td className="tabular text-right">{count(r.leads)}</Td>
                <Td>
                  <RateCell rate={r.conversion} part={r.converted} whole={r.leads} low={r.lowLeads} />
                </Td>
                <Td className="tabular text-right">{count(r.customers)}</Td>
                <Td>
                  <RateCell rate={r.repeatRate} part={r.repeated} whole={r.customers} low={r.lowCustomers} />
                </Td>
              </tr>
            ))}
            <tr className="bg-surface-muted/40 text-muted">
              <Td>All</Td>
              {table.pointsLabel && <Td />}
              <Td />
              <Td>
                <span className="tabular block w-11 text-right">{share(overall.conversion)}</span>
              </Td>
              <Td />
              <Td>
                <span className="tabular block w-11 text-right">{share(overall.repeat)}</span>
              </Td>
            </tr>
          </tbody>
        </Table>
      )}
    </section>
  );
}

function formatPoints(r: CalibrationCell, dim: CalibrationTable["dim"]): string {
  if (r.points === null) return "—";
  if (dim === "gut_stars") return r.points > 0 ? `+${r.points}` : r.points < 0 ? `−${Math.abs(r.points)}` : "0";
  return String(r.points);
}

/** A rate with a small single-hue bar; rates from too few people are greyed and marked "few" (never colour alone). */
function RateCell({ rate, part, whole, low }: { rate: number | null; part: number; whole: number; low: boolean }) {
  if (whole === 0 || rate === null) return <span className="text-muted">—</span>;
  return (
    <span className="flex min-w-36 items-center gap-2" title={`${count(part)} of ${count(whole)}`}>
      <span className={cn("tabular w-11 text-right", low ? "text-muted" : "font-semibold")}>{share(rate)}</span>
      <span aria-hidden className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-muted">
        <span className="block h-full rounded-full" style={{ width: `${Math.max(0, Math.min(1, rate)) * 100}%`, background: low ? VIZ.context : VIZ.series1 }} />
      </span>
      {low && <FewBadge />}
    </span>
  );
}

import { CalendarClock, Flame, ListOrdered } from "lucide-react";
import type { QueueBand, QueueCounts, QueueRow } from "@/lib/today/rank";
import { cn } from "@/lib/utils";
import { QueueRowCard } from "./queue-row";
import { toRowView } from "./row-view";

const SECTIONS: { band: QueueBand; title: string; hint: string; icon: React.ComponentType<{ className?: string }> }[] = [
  {
    band: "abandoned",
    title: "Hottest leads",
    hint: "They started paying and did not finish. Call first.",
    icon: Flame,
  },
  {
    band: "overdue",
    title: "Overdue follow-ups",
    hint: "You said you would get back to these.",
    icon: CalendarClock,
  },
  {
    band: "next",
    title: "Up next",
    hint: "Customers by expected revenue, leads by Edapt Score.",
    icon: ListOrdered,
  },
];

/** The ranked rows, split under band headings. Ranks run on across the sections. */
export function QueueList({
  rows,
  idPrefix = "",
  returnTo = "/today",
  canAnswerTransfer = false,
  showHeadings = true,
}: {
  rows: QueueRow[];
  idPrefix?: string;
  returnTo?: string;
  canAnswerTransfer?: boolean;
  showHeadings?: boolean;
}) {
  let rank = 0;
  return (
    <div className="space-y-6">
      {SECTIONS.map((s) => {
        const list = rows.filter((r) => r.band === s.band);
        if (!list.length) return null;
        const Icon = s.icon;
        const start = rank + 1;
        const headingId = `${idPrefix}${s.band}-heading`;
        return (
          <section key={s.band} id={`${idPrefix}${s.band}`} aria-labelledby={headingId} className="scroll-mt-20">
            {showHeadings && (
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <h2 id={headingId} className="flex items-center gap-1.5 text-sm font-semibold">
                  <Icon className={cn("h-4 w-4", s.band === "abandoned" ? "text-danger" : "text-muted")} aria-hidden />
                  {s.title}
                  <span className="tabular font-normal text-muted">{list.length}</span>
                </h2>
                <p className="hidden text-xs text-muted sm:block">{s.hint}</p>
              </div>
            )}
            {!showHeadings && (
              <h3 id={headingId} className="sr-only">
                {s.title}
              </h3>
            )}
            <ol start={start} className="space-y-2.5">
              {list.map((r) => {
                rank += 1;
                return (
                  <QueueRowCard
                    key={r.key}
                    row={toRowView(r)}
                    rank={rank}
                    returnTo={returnTo}
                    canAnswerTransfer={canAnswerTransfer}
                  />
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

/** Counts by band: hot checkouts, overdue follow-ups, customers, leads. Each jumps to its section. */
export function BandCounts({ counts, idPrefix = "" }: { counts: QueueCounts; idPrefix?: string }) {
  const tiles = [
    { key: "abandoned", label: "Checkouts", value: counts.abandoned, href: `#${idPrefix}abandoned`, hot: true },
    { key: "overdue", label: "Overdue", value: counts.overdue, href: `#${idPrefix}overdue` },
    { key: "customers", label: "Customers", value: counts.customers, href: `#${idPrefix}next` },
    { key: "leads", label: "Leads", value: counts.leads + counts.other, href: `#${idPrefix}next` },
  ];
  return (
    <ul className="grid grid-cols-4 gap-2" aria-label="Today by band">
      {tiles.map((t) => {
        const body = (
          <>
            <span
              className={cn(
                "tabular block text-xl font-semibold leading-none sm:text-2xl",
                t.hot && t.value > 0 && "text-danger",
                t.value === 0 && "text-muted",
              )}
            >
              {t.value}
            </span>
            <span className="mt-1 block truncate text-[11px] font-medium text-muted sm:text-xs">{t.label}</span>
          </>
        );
        return (
          <li key={t.key}>
            {t.value > 0 ? (
              <a
                href={t.href}
                className="block rounded-xl border border-border bg-surface px-2.5 py-2.5 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4 sm:py-3"
              >
                {body}
              </a>
            ) : (
              <div className="rounded-xl border border-border bg-surface px-2.5 py-2.5 sm:px-4 sm:py-3">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

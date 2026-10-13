/**
 * The Monday weekly summary for Umer (spec "Alerts and the Today queue" and "Dashboard: the growth cockpit").
 * PURE: data in, { subject, html, text } out. The numbers are gathered by src/lib/alerts/digest.ts.
 */
import { formatINR, formatINRCompact, pct } from "@/lib/utils";
import { contactLink, link, plural, renderEmail, type EmailBlock, type RenderedEmail } from "./render";

export type WeeklySummaryData = {
  /** [start, end) in `timeZone`; end is exclusive (00:00 of the send day) */
  range: { start: Date; end: Date; timeZone: string };
  revenue: { current: number; previous: number };
  newCustomers: number;
  leads: {
    /** new contacts created this week */
    total: number;
    /** inbound touches this week (enquiries) */
    enquiries: number;
    byChannel: { key: string; label: string; count: number }[];
  };
  /** verified revenue split by sales credit */
  assisted: { assistedInr: number; selfServeInr: number };
  /**
   * share of this week's revenue from rated customers that came from customers at Umer familiarity 0 to 2
   * (null without rated revenue); revenue from unrated customers is left out of the share (as on the dashboard)
   */
  beyondUmer: { share: number | null; inr: number; unratedInr?: number };
  atRisk: { count: number; expectedInr: number };
  unverified: { count: number; inr: number; stale: number; staleDays: number };
  /** checkouts started this week that passed the window without a completed order, and how many paid later */
  checkouts: { abandoned: number; recovered: number };
  topAdvocates: { contactId: string; name: string; referrals: number; networkInr: number }[];
  vipQuiet: { count: number; quietDays: number; items: { contactId: string; name: string; ltvInr: number; quietDays: number }[] };
};

/** "+12%", "-5%", "new" (previous week was zero), "no change". */
export function changeLabel(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? "no change" : "new";
  const ch = (current - previous) / Math.abs(previous);
  if (Math.abs(ch) < 0.005) return "no change";
  return `${ch > 0 ? "+" : "-"}${Math.round(Math.abs(ch) * 100)}%`;
}

/** "+40% on the week before (₹1,00,000)", "Nothing the week before", "Same as the week before". */
export function revenueNote(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? "No revenue this week or the week before" : "Nothing the week before";
  const ch = changeLabel(current, previous);
  return ch === "no change" ? `Same as the week before (${formatINR(previous)})` : `${ch} on the week before (${formatINR(previous)})`;
}

function rangeLabel(r: WeeklySummaryData["range"]): string {
  const f = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: r.timeZone });
  // `end` is exclusive: the last day shown is the day before
  const last = new Date(r.end.getTime() - 1);
  return `${f.format(r.start)} to ${f.format(last)}`;
}

export function weeklySummarySubject(d: WeeklySummaryData): string {
  return `Week of ${rangeLabel(d.range)}: ${formatINRCompact(d.revenue.current)} revenue (${changeLabel(d.revenue.current, d.revenue.previous)}), ${plural(d.newCustomers, "new customer")}`;
}

export function weeklySummaryEmail(d: WeeklySummaryData): RenderedEmail {
  const totalCredit = d.assisted.assistedInr + d.assisted.selfServeInr;
  const blocks: EmailBlock[] = [
    {
      kind: "stats",
      items: [
        {
          label: "Revenue",
          value: formatINR(d.revenue.current),
          note: `${revenueNote(d.revenue.current, d.revenue.previous)}. Verified money, net of refunds.`,
        },
        { label: "New customers", value: String(d.newCustomers), note: "First verified purchase this week" },
        { label: "New leads", value: String(d.leads.total), note: `${plural(d.leads.enquiries, "enquiry", "enquiries")} in all` },
        {
          label: "Beyond-Umer share",
          value: d.beyondUmer.share === null ? "—" : pct(d.beyondUmer.share),
          note: `${formatINR(d.beyondUmer.inr)} from customers at Umer familiarity 0 to 2${
            d.beyondUmer.unratedInr ? `; ${formatINR(d.beyondUmer.unratedInr)} from unrated customers is left out` : ""
          }`,
        },
      ],
    },
    {
      kind: "section",
      title: "Assisted vs self-serve",
      blocks: [
        {
          kind: "stats",
          items: [
            { label: "Assisted by a salesperson", value: formatINR(d.assisted.assistedInr), note: totalCredit ? pct(d.assisted.assistedInr / totalCredit) : null },
            { label: "Self-serve", value: formatINR(d.assisted.selfServeInr), note: totalCredit ? pct(d.assisted.selfServeInr / totalCredit) : null },
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Leads by channel",
      blocks: d.leads.byChannel.length
        ? [{ kind: "stats", items: d.leads.byChannel.map((c) => ({ label: c.label, value: String(c.count) })) }]
        : [{ kind: "text", text: "No new leads this week.", muted: true }],
    },
    {
      kind: "section",
      title: "Watch list",
      blocks: [
        {
          kind: "stats",
          items: [
            { label: "At-risk customers", value: String(d.atRisk.count), note: `${formatINR(d.atRisk.expectedInr)} expected in 90 days if they come back` },
            {
              label: "Unverified payments",
              value: String(d.unverified.count),
              note: d.unverified.count
                ? `${formatINR(d.unverified.inr)}${d.unverified.stale ? `, ${d.unverified.stale} waiting more than ${plural(d.unverified.staleDays, "day")}` : ""}`
                : null,
            },
            {
              label: "Abandoned checkouts",
              value: String(d.checkouts.abandoned),
              note: d.checkouts.abandoned ? `${d.checkouts.recovered} of them recovered so far` : null,
            },
          ],
        },
      ],
    },
  ];

  if (d.topAdvocates.length) {
    blocks.push({
      kind: "section",
      title: "Top advocates",
      blocks: [
        {
          kind: "list",
          items: d.topAdvocates.map((a) => ({
            title: a.name,
            detail: `${plural(a.referrals, "paying referral")} · network value ${formatINR(a.networkInr)}`,
            href: contactLink(a.contactId),
          })),
        },
      ],
    });
  }
  if (d.vipQuiet.count) {
    blocks.push({
      kind: "section",
      title: "VIPs gone quiet",
      blocks: [
        { kind: "text", text: `Grade A customers with no activity for ${d.vipQuiet.quietDays} days or more.`, muted: true },
        {
          kind: "list",
          items: d.vipQuiet.items.map((v) => ({
            title: v.name,
            detail: `LTV ${formatINR(v.ltvInr)} · quiet for ${v.quietDays} days`,
            href: contactLink(v.contactId),
          })),
          more:
            d.vipQuiet.count > d.vipQuiet.items.length
              ? { count: d.vipQuiet.count - d.vipQuiet.items.length, label: `and ${d.vipQuiet.count - d.vipQuiet.items.length} more` }
              : null,
        },
      ],
    });
  }
  blocks.push({ kind: "button", href: link("/dashboard"), label: "Open the dashboard" });

  const subject = weeklySummarySubject(d);
  return renderEmail({
    subject,
    preheader: subject,
    title: "Your weekly summary",
    intro: `${rangeLabel(d.range)}. Amounts in INR.`,
    blocks,
    footer: "You get this summary every Monday morning.",
  });
}

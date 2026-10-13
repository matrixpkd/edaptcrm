/**
 * The daily digest email (spec "Alerts and the Today queue": a daily digest at 8:30 am in each user's own
 * time zone). PURE: data in, { subject, html, text } out. The data is gathered by src/lib/alerts/digest.ts.
 */
import { greetingFor, weekdayDate } from "@/lib/today/time";
import { formatINR } from "@/lib/utils";
import { contactLink, link, plural, renderEmail, type EmailBlock, type ListItem, type RenderedEmail } from "./render";

export type DigestContactItem = { contactId: string | null; name: string; detail?: string | null };

export type DailyDigestData = {
  user: { name: string; timeZone: string };
  now: Date;
  /** the configured local send time, e.g. "8:30 am" */
  sendTimeLabel: string;
  today: {
    /** rows on the user's Today list (before the cap) */
    total: number;
    abandoned: number;
    overdue: number;
    /** the first rows, in Today order */
    top: DigestContactItem[];
  };
  newLeads: { count: number; items: DigestContactItem[] };
  hotLeads: { count: number; items: DigestContactItem[] };
  vipQuiet: { count: number; items: DigestContactItem[] };
  /** managers and admins only (payment verifiers) */
  payments: {
    unverified: number;
    unverifiedInr: number;
    /** unverified longer than the threshold */
    stale: number;
    staleDays: number;
    overdueInstalments: number;
  } | null;
};

/** True when there is nothing worth an email. */
export function isDigestEmpty(d: DailyDigestData): boolean {
  return (
    d.today.total === 0 &&
    d.newLeads.count === 0 &&
    d.hotLeads.count === 0 &&
    d.vipQuiet.count === 0 &&
    (!d.payments || (d.payments.unverified === 0 && d.payments.overdueInstalments === 0))
  );
}

export function dailyDigestSubject(d: DailyDigestData): string {
  const parts: string[] = [];
  if (d.today.total) parts.push(`${d.today.total} on Today`);
  if (d.today.abandoned) parts.push(`${d.today.abandoned} abandoned checkout${d.today.abandoned === 1 ? "" : "s"}`);
  if (d.today.overdue) parts.push(`${d.today.overdue} overdue`);
  if (!d.today.total && d.newLeads.count) parts.push(plural(d.newLeads.count, "new lead"));
  if (d.hotLeads.count) parts.push(plural(d.hotLeads.count, "hot lead"));
  if (!parts.length && d.vipQuiet.count) parts.push(`${plural(d.vipQuiet.count, "VIP")} gone quiet`);
  if (!parts.length && d.payments?.unverified) parts.push(`${plural(d.payments.unverified, "payment")} to verify`);
  return `Your day: ${parts.join(", ") || "all clear"}`;
}

function items(list: DigestContactItem[]): ListItem[] {
  return list.map((i) => ({ title: i.name, detail: i.detail ?? null, href: i.contactId ? contactLink(i.contactId) : null }));
}

function more(count: number, shown: number, label: string, href: string) {
  const rest = count - shown;
  return rest > 0 ? { count: rest, label: `and ${rest} more ${label}`, href } : null;
}

export function dailyDigestEmail(d: DailyDigestData): RenderedEmail {
  const firstName = d.user.name.trim().split(/\s+/)[0] || "there";
  const blocks: EmailBlock[] = [];

  const stats = [
    { label: "On your Today list", value: String(d.today.total) },
    ...(d.today.abandoned ? [{ label: "Abandoned checkouts", value: String(d.today.abandoned), note: "Call these first" }] : []),
    { label: "Overdue follow-ups", value: String(d.today.overdue) },
    { label: "New leads since yesterday", value: String(d.newLeads.count) },
    ...(d.hotLeads.count ? [{ label: "Hot leads", value: String(d.hotLeads.count) }] : []),
  ];
  blocks.push({ kind: "stats", items: stats });

  if (d.today.top.length) {
    blocks.push({
      kind: "section",
      title: "Start with these",
      blocks: [{ kind: "list", items: items(d.today.top), more: more(d.today.total, d.today.top.length, "on Today", link("/today")) }],
    });
  }
  if (d.hotLeads.items.length) {
    blocks.push({
      kind: "section",
      title: "Hot leads",
      blocks: [
        { kind: "text", text: "Grade A leads who enquired. Reach them while they are warm.", muted: true },
        { kind: "list", items: items(d.hotLeads.items), more: more(d.hotLeads.count, d.hotLeads.items.length, "hot leads", link("/notifications")) },
      ],
    });
  }
  if (d.newLeads.items.length) {
    blocks.push({
      kind: "section",
      title: "New leads",
      blocks: [{ kind: "list", items: items(d.newLeads.items), more: more(d.newLeads.count, d.newLeads.items.length, "new leads", link("/contacts")) }],
    });
  }
  if (d.vipQuiet.items.length) {
    blocks.push({
      kind: "section",
      title: "VIPs gone quiet",
      blocks: [
        { kind: "text", text: "Grade A customers with no activity for a long time. A personal call keeps them close.", muted: true },
        { kind: "list", items: items(d.vipQuiet.items), more: more(d.vipQuiet.count, d.vipQuiet.items.length, "VIPs", link("/notifications")) },
      ],
    });
  }
  if (d.payments && (d.payments.unverified || d.payments.overdueInstalments)) {
    blocks.push({
      kind: "section",
      title: "Payments",
      blocks: [
        {
          kind: "stats",
          items: [
            {
              label: "Waiting for verification",
              value: String(d.payments.unverified),
              note: d.payments.unverified ? `${formatINR(d.payments.unverifiedInr)} not yet counted in LTV` : null,
            },
            ...(d.payments.stale
              ? [{ label: `Waiting more than ${plural(d.payments.staleDays, "day")}`, value: String(d.payments.stale) }]
              : []),
            ...(d.payments.overdueInstalments ? [{ label: "Overdue instalments", value: String(d.payments.overdueInstalments) }] : []),
          ],
        },
        { kind: "button", href: link("/payments?tab=unverified"), label: "Verify payments", secondary: true },
      ],
    });
  }
  blocks.push({ kind: "button", href: link("/today"), label: "Open Today" });

  const subject = dailyDigestSubject(d);
  return renderEmail({
    subject,
    preheader: subject,
    title: `${greetingFor(d.now, d.user.timeZone)}, ${firstName}`,
    intro: `Your digest for ${weekdayDate(d.now, d.user.timeZone)}.`,
    blocks,
    footer: `You get this digest every morning at ${d.sendTimeLabel} in your own time zone.`,
  });
}

import Link from "next/link";
import { sql } from "drizzle-orm";
import {
  BellRing,
  ChevronRight,
  Coins,
  Download,
  Gauge,
  History,
  ListChecks,
  MapPin,
  Package,
  PlugZap,
  Sparkles,
  UsersRound,
  Waypoints,
} from "lucide-react";
import { PageHeader } from "@/components/ui/card";
import { db } from "@/db";
import { products, settings as settingsTable, users } from "@/db/schema";
import { requireUser } from "@/lib/auth/session";
import { getSettings, type SettingKey } from "@/lib/settings";
import { formatRelative } from "@/lib/utils";

export const metadata = { title: "Settings" };

type Section = {
  href: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  meta?: string | null;
  /** settings keys edited there, for "changed 3 days ago" */
  keys?: SettingKey[];
};

export default async function SettingsPage() {
  await requireUser(["admin"]);
  const now = new Date();
  const [s, [counts], saved] = await Promise.all([
    getSettings(["teams", "assignment", "currency", "nbo.rules"]),
    db.execute<{ activeUsers: number; inactiveUsers: number; activeProducts: number }>(sql`
      select
        (select count(*)::int from ${users} where ${users.active}) as "activeUsers",
        (select count(*)::int from ${users} where not ${users.active}) as "inactiveUsers",
        (select count(*)::int from ${products} where ${products.active}) as "activeProducts"
    `),
    db.select({ key: settingsTable.key, updatedAt: settingsTable.updatedAt }).from(settingsTable),
  ]);
  const changedAt = new Map(saved.map((r) => [r.key, r.updatedAt]));
  const lastChange = (keys: SettingKey[] = []) => {
    const ds = keys.map((k) => changedAt.get(k)).filter((d): d is Date => !!d);
    if (!ds.length) return null;
    return new Date(Math.max(...ds.map((d) => d.getTime())));
  };
  const activeRules = s["nbo.rules"].filter((r) => r.active !== false).length;

  const sections: { group: string; items: Section[] }[] = [
    {
      group: "Team",
      items: [
        {
          href: "/settings/users",
          title: "Users",
          description: "Add people, change roles and teams, reset passwords, and hand over a leaver's contacts.",
          icon: UsersRound,
          meta: `${counts.activeUsers} active${counts.inactiveUsers ? `, ${counts.inactiveUsers} deactivated` : ""}`,
        },
        {
          href: "/settings/teams-assignment",
          title: "Teams and assignment",
          description: "Teams, GCC countries and the round robin that hands out new leads.",
          icon: Waypoints,
          meta: `${s.teams.length} team${s.teams.length === 1 ? "" : "s"} · auto-assign ${s.assignment.autoAssign ? "on" : "off"}`,
          keys: ["teams", "assignment"],
        },
      ],
    },
    {
      group: "Revenue",
      items: [
        {
          href: "/settings/products",
          title: "Products and ladder",
          description: "The catalogue, prices, TagMango ids, the four rungs and the product families.",
          icon: Package,
          meta: `${counts.activeProducts} active product${counts.activeProducts === 1 ? "" : "s"}`,
          keys: ["ladder.rungs", "ladder.families"],
        },
        {
          href: "/settings/currency",
          title: "Currency",
          description: "Currencies offered on payment forms and their monthly rates to INR.",
          icon: Coins,
          meta: s.currency.enabled.join(", "),
          keys: ["currency"],
        },
        {
          href: "/settings/nbo",
          title: "Next best offer",
          description: "The rules that pick each customer's next rung, with a tester.",
          icon: Sparkles,
          meta: `${activeRules} active rule${activeRules === 1 ? "" : "s"}`,
          keys: ["nbo.rules"],
        },
      ],
    },
    {
      group: "Brain",
      items: [
        {
          href: "/settings/scoring",
          title: "Scoring",
          description: "Every weight behind Fit, Readiness, Value, the Edapt Score and the grade, with a live preview.",
          icon: Gauge,
          keys: ["scoring"],
        },
        {
          href: "/settings/alerts",
          title: "Alerts and digests",
          description: "Alert thresholds, the daily digest time and who gets the weekly summary.",
          icon: BellRing,
          keys: ["thresholds", "digest"],
        },
        {
          href: "/settings/locations",
          title: "Locations",
          description: "Kerala cities, Indian metros and spellings of Kerala used by Fit scoring.",
          icon: MapPin,
          keys: ["locations"],
        },
        {
          href: "/settings/lists",
          title: "Dropdown lists",
          description: "Channels, first doors, campaigns, tags, languages, age bands, industries, lost reasons, outcomes.",
          icon: ListChecks,
          keys: [
            "lists.channels",
            "lists.firstDoors",
            "lists.campaigns",
            "lists.tags",
            "lists.languages",
            "lists.ageBands",
            "lists.industries",
            "lists.lostReasons",
            "lists.outcomes",
          ],
        },
      ],
    },
    {
      group: "Data",
      items: [
        {
          href: "/settings/integrations",
          title: "Integrations",
          description: "TagMango, Libromi, Meta lead forms and website forms: URLs, field paths and the event log.",
          icon: PlugZap,
          keys: ["integrations.fieldPaths", "integrations.selfRatings", "integrations.options"],
        },
        {
          href: "/settings/export",
          title: "Export",
          description: "Download contacts or purchases as CSV. Every export is logged.",
          icon: Download,
        },
        {
          href: "/settings/audit",
          title: "Audit log",
          description: "Who changed what and when, with old and new values.",
          icon: History,
        },
      ],
    },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Settings" description="Everything here changes how the CRM behaves, with no code change. Every save is logged." />
      <div className="flex flex-col gap-8">
        {sections.map((g) => (
          <section key={g.group} aria-labelledby={`group-${g.group}`}>
            <h2 id={`group-${g.group}`} className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
              {g.group}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {g.items.map((item) => {
                const Icon = item.icon;
                const changed = lastChange(item.keys);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="group flex h-full flex-col rounded-xl border border-border bg-surface p-4 transition-colors hover:border-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted" aria-hidden>
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1 font-semibold">{item.title}</span>
                        <ChevronRight className="h-4 w-4 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
                      </div>
                      <p className="mt-2 flex-1 text-sm text-muted">{item.description}</p>
                      {(item.meta || item.keys) && (
                        <p className="mt-3 text-xs text-muted">
                          {item.meta}
                          {item.meta && item.keys ? " · " : ""}
                          {item.keys ? (changed ? `changed ${formatRelative(changed, now)}` : "spec defaults") : ""}
                        </p>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

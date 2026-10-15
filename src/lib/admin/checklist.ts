/**
 * The admin's "Getting started" checklist (Today and Settings). PURE: the facts come from the database
 * (src/lib/admin/onboarding.ts), so every item ticks itself off from what has really been done, never from a flag.
 */
import { WEBHOOK_SOURCE_INFO, type WebhookSource } from "@/lib/webhooks/sources";

export type OnboardingFacts = {
  /** active people other than admins */
  teammates: number;
  /** active salespeople per team key */
  salesByTeam: Record<string, number>;
  /** the team keys that receive new leads (assignment.gccTeam / defaultTeam) */
  leadTeams: string[];
  teamLabels: Record<string, string>;
  /** the admin saved Teams and assignment at least once */
  assignmentSaved: boolean;
  /** a product was added or edited by someone (the starter prices are examples) */
  productsEdited: boolean;
  /** TagMango, Libromi or Pabbly delivered at least one webhook */
  webhookSources: string[];
  /** an import was committed */
  importsCommitted: number;
  /** the admin saved Currency at least once (the starter rates are examples) */
  currencySaved: boolean;
  /** enabled currencies other than INR */
  foreignCurrencies: string[];
};

export type ChecklistItem = {
  key: "team" | "prices" | "assignment" | "integrations" | "import" | "currency";
  title: string;
  /** what to do, or what was done */
  detail: string;
  href: string;
  action: string;
  done: boolean;
};

const sourceLabel = (s: string) => WEBHOOK_SOURCE_INFO[s as WebhookSource]?.label ?? s;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The checklist's one-line status, e.g. "3 of 6 done. Next: connect TagMango, Libromi and Pabbly." Only the first
 * letter of the next step is lowered, so product names keep their capitals.
 */
export function checklistSummary(items: Pick<ChecklistItem, "title" | "done">[]): string {
  const done = items.filter((i) => i.done).length;
  const next = items.find((i) => !i.done);
  const tail = next ? `Next: ${next.title.charAt(0).toLowerCase()}${next.title.slice(1)}.` : "All set.";
  return `${done} of ${items.length} done. ${tail}`;
}

export function buildChecklist(f: OnboardingFacts): ChecklistItem[] {
  const emptyLeadTeams = f.leadTeams.filter((t) => !(f.salesByTeam[t] > 0));
  const label = (t: string) => f.teamLabels[t] ?? t;
  const sellers = Object.values(f.salesByTeam).reduce((a, b) => a + b, 0);
  const sources = [...new Set(f.webhookSources.map(sourceLabel))];
  return [
    {
      key: "team",
      title: "Add your team",
      done: f.teammates > 0,
      detail:
        f.teammates > 0
          ? `${plural(f.teammates, "teammate")}, ${plural(sellers, "salesperson", "salespeople")}.`
          : "Add your salespeople, manager and support. Each gets a temporary password to sign in.",
      href: "/team/new",
      action: f.teammates > 0 ? "Add more" : "Add teammate",
    },
    {
      key: "prices",
      title: "Set your real product prices",
      done: f.productsEdited,
      detail: f.productsEdited
        ? "Products updated."
        : "The starter products carry example prices. Set real prices and each product's TagMango id.",
      href: "/settings/products",
      action: "Open products",
    },
    {
      key: "assignment",
      title: "Set teams and lead assignment",
      done: f.assignmentSaved || (f.leadTeams.length > 0 && emptyLeadTeams.length === 0),
      detail:
        emptyLeadTeams.length > 0
          ? `${emptyLeadTeams.map(label).join(" and ")} ${emptyLeadTeams.length === 1 ? "has" : "have"} no salesperson yet, so ${emptyLeadTeams.length === 1 ? "its" : "their"} new leads wait in the pool.`
          : "New leads go round robin to each team's salespeople.",
      href: "/settings/teams-assignment",
      action: "Open teams",
    },
    {
      key: "integrations",
      title: "Connect TagMango, Libromi and Pabbly",
      done: sources.length > 0,
      detail: sources.length
        ? `Receiving from ${sources.join(", ")}.`
        : "Paste the webhook addresses into TagMango, Libromi and Pabbly so purchases and leads arrive by themselves.",
      href: "/settings/integrations",
      action: "Open integrations",
    },
    {
      key: "import",
      title: "Import your old data",
      done: f.importsCommitted > 0,
      detail:
        f.importsCommitted > 0
          ? `${plural(f.importsCommitted, "import")} done.`
          : "Bring in TagMango history, Zoho exports and sheets. Duplicates are matched by phone.",
      href: "/import",
      action: "Start an import",
    },
    {
      key: "currency",
      title: "Set currency rates",
      done: f.currencySaved || f.foreignCurrencies.length === 0,
      detail: f.currencySaved
        ? "Rates confirmed."
        : `${f.foreignCurrencies.join(" and ")} still use example rates. Enter this month's rupee rate.`,
      href: "/settings/currency",
      action: "Open currency",
    },
  ];
}

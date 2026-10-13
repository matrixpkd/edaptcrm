import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/card";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { channelUsage, listAssignableUsers } from "@/lib/contacts/queries";
import { builtInCities } from "@/lib/contacts/places";
import { isManualChannel, placeSuggestionList } from "@/lib/contacts/rules";
import { activeItems, getSettings, type ListItem } from "@/lib/settings";
import { QuickAddForm } from "./quick-add-form";

export const metadata = { title: "Quick Add" };

/** How many channels get one-tap chips; the rest sit in a select. */
const CHIP_COUNT = 4;
/**
 * The spec's manual-entry channels (Capture: "Manual: Quick Add") break ties while the team has little history.
 * Keys that are not in the settings list are ignored, so renaming a channel in Settings never breaks this.
 */
const MANUAL_CHANNEL_HINTS = ["whatsapp_app", "phone_call", "walk_in_event"];

/** Settings channels ranked by how often the team enters them by hand, then the manual-entry hints, then list order. */
function rankChannels(channels: ListItem[], usage: string[]): { common: ListItem[]; other: ListItem[] } {
  const rank = (key: string, index: number) => {
    const u = usage.indexOf(key);
    if (u >= 0) return u;
    const h = MANUAL_CHANNEL_HINTS.indexOf(key);
    if (h >= 0) return 100 + h;
    return 1000 + index;
  };
  const ranked = channels.map((c, i) => ({ c, r: rank(c.key, i) })).sort((a, b) => a.r - b.r);
  const common = ranked.slice(0, CHIP_COUNT).map((x) => x.c);
  const commonKeys = new Set(common.map((c) => c.key));
  return { common, other: channels.filter((c) => !commonKeys.has(c.key)) };
}

export default async function QuickAddPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (!can(user, "contacts.create")) redirect("/today?denied=1");
  const sp = await searchParams;
  const defaultPhone = typeof sp.phone === "string" ? sp.phone.slice(0, 40) : undefined;

  const isManager = user.role === "manager" || user.role === "admin";
  const [lists, usage, owners] = await Promise.all([
    getSettings(["lists.channels", "lists.firstDoors", "lists.campaigns", "lists.languages", "lists.tags", "locations"]),
    channelUsage(),
    isManager ? listAssignableUsers() : Promise.resolve([]),
  ]);
  // TagMango checkouts and imports are recorded by the system only, never typed in
  const { common, other } = rankChannels(
    activeItems(lists["lists.channels"]).filter((c) => isManualChannel(c.key)),
    usage,
  );
  const opt = (items: ListItem[]) => activeItems(items).map((i) => ({ value: i.key, label: i.label }));

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        title="Quick Add"
        description={
          <>
            Phone first. Four fields and it is saved.{" "}
            {user.role === "support" && "New leads are assigned to the right salesperson automatically."}
          </>
        }
        back={
          <Link href="/contacts" className="hover:underline">
            ← Contacts
          </Link>
        }
      />
      <div className="rounded-2xl border border-border bg-surface p-4 sm:p-6">
        <QuickAddForm
          commonChannels={common.map((c) => ({ value: c.key, label: c.label }))}
          otherChannels={other.map((c) => ({ value: c.key, label: c.label }))}
          firstDoors={opt(lists["lists.firstDoors"])}
          campaigns={opt(lists["lists.campaigns"])}
          languages={opt(lists["lists.languages"])}
          tags={opt(lists["lists.tags"])}
          owners={
            isManager ? owners.filter((o) => o.id !== user.id).map((o) => ({ value: o.id, label: o.name })) : null
          }
          canRequestTransfer={can(user, "contacts.requestTransfer")}
          defaultPhone={defaultPhone}
          cities={placeSuggestionList(builtInCities(lists.locations), [])}
        />
      </div>
    </div>
  );
}

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Tabs } from "@/components/ui/tabs";
import { listUsage } from "@/lib/admin/lists";
import { LIST_META, listMetaBySlug } from "@/lib/admin/meta";
import { requireUser } from "@/lib/auth/session";
import { getSettings, type ListItem } from "@/lib/settings";
import { SettingsHeader } from "../_components/settings-header";
import { ListEditor, type UsageView } from "./list-editor";

export const metadata = { title: "Dropdown lists" };

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

export default async function ListsPage({ searchParams }: { searchParams: Promise<{ list?: string }> }) {
  await requireUser(["admin"]);
  const sp = await searchParams;
  const meta = listMetaBySlug(sp.list) ?? LIST_META[0];
  const [all, usage] = await Promise.all([getSettings(LIST_META.map((m) => m.key)), listUsage(meta.key)]);
  const items = all[meta.key] as ListItem[];
  const usageView: Record<string, UsageView> = {};
  for (const [key, u] of usage) {
    const parts = [
      u.contacts ? plural(u.contacts, "contact") : null,
      u.enquiries ? plural(u.enquiries, "enquiry", "enquiries") : null,
      u.interactions ? plural(u.interactions, "interaction") : null,
      u.purchases ? plural(u.purchases, "purchase") : null,
      u.rules ? plural(u.rules, "offer rule") : null,
      u.mappings ? plural(u.mappings, "capture mapping") : null,
    ].filter(Boolean);
    usageView[key] = { total: u.total, text: parts.join(" · ") };
  }
  const unknown = [...usage.keys()].filter((k) => !items.some((i) => i.key === k));

  return (
    <div className="mx-auto max-w-4xl">
      <SettingsHeader
        title="Dropdown lists"
        description="Records store the key, so renaming a label changes it everywhere at once. Items in use can be switched off but never removed."
      />
      <Tabs
        className="mb-4"
        active={meta.slug}
        tabs={LIST_META.map((m) => ({
          key: m.slug,
          label: m.title,
          href: `/settings/lists?list=${m.slug}`,
          count: (all[m.key] as ListItem[]).filter((i) => i.active !== false).length,
        }))}
      />
      <Card>
        <CardHeader title={meta.title} description={`${meta.description} Usage counts ${meta.usageLabel}.`} />
        <CardBody>
          <ListEditor
            key={meta.key}
            listKey={meta.key}
            title={meta.title}
            initial={items}
            usage={usageView}
            systemKeys={meta.systemKeys}
            keyIsLabel={meta.keyIsLabel}
          />
          {unknown.length > 0 && (
            <p className="mt-4 text-xs text-muted">
              Also found in records but not in this list (shown as the raw key):{" "}
              {unknown
                .slice(0, 12)
                .map((k) => `${k} (${usage.get(k)!.total})`)
                .join(", ")}
              {unknown.length > 12 ? ", …" : ""}. Add an item with the same key to give it a name.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

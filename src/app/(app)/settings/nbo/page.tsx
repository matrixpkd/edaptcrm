import Form from "next/form";
import Link from "next/link";
import { Search } from "lucide-react";
import { GradeBadge } from "@/components/ui/badge";
import { Input } from "@/components/ui/form";
import { nboFactsForContact, nboProducts } from "@/lib/admin/nbo";
import { requireUser } from "@/lib/auth/session";
import { searchContactsForPicker } from "@/lib/contacts/queries";
import { formatPhone } from "@/lib/phone";
import { getSettings } from "@/lib/settings";
import { SettingsHeader } from "../_components/settings-header";
import { NboEditor } from "./nbo-editor";

export const metadata = { title: "Next best offer" };

export default async function NboPage({ searchParams }: { searchParams: Promise<{ q?: string; test?: string }> }) {
  const user = await requireUser(["admin"]);
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 100);
  const [s, products, tester, results] = await Promise.all([
    getSettings(["nbo.rules", "lists.firstDoors", "lists.tags", "lists.industries", "ladder.families", "ladder.rungs", "currency", "assignment"]),
    nboProducts(),
    sp.test ? nboFactsForContact(sp.test) : Promise.resolve(null),
    q ? searchContactsForPicker(user, q, { limit: 6 }) : Promise.resolve([]),
  ]);

  const search = (
    <div className="flex flex-col gap-2">
      <Form action="/settings/nbo" scroll={false} role="search" className="flex gap-2">
        {sp.test && <input type="hidden" name="test" value={sp.test} />}
        <label htmlFor="tester-q" className="sr-only">
          Find a contact
        </label>
        <Input id="tester-q" name="q" defaultValue={q} placeholder="Name, phone or email" autoComplete="off" />
        <button
          type="submit"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Search contacts"
        >
          <Search className="h-4 w-4" aria-hidden />
        </button>
      </Form>
      {q && results.length === 0 && <p className="text-xs text-muted">No contact matches &ldquo;{q}&rdquo;.</p>}
      {results.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {results.map((c) => (
            <li key={c.id}>
              <Link
                href={`/settings/nbo?test=${c.id}`}
                scroll={false}
                aria-current={tester?.id === c.id ? "true" : undefined}
                className="flex items-center gap-2 px-2.5 py-2 text-sm hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <GradeBadge grade={c.grade} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{c.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {formatPhone(c.phoneE164)} · {c.purchaseCount} purchase{c.purchaseCount === 1 ? "" : "s"}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {sp.test && !tester && <p className="text-xs text-danger">That contact no longer exists (it may have been merged).</p>}
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl">
      <SettingsHeader
        title="Next best offer"
        description="Where each customer is on the ladder decides the offer on their contact page and Today row, and the price behind the 90-day forecast."
      />
      <NboEditor
        initial={s["nbo.rules"]}
        tester={tester}
        testerSearch={search}
        options={{
          firstDoors: s["lists.firstDoors"],
          tags: s["lists.tags"],
          industries: s["lists.industries"],
          families: s["ladder.families"],
          rungs: s["ladder.rungs"],
          products,
          currency: s.currency,
          gccCountries: s.assignment.gccCountries,
        }}
      />
    </div>
  );
}

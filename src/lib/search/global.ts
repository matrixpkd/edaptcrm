import "server-only";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { contacts, organisations, users, type Role } from "@/db/schema";
import { contactScope } from "@/lib/auth/scope";
import { contactSearchCondition } from "@/lib/contacts/queries";
import { navFor } from "@/components/shell/nav";
import { formatPhone } from "@/lib/phone";

/**
 * Global search (the sidebar box, the phone top bar and Ctrl/Cmd+K; beyond the spec). Contacts by name, email or
 * phone in any format (the Contacts list's own search condition, inside contactScope, so a salesperson only finds
 * their own contacts and the pool), organisations by name or city, and the screens the person can open.
 */

export type SearchHit =
  | { kind: "contact"; id: string; href: string; title: string; subtitle: string; grade: "A" | "B" | "C" | "D" | null }
  | { kind: "organisation"; id: string; href: string; title: string; subtitle: string }
  | { kind: "page"; id: string; href: string; title: string; subtitle: string };

export const SEARCH_MIN = 2;
export const SEARCH_MAX = 100;

const ORG_KIND_LABELS: Record<string, string> = {
  school: "School",
  constituency_office: "Constituency office",
  company: "Company",
  partner: "Partner",
};

const STAGE_LABELS: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  first_purchase: "First purchase",
  repeat: "Repeat",
  advocate: "Advocate",
  dormant: "Dormant",
  lost: "Lost",
};

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export async function globalSearch(
  viewer: { id: string; role: Role },
  raw: string,
  opts: { limit?: number; kinds?: ("contact" | "organisation" | "page")[]; tx?: Tx } = {},
): Promise<SearchHit[]> {
  const q = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX);
  if (q.length < SEARCH_MIN) return [];
  const tx = opts.tx ?? db;
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20);
  const kinds = new Set(opts.kinds ?? ["contact", "organisation", "page"]);
  const cond = contactSearchCondition(q);
  const like = `%${escapeLike(q.toLowerCase())}%`;

  const [people, orgs] = await Promise.all([
    kinds.has("contact") && cond
      ? tx
          .select({
            id: contacts.id,
            name: contacts.name,
            phoneE164: contacts.phoneE164,
            email: contacts.email,
            stage: contacts.stage,
            grade: contacts.grade,
            ownerName: users.name,
          })
          .from(contacts)
          .leftJoin(users, eq(users.id, contacts.ownerId))
          .where(and(contactScope(viewer), cond))
          // exact-looking matches first: the name starts with the query, then score
          .orderBy(
            sql`case when lower(${contacts.name}) like ${`${escapeLike(q.toLowerCase())}%`} then 0 else 1 end`,
            sql`${contacts.edaptScore} desc nulls last`,
            asc(contacts.name),
          )
          .limit(limit)
      : Promise.resolve([]),
    kinds.has("organisation")
      ? tx
          .select({ id: organisations.id, name: organisations.name, kind: organisations.kind, city: organisations.city })
          .from(organisations)
          .where(or(sql`lower(${organisations.name}) like ${like}`, sql`lower(coalesce(${organisations.city}, '')) like ${like}`))
          .orderBy(sql`lower(${organisations.name})`)
          .limit(Math.min(5, limit))
      : Promise.resolve([]),
  ]);

  const hits: SearchHit[] = people.map((p) => ({
    kind: "contact",
    id: p.id,
    href: `/contacts/${p.id}`,
    title: p.name,
    subtitle: [formatPhone(p.phoneE164), p.email, STAGE_LABELS[p.stage] ?? p.stage, p.ownerName ?? "Pool"].filter(Boolean).join(" · "),
    grade: p.grade,
  }));
  for (const o of orgs) {
    hits.push({
      kind: "organisation",
      id: o.id,
      href: `/organisations/${o.id}`,
      title: o.name,
      subtitle: [ORG_KIND_LABELS[o.kind] ?? o.kind, o.city].filter(Boolean).join(" · "),
    });
  }
  if (kinds.has("page")) {
    const lower = q.toLowerCase();
    for (const item of [...navFor(viewer.role), ...EXTRA_PAGES.filter((p) => p.roles.includes(viewer.role))]) {
      if (item.label.toLowerCase().includes(lower)) {
        hits.push({ kind: "page", id: item.href, href: item.href, title: item.label, subtitle: "Screen" });
      }
    }
  }
  return hits;
}

/** Screens reachable from the search that are not in the main menu. */
const EXTRA_PAGES: { href: string; label: string; roles: Role[] }[] = [
  { href: "/account", label: "Your account", roles: ["admin", "manager", "sales", "support"] },
  { href: "/notifications", label: "Alerts", roles: ["admin", "manager", "sales", "support"] },
  { href: "/tasks/new", label: "New task", roles: ["admin", "manager", "sales", "support"] },
  { href: "/settings/templates", label: "Message templates", roles: ["admin"] },
  { href: "/settings/products", label: "Products", roles: ["admin"] },
  { href: "/settings/audit", label: "Audit log", roles: ["admin"] },
];

import "server-only";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, queryRows, type Tx } from "@/db";
import {
  STAGES,
  contactMerges,
  contacts,
  duplicateReviews,
  enquiries,
  interactions,
  organisations,
  payments,
  products,
  purchases,
  ratings,
  savedViews,
  users,
  type Contact,
  type InteractionType,
  type OrgKind,
  type PaymentKind,
  type PaymentMode,
  type PaymentStatus,
  type PurchaseSource,
  type PurchaseStatus,
  type RatingSource,
  type Role,
  type Stage,
} from "@/db/schema";
import { can, canViewContact } from "@/lib/auth/permissions";
import { contactScope } from "@/lib/auth/scope";
import { normalizePhone } from "@/lib/phone";
import { getSetting } from "@/lib/settings";
import { ContactForbiddenError, ContactValidationError } from "./errors";
import { assigneeLabel, cleanText, isUuid } from "./rules";
import { unratedCondition } from "./unrated";

/**
 * Read models for the contact screens: the Contacts list (filters, search, sort, pagination, saved views),
 * the contact page (header, timeline, ratings, referrals, merge history), duplicates and organisations.
 * Every list or search of contacts goes through contactScope(user), which also hides merged rows.
 * Nothing here writes calculated columns; the only writes are saved views (a per-user preference).
 */

type Viewer = { id: string; role: Role };

/**
 * Shown instead of the name of a contact the viewer may not open (a salesperson looking at a colleague's
 * contact): names and phones of other people's contacts are never revealed, but their money still counts.
 */
export const HIDDEN_CONTACT_LABEL = "Another salesperson's contact";

// ---------------------------------------------------------------------------
// Contacts list: filters in the URL
// ---------------------------------------------------------------------------

export const CONTACTS_PAGE_SIZE = 50;

export const CONTACT_SORTS = ["score", "ltv", "activity", "created", "name"] as const;
export type ContactSort = (typeof CONTACT_SORTS)[number];
export const DEFAULT_CONTACT_SORT: ContactSort = "score";

export const GRADES = ["A", "B", "C", "D"] as const;
export type Grade = (typeof GRADES)[number];

export type ContactFilters = {
  /** name, phone (any written form, partial digits) or email */
  q?: string | null;
  grades?: Grade[];
  stages?: Stage[];
  firstDoor?: string | null;
  campaign?: string | null;
  channel?: string | null;
  /** "mine", "pool" (no owner) or a user id */
  owner?: string | null;
  /** product family bought (a paid or part-paid purchase) */
  family?: string | null;
  /** one catalogue product bought (a paid or part-paid purchase of that product id) */
  product?: string | null;
  /** ISO 3166-1 alpha-2 */
  country?: string | null;
  language?: string | null;
  tag?: string | null;
  atRisk?: boolean;
  /** no salesperson has rated them yet */
  unrated?: boolean;
  sort?: ContactSort;
};

/** URL parameter names, in the canonical order used for saved views and shareable links. */
export const FILTER_PARAMS = [
  "q",
  "grade",
  "stage",
  "door",
  "campaign",
  "channel",
  "owner",
  "family",
  "product",
  "country",
  "lang",
  "tag",
  "risk",
  "unrated",
  "sort",
] as const;

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function paramAll(sp: ParamSource, key: string): string[] {
  if (sp instanceof URLSearchParams) return sp.getAll(key);
  const v = sp[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function paramOne(sp: ParamSource, key: string, max = 120): string | null {
  const v = paramAll(sp, key)
    .map((s) => s.trim())
    .find(Boolean);
  return v ? v.slice(0, max) : null;
}

function paramFlag(sp: ParamSource, key: string): boolean {
  const v = paramOne(sp, key);
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

function paramList(sp: ParamSource, key: string): string[] {
  return paramAll(sp, key)
    .flatMap((v) => v.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Reads the Contacts list filters from the URL. Unknown or malformed values are dropped, never guessed. */
export function parseContactFilters(sp: ParamSource): ContactFilters {
  const grades = [...new Set(paramList(sp, "grade").map((g) => g.toUpperCase()))].filter((g): g is Grade =>
    (GRADES as readonly string[]).includes(g),
  );
  const stages = [...new Set(paramList(sp, "stage"))].filter((s): s is Stage =>
    (STAGES as readonly string[]).includes(s),
  );
  const ownerRaw = paramOne(sp, "owner");
  const owner = ownerRaw === "mine" || ownerRaw === "pool" || isUuid(ownerRaw) ? ownerRaw : null;
  const countryRaw = paramOne(sp, "country")?.toUpperCase() ?? null;
  const sortRaw = paramOne(sp, "sort");
  const sort = (CONTACT_SORTS as readonly string[]).includes(sortRaw ?? "")
    ? (sortRaw as ContactSort)
    : DEFAULT_CONTACT_SORT;
  return {
    q: paramOne(sp, "q", 100),
    grades,
    stages,
    firstDoor: paramOne(sp, "door"),
    campaign: paramOne(sp, "campaign"),
    channel: paramOne(sp, "channel"),
    owner,
    family: paramOne(sp, "family"),
    product: isUuid(paramOne(sp, "product")) ? paramOne(sp, "product") : null,
    country: countryRaw && /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : null,
    language: paramOne(sp, "lang"),
    tag: paramOne(sp, "tag"),
    atRisk: paramFlag(sp, "risk"),
    unrated: paramFlag(sp, "unrated"),
    sort,
  };
}

/** The page number from the URL (1-based, at least 1). */
export function parsePage(sp: ParamSource): number {
  const n = Number.parseInt(paramOne(sp, "page") ?? "1", 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100_000) : 1;
}

/** Canonical query string for a set of filters (no page; the default sort is left out). */
export function filtersToQuery(f: ContactFilters): string {
  const p = new URLSearchParams();
  if (f.q?.trim()) p.set("q", f.q.trim());
  for (const g of f.grades ?? []) p.append("grade", g);
  for (const s of f.stages ?? []) p.append("stage", s);
  if (f.firstDoor) p.set("door", f.firstDoor);
  if (f.campaign) p.set("campaign", f.campaign);
  if (f.channel) p.set("channel", f.channel);
  if (f.owner) p.set("owner", f.owner);
  if (f.family) p.set("family", f.family);
  if (f.product) p.set("product", f.product);
  if (f.country) p.set("country", f.country);
  if (f.language) p.set("lang", f.language);
  if (f.tag) p.set("tag", f.tag);
  if (f.atRisk) p.set("risk", "1");
  if (f.unrated) p.set("unrated", "1");
  if (f.sort && f.sort !== DEFAULT_CONTACT_SORT) p.set("sort", f.sort);
  return p.toString();
}

/** How many filters are switched on (search and sort not counted). */
export function activeFilterCount(f: ContactFilters): number {
  return (
    (f.grades?.length ? 1 : 0) +
    (f.stages?.length ? 1 : 0) +
    [f.firstDoor, f.campaign, f.channel, f.owner, f.family, f.product, f.country, f.language, f.tag].filter(Boolean).length +
    (f.atRisk ? 1 : 0) +
    (f.unrated ? 1 : 0)
  );
}

/**
 * Outer-row references for correlated subqueries. Drizzle leaves column names unqualified when a query reads a
 * single table, which would bind them to the subquery's own table, so these are always written in full.
 */
const CONTACT_ID = sql.raw(`"contacts"."id"`);
const ORG_ID = sql.raw(`"organisations"."id"`);
const PURCHASE_ID = sql.raw(`"purchases"."id"`);

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Search by name, email or phone. A phone may be typed in any form (05X UAE numbers, +91, 0091, spaces) and is
 * normalised for an exact match; three or more digits also match anywhere in a primary or alternate number.
 */
export function contactSearchCondition(raw: string | null | undefined): SQL | undefined {
  const text = cleanText(raw);
  if (!text) return undefined;
  const lower = text.toLowerCase();
  const like = `%${escapeLike(lower)}%`;
  const conds: SQL[] = [
    sql`lower(${contacts.name}) like ${like}`,
    sql`lower(coalesce(${contacts.email}, '')) like ${like}`,
  ];
  // the cardinality() guards match the partial indexes contacts_has_alt_*_idx, so every arm of the OR can use an
  // index (with the trigram indexes on name, email and phone) and the search never scans the whole table
  if (lower.includes("@")) {
    conds.push(
      sql`(cardinality(${contacts.altEmails}) > 0 and exists (select 1 from unnest(${contacts.altEmails}) as ae(v) where ae.v like ${like}))`,
    );
  }
  const digits = text.replace(/\D/g, "");
  const phoneLike = /^[\d\s()+\-./]+$/.test(text);
  if (phoneLike && digits.length >= 3) {
    const np = normalizePhone(text);
    if (np) {
      conds.push(eq(contacts.phoneE164, np.e164), sql`${contacts.altPhones} @> array[${np.e164}]::text[]`);
    }
    // a leading 0 or 00 is a trunk/international prefix, never part of the stored E.164 digits
    const partial = digits.replace(/^0+/, "");
    if (partial.length >= 3) {
      const pl = `%${partial}%`;
      conds.push(
        sql`${contacts.phoneE164} like ${pl}`,
        sql`(cardinality(${contacts.altPhones}) > 0 and array_to_string(${contacts.altPhones}, ' ') like ${pl})`,
      );
    }
  }
  return or(...conds);
}

/** "Unrated": no rating of any kind (see src/lib/contacts/unrated.ts, shared with the dashboard). */
export { unratedCondition } from "./unrated";

/** The full WHERE for the Contacts list: the viewer's scope (always) plus every filter. */
export function contactListWhere(user: Viewer, f: ContactFilters): SQL {
  const conds: (SQL | undefined)[] = [contactScope(user)];
  conds.push(contactSearchCondition(f.q));
  if (f.grades?.length) conds.push(inArray(contacts.grade, f.grades));
  if (f.stages?.length) conds.push(inArray(contacts.stage, f.stages));
  if (f.firstDoor) conds.push(eq(contacts.firstDoor, f.firstDoor));
  if (f.campaign) {
    conds.push(
      or(
        eq(contacts.firstCampaign, f.campaign),
        // IN, not a correlated EXISTS inside the OR: the planner costs that OR at ~800k, which switches on JIT
        // compilation (~0.5 s per query) for a scan that takes 40 ms (docs/PERFORMANCE.md)
        sql`${CONTACT_ID} in (select e.contact_id from enquiries e where e.campaign = ${f.campaign})`,
      ),
    );
  }
  if (f.channel) {
    conds.push(sql`exists (select 1 from enquiries e where e.contact_id = ${CONTACT_ID} and e.channel = ${f.channel})`);
  }
  if (f.owner === "mine") conds.push(eq(contacts.ownerId, user.id));
  else if (f.owner === "pool") conds.push(isNull(contacts.ownerId));
  else if (f.owner && isUuid(f.owner)) conds.push(eq(contacts.ownerId, f.owner));
  if (f.family) conds.push(sql`${contacts.families} @> array[${f.family}]::text[]`);
  if (f.product && isUuid(f.product)) {
    // same shape as the campaign filter: an IN over the purchases of that product (paid or part-paid), never a
    // correlated EXISTS per contact
    conds.push(
      sql`${CONTACT_ID} in (select pu.contact_id from purchases pu where pu.product_id = ${f.product}::uuid and pu.status in ('paid', 'partial'))`,
    );
  }
  if (f.country) conds.push(eq(contacts.country, f.country));
  if (f.language) conds.push(eq(contacts.language, f.language));
  if (f.tag) conds.push(sql`${contacts.tags} @> array[${f.tag}]::text[]`);
  if (f.atRisk) conds.push(eq(contacts.atRisk, true));
  if (f.unrated) conds.push(unratedCondition());
  return and(...conds)!;
}

function contactOrder(sort: ContactSort): SQL[] {
  switch (sort) {
    case "ltv":
      return [desc(contacts.ltvInr), sql`${contacts.edaptScore} desc nulls last`, asc(contacts.id)];
    case "activity":
      return [sql`${contacts.lastActivityAt} desc nulls last`, desc(contacts.createdAt), asc(contacts.id)];
    case "created":
      return [desc(contacts.createdAt), asc(contacts.id)];
    case "name":
      return [sql`lower(${contacts.name}) asc`, asc(contacts.id)];
    case "score":
    default:
      return [
        sql`${contacts.edaptScore} desc nulls last`,
        desc(contacts.ltvInr),
        desc(contacts.createdAt),
        asc(contacts.id),
      ];
  }
}

export type ContactListRow = {
  id: string;
  name: string;
  phoneE164: string;
  email: string | null;
  grade: Grade | null;
  edaptScore: number | null;
  stage: Stage;
  ownerId: string | null;
  ownerName: string | null;
  ltvInr: number;
  purchaseCount: number;
  nextOffer: string | null;
  atRisk: boolean;
  lastActivityAt: Date | null;
  createdAt: Date;
  firstDoor: string;
  tags: string[];
};

export type ContactListResult = {
  rows: ContactListRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

/** One page of the Contacts list, with the total count. Always scoped to what the viewer may see. */
export async function listContacts(
  user: Viewer,
  filters: ContactFilters,
  opts: { page?: number; pageSize?: number; tx?: Tx } = {},
): Promise<ContactListResult> {
  const tx = opts.tx ?? db;
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? CONTACTS_PAGE_SIZE, 200));
  const where = contactListWhere(user, filters);
  const [{ total }] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(contacts)
    .where(where);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, opts.page ?? 1), pageCount);
  const rows = total
    ? await tx
        .select({
          id: contacts.id,
          name: contacts.name,
          phoneE164: contacts.phoneE164,
          email: contacts.email,
          grade: contacts.grade,
          edaptScore: contacts.edaptScore,
          stage: contacts.stage,
          ownerId: contacts.ownerId,
          ownerName: users.name,
          ltvInr: contacts.ltvInr,
          purchaseCount: contacts.purchaseCount,
          nextOffer: contacts.nextOffer,
          atRisk: contacts.atRisk,
          lastActivityAt: contacts.lastActivityAt,
          createdAt: contacts.createdAt,
          firstDoor: contacts.firstDoor,
          tags: contacts.tags,
        })
        .from(contacts)
        .leftJoin(users, eq(users.id, contacts.ownerId))
        .where(where)
        .orderBy(...contactOrder(filters.sort ?? DEFAULT_CONTACT_SORT))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
    : [];
  return { rows: rows as ContactListRow[], total, page, pageSize, pageCount };
}

/** Live contacts with no owner that the viewer can see: the "Pool" chip's count on the Contacts list. */
export async function countPoolContacts(user: Viewer, tx: Tx = db): Promise<number> {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(contactListWhere(user, { owner: "pool" }));
  return n;
}

/** Countries present among the contacts the viewer can see, most common first (for the country filter). */
export async function listContactCountries(user: Viewer, tx: Tx = db): Promise<{ country: string; n: number }[]> {
  const rows = await tx
    .select({ country: contacts.country, n: sql<number>`count(*)::int` })
    .from(contacts)
    .where(and(contactScope(user), sql`${contacts.country} is not null`))
    .groupBy(contacts.country)
    .orderBy(sql`count(*) desc`, asc(contacts.country))
    .limit(80);
  return rows.filter((r): r is { country: string; n: number } => !!r.country);
}

/**
 * Catalogue products for the "Product" filter: active ones first, then by name. An inactive product stays listed
 * (people bought it); `selected` keeps a filtered product in the list even if it was deleted.
 */
export async function listProductOptions(tx: Tx = db): Promise<{ value: string; label: string }[]> {
  const rows = await tx
    .select({ id: products.id, name: products.name, active: products.active })
    .from(products)
    .orderBy(desc(products.active), sql`lower(${products.name})`, asc(products.id))
    .limit(500);
  return rows.map((p) => ({ value: p.id, label: p.active ? p.name : `${p.name} (inactive)` }));
}

// ---------------------------------------------------------------------------
// Team members (owner filters and pickers)
// ---------------------------------------------------------------------------

export type TeamMember = { id: string; name: string; role: Role; team: string | null; active: boolean };

/** Everyone who can own contacts (sales, manager, admin), active first. Inactive owners stay listed for filters. */
export async function listOwnerOptions(tx: Tx = db): Promise<TeamMember[]> {
  return tx
    .select({ id: users.id, name: users.name, role: users.role, team: users.team, active: users.active })
    .from(users)
    .where(ne(users.role, "support"))
    .orderBy(desc(users.active), asc(users.name));
}

/**
 * Everyone a manager may hand a contact to: active salespeople first, then managers and admins (an admin who sells,
 * such as the founder on a small team, can own contacts too). Support never owns.
 */
export async function listAssignableUsers(tx: Tx = db): Promise<TeamMember[]> {
  return tx
    .select({ id: users.id, name: users.name, role: users.role, team: users.team, active: users.active })
    .from(users)
    .where(and(eq(users.active, true), inArray(users.role, ["sales", "manager", "admin"])))
    .orderBy(sql`case ${users.role} when 'sales' then 0 when 'manager' then 1 else 2 end`, asc(users.name));
}

export type AssigneeOption = { value: string; label: string; role: Role };

/** listAssignableUsers as picker options: "Kiran (Sales, Kerala)", team names from settings. */
export async function assigneeOptions(tx: Tx = db): Promise<AssigneeOption[]> {
  const [people, teams] = await Promise.all([listAssignableUsers(tx), getSetting("teams", tx)]);
  const teamLabel = (k: string) => teams.find((t) => t.key === k)?.label ?? k;
  return people.map((p) => ({ value: p.id, label: assigneeLabel(p, teamLabel), role: p.role }));
}

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

export type SavedView = {
  id: string;
  name: string;
  query: string;
  shared: boolean;
  mine: boolean;
  ownerName: string | null;
};

/** The viewer's own views plus every shared view, own first, then by name. */
export async function listSavedViews(user: Viewer, tx: Tx = db): Promise<SavedView[]> {
  const rows = await tx
    .select({
      id: savedViews.id,
      name: savedViews.name,
      query: savedViews.query,
      shared: savedViews.shared,
      userId: savedViews.userId,
      ownerName: users.name,
    })
    .from(savedViews)
    .leftJoin(users, eq(users.id, savedViews.userId))
    .where(or(eq(savedViews.userId, user.id), eq(savedViews.shared, true)))
    .orderBy(sql`(${savedViews.userId} = ${user.id}) desc`, sql`lower(${savedViews.name})`)
    .limit(100);
  return rows.map(({ userId, ...r }) => ({ ...r, mine: userId === user.id }));
}

/** Only managers and admins publish views to everyone. */
export function canShareViews(user: { role: Role }): boolean {
  return user.role === "admin" || user.role === "manager";
}

/**
 * Saves the current list query under a name. The query is cleaned to known filters (never a page number).
 * Saving again under a name the viewer already uses replaces that view.
 */
export async function createSavedView(
  user: Viewer,
  input: { name: string; query: string; shared?: boolean },
  tx: Tx = db,
): Promise<string> {
  const name = cleanText(input.name);
  if (!name) throw new ContactValidationError("Give the view a name", "name");
  if (name.length > 60) throw new ContactValidationError("Keep the name under 60 characters", "name");
  if (input.shared && !canShareViews(user)) throw new ContactForbiddenError("Only a manager or admin can share views");
  const query = filtersToQuery(parseContactFilters(new URLSearchParams(input.query.replace(/^\?/, ""))));
  const shared = !!input.shared;
  const existing = await tx
    .select({ id: savedViews.id })
    .from(savedViews)
    .where(and(eq(savedViews.userId, user.id), sql`lower(${savedViews.name}) = ${name.toLowerCase()}`))
    .limit(1);
  if (existing[0]) {
    await tx.update(savedViews).set({ name, query, shared }).where(eq(savedViews.id, existing[0].id));
    return existing[0].id;
  }
  const [row] = await tx
    .insert(savedViews)
    .values({ userId: user.id, name, query, shared })
    .returning({ id: savedViews.id });
  return row.id;
}

/** Deletes a view the viewer owns (an admin may also remove a shared view). Returns false when nothing was removed. */
export async function deleteSavedView(user: Viewer, viewId: string, tx: Tx = db): Promise<boolean> {
  if (!isUuid(viewId)) return false;
  const mayDelete =
    user.role === "admin"
      ? or(eq(savedViews.userId, user.id), eq(savedViews.shared, true))
      : eq(savedViews.userId, user.id);
  const rows = await tx
    .delete(savedViews)
    .where(and(eq(savedViews.id, viewId), mayDelete))
    .returning({ id: savedViews.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Pickers (merge search, referred-by search)
// ---------------------------------------------------------------------------

export type ContactPick = {
  id: string;
  name: string;
  phoneE164: string;
  email: string | null;
  city: string | null;
  stage: Stage;
  grade: Grade | null;
  ownerName: string | null;
  purchaseCount: number;
  ltvInr: number;
  createdAt: Date;
};

/** A short scoped search for pickers (merge, referrer). */
export async function searchContactsForPicker(
  user: Viewer,
  q: string,
  opts: { excludeId?: string; limit?: number; tx?: Tx } = {},
): Promise<ContactPick[]> {
  const cond = contactSearchCondition(q);
  if (!cond) return [];
  const tx = opts.tx ?? db;
  const rows = await tx
    .select({
      id: contacts.id,
      name: contacts.name,
      phoneE164: contacts.phoneE164,
      email: contacts.email,
      city: contacts.city,
      stage: contacts.stage,
      grade: contacts.grade,
      ownerName: users.name,
      purchaseCount: contacts.purchaseCount,
      ltvInr: contacts.ltvInr,
      createdAt: contacts.createdAt,
    })
    .from(contacts)
    .leftJoin(users, eq(users.id, contacts.ownerId))
    .where(
      and(
        contactScope(user),
        cond,
        opts.excludeId && isUuid(opts.excludeId) ? ne(contacts.id, opts.excludeId) : undefined,
      ),
    )
    .orderBy(sql`${contacts.edaptScore} desc nulls last`, asc(contacts.name))
    .limit(Math.min(opts.limit ?? 10, 50));
  return rows as ContactPick[];
}

// ---------------------------------------------------------------------------
// Contact page
// ---------------------------------------------------------------------------

export type ContactHeader = Contact & {
  ownerName: string | null;
  ownerActive: boolean | null;
  firstOwnerName: string | null;
  createdByName: string | null;
  organisation: { id: string; name: string } | null;
  referrer: { id: string; name: string; ownerId: string | null } | null;
};

/** The contact row with the names the page shows. Merged rows are returned as they are (the page redirects). */
export async function getContactHeader(id: string, tx: Tx = db): Promise<ContactHeader | null> {
  if (!isUuid(id)) return null;
  const owner = alias(users, "owner");
  const firstOwner = alias(users, "first_owner");
  const creator = alias(users, "creator");
  const ref = alias(contacts, "referrer");
  const rows = await tx
    .select({
      contact: contacts,
      ownerName: owner.name,
      ownerActive: owner.active,
      firstOwnerName: firstOwner.name,
      createdByName: creator.name,
      orgId: organisations.id,
      orgName: organisations.name,
      refId: ref.id,
      refName: ref.name,
      refOwnerId: ref.ownerId,
    })
    .from(contacts)
    .leftJoin(owner, eq(owner.id, contacts.ownerId))
    .leftJoin(firstOwner, eq(firstOwner.id, contacts.firstOwnerId))
    .leftJoin(creator, eq(creator.id, contacts.createdById))
    .leftJoin(organisations, eq(organisations.id, contacts.organisationId))
    .leftJoin(ref, eq(ref.id, contacts.referredById))
    .where(eq(contacts.id, id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    ...r.contact,
    ownerName: r.ownerName,
    ownerActive: r.ownerActive,
    firstOwnerName: r.firstOwnerName,
    createdByName: r.createdByName,
    organisation: r.orgId && r.orgName ? { id: r.orgId, name: r.orgName } : null,
    referrer: r.refId && r.refName ? { id: r.refId, name: r.refName, ownerId: r.refOwnerId } : null,
  };
}

/** Counts shown on the contact page tabs and the merge confirmation. */
export type ContactFootprint = {
  enquiries: number;
  interactions: number;
  purchases: number;
  payments: number;
  ratings: number;
  referred: number;
};

export async function getContactFootprint(contactId: string, tx: Tx = db): Promise<ContactFootprint> {
  if (!isUuid(contactId)) return { enquiries: 0, interactions: 0, purchases: 0, payments: 0, ratings: 0, referred: 0 };
  const rows = await queryRows<ContactFootprint>(sql`
    select
      (select count(*)::int from ${enquiries} where contact_id = ${contactId}) as enquiries,
      (select count(*)::int from ${interactions} where contact_id = ${contactId}) as interactions,
      (select count(*)::int from ${purchases} where contact_id = ${contactId}) as purchases,
      (select count(*)::int from ${payments} where contact_id = ${contactId}) as payments,
      (select count(*)::int from ${ratings} where contact_id = ${contactId}) as ratings,
      (select count(*)::int from ${contacts} where referred_by_id = ${contactId} and merged_into_id is null) as referred
  `, tx);
  const r = rows[0];
  return {
    enquiries: Number(r?.enquiries ?? 0),
    interactions: Number(r?.interactions ?? 0),
    purchases: Number(r?.purchases ?? 0),
    payments: Number(r?.payments ?? 0),
    ratings: Number(r?.ratings ?? 0),
    referred: Number(r?.referred ?? 0),
  };
}

// --- timeline -------------------------------------------------------------

type TimelineBase = { id: string; at: Date; byName: string | null };

export type TimelineItem =
  | (TimelineBase & {
      kind: "enquiry";
      channel: string;
      campaign: string | null;
      status: string;
      notes: string | null;
      productInterest: string | null;
    })
  | (TimelineBase & {
      kind: "interaction";
      type: InteractionType;
      direction: string;
      outcome: string | null;
      summary: string | null;
      nextFollowUpAt: Date | null;
    })
  | (TimelineBase & {
      kind: "purchase";
      productName: string;
      family: string;
      amount: number;
      currency: string;
      amountInr: number;
      status: PurchaseStatus;
      mode: PaymentMode;
      reference: string | null;
      source: PurchaseSource;
      assisted: boolean;
    })
  | (TimelineBase & {
      kind: "payment";
      purchaseId: string;
      paymentKind: PaymentKind;
      seq: number;
      amount: number;
      currency: string;
      amountInr: number;
      status: PaymentStatus;
      mode: PaymentMode | null;
      reference: string | null;
      reason: string | null;
      productName: string;
      hasInstalments: boolean;
    })
  | (TimelineBase & {
      kind: "rating";
      source: RatingSource;
      aiLevel: number | null;
      umerLevel: number | null;
      spendingBand: number | null;
      gutStars: number | null;
      ageBand: string | null;
      industry: string | null;
      notes: string | null;
    })
  | (TimelineBase & { kind: "ownership"; fromName: string | null; toName: string | null; reason: string })
  | (TimelineBase & { kind: "stage"; field: "stage" | "lost_reason"; from: string | null; to: string | null })
  | (TimelineBase & { kind: "merge"; action: "merge" | "unmerge"; otherName: string | null; otherPhone: string | null })
  | (TimelineBase & { kind: "transfer"; reason: string | null });

export const TIMELINE_PAGE_SIZE = 30;

type RawTimelineRow = { kind: string; id: string; at: Date | string; data: Record<string, unknown> };

const asDate = (v: unknown): Date | null => (v === null || v === undefined || v === "" ? null : new Date(String(v)));
const asStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const asNum = (v: unknown): number => Number(v ?? 0);
const asInt = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toTimelineItem(r: RawTimelineRow): TimelineItem | null {
  const d = r.data ?? {};
  const base = { id: r.id, at: new Date(r.at), byName: asStr(d.byName) };
  switch (r.kind) {
    case "enquiry":
      return {
        ...base,
        kind: "enquiry",
        channel: String(d.channel ?? ""),
        campaign: asStr(d.campaign),
        status: String(d.status ?? "open"),
        notes: asStr(d.notes),
        productInterest: asStr(d.productInterest),
      };
    case "interaction":
      return {
        ...base,
        kind: "interaction",
        type: String(d.type) as InteractionType,
        direction: String(d.direction ?? "out"),
        outcome: asStr(d.outcome),
        summary: asStr(d.summary),
        nextFollowUpAt: asDate(d.nextFollowUpAt),
      };
    case "purchase":
      return {
        ...base,
        kind: "purchase",
        productName: String(d.productName ?? ""),
        family: String(d.family ?? ""),
        amount: asNum(d.amount),
        currency: String(d.currency ?? "INR"),
        amountInr: asNum(d.amountInr),
        status: String(d.status) as PurchaseStatus,
        mode: String(d.mode) as PaymentMode,
        reference: asStr(d.reference),
        source: String(d.source) as PurchaseSource,
        assisted: d.assisted === true,
      };
    case "payment":
      return {
        ...base,
        kind: "payment",
        purchaseId: String(d.purchaseId),
        paymentKind: String(d.paymentKind) as PaymentKind,
        seq: asNum(d.seq),
        amount: asNum(d.amount),
        currency: String(d.currency ?? "INR"),
        amountInr: asNum(d.amountInr),
        status: String(d.status) as PaymentStatus,
        mode: asStr(d.mode) as PaymentMode | null,
        reference: asStr(d.reference),
        reason: asStr(d.reason),
        productName: String(d.productName ?? ""),
        hasInstalments: d.hasInstalments === true,
      };
    case "rating":
      return {
        ...base,
        kind: "rating",
        source: String(d.source) as RatingSource,
        aiLevel: asInt(d.aiLevel),
        umerLevel: asInt(d.umerLevel),
        spendingBand: asInt(d.spendingBand),
        gutStars: asInt(d.gutStars),
        ageBand: asStr(d.ageBand),
        industry: asStr(d.industry),
        notes: asStr(d.notes),
      };
    case "ownership":
      return {
        ...base,
        kind: "ownership",
        fromName: asStr(d.fromName),
        toName: asStr(d.toName),
        reason: String(d.reason ?? ""),
      };
    case "audit": {
      const action = String(d.action ?? "");
      if (action === "merge" || action === "unmerge") {
        const other = (action === "merge" ? d.oldValue : d.newValue) as Record<string, unknown> | null;
        return {
          ...base,
          kind: "merge",
          action,
          otherName: asStr(other?.loserName ?? d.otherName),
          otherPhone: asStr(other?.loserPhone),
        };
      }
      if (action === "transfer_request") {
        const nv = (d.newValue ?? {}) as Record<string, unknown>;
        return { ...base, kind: "transfer", reason: asStr(nv.reason) };
      }
      const field = d.field === "lost_reason" ? "lost_reason" : "stage";
      return { ...base, kind: "stage", field, from: asStr(d.oldValue), to: asStr(d.newValue) };
    }
    default:
      return null;
  }
}

/**
 * Every touch on a contact, newest first: enquiries, interactions, purchases, payments and refunds (scheduled
 * instalments are not touches, and the single payment of a one-off purchase paid at once is folded into the
 * purchase), ratings, ownership changes, stage changes, merges and transfer requests.
 * History of records merged into this one is included.
 */
export async function getContactTimeline(
  contactId: string,
  opts: { page?: number; pageSize?: number; tx?: Tx } = {},
): Promise<{ items: TimelineItem[]; hasMore: boolean; page: number }> {
  const page = Math.max(1, opts.page ?? 1);
  if (!isUuid(contactId)) return { items: [], hasMore: false, page };
  const tx = opts.tx ?? db;
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? TIMELINE_PAGE_SIZE, 100));
  const id = contactId;
  const rows = await queryRows<RawTimelineRow>(sql`
    select kind, id, at, data from (
      select 'enquiry' as kind, e.id::text as id, e.received_at as at,
        jsonb_build_object('channel', e.channel, 'campaign', e.campaign, 'status', e.status, 'notes', e.notes,
          'productInterest', e.product_interest, 'byName', u.name) as data
      from enquiries e left join users u on u.id = e.created_by_id
      where e.contact_id = ${id}
      union all
      select 'interaction', i.id::text, i.occurred_at,
        jsonb_build_object('type', i.type, 'direction', i.direction, 'outcome', i.outcome, 'summary', i.summary,
          'nextFollowUpAt', i.next_follow_up_at, 'byName', u.name)
      from interactions i left join users u on u.id = i.user_id
      where i.contact_id = ${id}
      union all
      select 'purchase', p.id::text, p.purchased_at,
        jsonb_build_object('productName', p.product_name, 'family', p.family, 'amount', p.amount, 'currency', p.currency,
          'amountInr', p.amount_inr, 'status', p.status, 'mode', p.mode, 'reference', p.reference, 'source', p.source,
          'assisted', p.assisted, 'byName', u.name)
      from purchases p left join users u on u.id = p.credited_user_id
      where p.contact_id = ${id}
      union all
      select 'payment', pm.id::text, coalesce(pm.paid_at, pm.created_at),
        jsonb_build_object('purchaseId', pm.purchase_id, 'paymentKind', pm.kind, 'seq', pm.seq, 'amount', pm.amount,
          'currency', pm.currency, 'amountInr', pm.amount_inr, 'status', pm.status, 'mode', pm.mode,
          'reference', pm.reference, 'reason', pm.reason, 'productName', p.product_name,
          'hasInstalments', p.has_instalments, 'byName', u.name)
      from payments pm join purchases p on p.id = pm.purchase_id left join users u on u.id = pm.created_by_id
      where pm.contact_id = ${id} and pm.status <> 'scheduled'
        -- a one-off purchase paid in full at once (e.g. a TagMango order) is one touch: the purchase row says it
        and not (
          not p.has_instalments and pm.kind = 'payment' and pm.status in ('verified', 'unverified')
          and pm.amount = p.amount and pm.currency = p.currency
          and abs(extract(epoch from (coalesce(pm.paid_at, pm.created_at) - p.purchased_at))) < 86400
        )
      union all
      select 'rating', r.id::text, r.created_at,
        jsonb_build_object('source', r.source, 'aiLevel', r.ai_level, 'umerLevel', r.umer_level,
          'spendingBand', r.spending_band, 'gutStars', r.gut_stars, 'ageBand', r.age_band, 'industry', r.industry,
          'notes', r.notes, 'byName', u.name)
      from ratings r left join users u on u.id = r.rated_by_user_id
      where r.contact_id = ${id}
      union all
      select 'ownership', o.id::text, o.changed_at,
        jsonb_build_object('fromName', fu.name, 'toName', tu.name, 'reason', o.reason, 'byName', cu.name)
      from ownership_log o
        left join users fu on fu.id = o.from_user_id
        left join users tu on tu.id = o.to_user_id
        left join users cu on cu.id = o.changed_by_id
      where o.contact_id = ${id}
      union all
      select 'audit', a.id::text, a.changed_at,
        jsonb_build_object('action', a.action, 'field', a.field, 'oldValue', a.old_value, 'newValue', a.new_value,
          'byName', u.name)
      from audit_log a left join users u on u.id = a.user_id
      where a.table_name = 'contacts'
        and (a.row_id = ${id}::text
          or a.row_id in (select cm.loser_id::text from contact_merges cm where cm.winner_id = ${id} and cm.undone_at is null))
        and (a.field in ('stage', 'lost_reason') or a.action in ('merge', 'unmerge', 'transfer_request'))
    ) t
    order by at desc, kind asc, id desc
    limit ${pageSize + 1} offset ${(page - 1) * pageSize}
  `, tx);
  const items = rows
    .slice(0, pageSize)
    .map(toTimelineItem)
    .filter((x): x is TimelineItem => x !== null);
  return { items, hasMore: rows.length > pageSize, page };
}

// --- ratings, referrals, merges ------------------------------------------

export type RatingRow = {
  id: string;
  source: RatingSource;
  aiLevel: number | null;
  umerLevel: number | null;
  spendingBand: number | null;
  gutStars: number | null;
  ageBand: string | null;
  industry: string | null;
  notes: string | null;
  createdAt: Date;
  ratedByName: string | null;
};

/** Rating history, newest first, with who gave each rating. */
export async function getContactRatings(contactId: string, tx: Tx = db): Promise<RatingRow[]> {
  if (!isUuid(contactId)) return [];
  return tx
    .select({
      id: ratings.id,
      source: ratings.source,
      aiLevel: ratings.aiLevel,
      umerLevel: ratings.umerLevel,
      spendingBand: ratings.spendingBand,
      gutStars: ratings.gutStars,
      ageBand: ratings.ageBand,
      industry: ratings.industry,
      notes: ratings.notes,
      createdAt: ratings.createdAt,
      ratedByName: users.name,
    })
    .from(ratings)
    .leftJoin(users, eq(users.id, ratings.ratedByUserId))
    .where(eq(ratings.contactId, contactId))
    .orderBy(desc(ratings.createdAt), desc(ratings.id))
    .limit(200);
}

export type ReferralRow = {
  id: string;
  name: string;
  ownerId: string | null;
  ownerName: string | null;
  stage: Stage;
  grade: Grade | null;
  ltvInr: number;
  purchaseCount: number;
  createdAt: Date;
  /** true when the viewer may not open this contact: the name is HIDDEN_CONTACT_LABEL and the owner is left out */
  hidden: boolean;
};

/**
 * The people this contact brought in (live records), highest LTV first. With a viewer, contacts they may not
 * open keep their LTV but lose their name and owner (HIDDEN_CONTACT_LABEL).
 */
export async function getContactReferrals(contactId: string, viewer: Viewer | null = null, tx: Tx = db): Promise<ReferralRow[]> {
  if (!isUuid(contactId)) return [];
  const rows = await tx
    .select({
      id: contacts.id,
      name: contacts.name,
      ownerId: contacts.ownerId,
      ownerName: users.name,
      stage: contacts.stage,
      grade: contacts.grade,
      ltvInr: contacts.ltvInr,
      purchaseCount: contacts.purchaseCount,
      createdAt: contacts.createdAt,
    })
    .from(contacts)
    .leftJoin(users, eq(users.id, contacts.ownerId))
    .where(and(eq(contacts.referredById, contactId), isNull(contacts.mergedIntoId)))
    .orderBy(desc(contacts.ltvInr), desc(contacts.createdAt))
    .limit(500);
  return rows.map((r) =>
    viewer && !canViewContact(viewer, r)
      ? { ...r, name: HIDDEN_CONTACT_LABEL, ownerName: null, hidden: true }
      : { ...r, hidden: false },
  ) as ReferralRow[];
}

export type MergeHistoryRow = {
  id: string;
  role: "winner" | "loser";
  otherId: string;
  otherName: string;
  otherPhone: string;
  reason: string | null;
  mergedAt: Date;
  mergedByName: string | null;
  undoneAt: Date | null;
  undoneByName: string | null;
};

/** Merges this contact took part in, newest first, with names. */
export async function getMergeHistory(contactId: string, tx: Tx = db): Promise<MergeHistoryRow[]> {
  if (!isUuid(contactId)) return [];
  const other = alias(contacts, "other");
  const by = alias(users, "merged_by");
  const undoneBy = alias(users, "undone_by");
  const rows = await tx
    .select({
      id: contactMerges.id,
      winnerId: contactMerges.winnerId,
      loserId: contactMerges.loserId,
      otherId: other.id,
      otherName: other.name,
      otherPhone: other.phoneE164,
      reason: contactMerges.reason,
      mergedAt: contactMerges.mergedAt,
      mergedByName: by.name,
      undoneAt: contactMerges.undoneAt,
      undoneByName: undoneBy.name,
    })
    .from(contactMerges)
    .innerJoin(
      other,
      sql`${other.id} = case when ${contactMerges.winnerId} = ${contactId} then ${contactMerges.loserId} else ${contactMerges.winnerId} end`,
    )
    .leftJoin(by, eq(by.id, contactMerges.mergedById))
    .leftJoin(undoneBy, eq(undoneBy.id, contactMerges.undoneById))
    .where(or(eq(contactMerges.winnerId, contactId), eq(contactMerges.loserId, contactId)))
    .orderBy(desc(contactMerges.mergedAt))
    .limit(50);
  return rows.map(({ winnerId, loserId: _l, ...r }) => {
    void _l;
    return { ...r, role: winnerId === contactId ? "winner" : "loser" };
  });
}

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

/**
 * Open "possible duplicate" reviews where both records are still live (the dashboard's data health count).
 * A review whose side was merged away is not counted, matching listOpenDuplicateReviews.
 */
export async function countPossibleDuplicates(tx: Tx = db): Promise<number> {
  const ca = alias(contacts, "ca");
  const cb = alias(contacts, "cb");
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(duplicateReviews)
    .innerJoin(ca, eq(ca.id, duplicateReviews.contactAId))
    .innerJoin(cb, eq(cb.id, duplicateReviews.contactBId))
    .where(and(eq(duplicateReviews.status, "open"), isNull(ca.mergedIntoId), isNull(cb.mergedIntoId)));
  return r?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Organisations
// ---------------------------------------------------------------------------

export type OrganisationListRow = {
  id: string;
  name: string;
  kind: OrgKind;
  city: string | null;
  country: string | null;
  people: number;
  purchaseCount: number;
  revenueInr: number;
};

/** Net verified revenue (payments minus refunds, INR) of purchases linked to an organisation. */
const orgRevenueSql = (orgId: SQL | string) => sql<number>`coalesce((
  select sum(case when pm.kind = 'refund' then -pm.amount_inr else pm.amount_inr end)
  from payments pm join purchases pu on pu.id = pm.purchase_id
  where pu.organisation_id = ${orgId} and pm.status = 'verified'
), 0)::float8`;

export async function listOrganisations(
  opts: { q?: string | null; kind?: string | null; page?: number; pageSize?: number; tx?: Tx } = {},
): Promise<{ rows: OrganisationListRow[]; total: number; page: number; pageCount: number; pageSize: number }> {
  const tx = opts.tx ?? db;
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? CONTACTS_PAGE_SIZE, 200));
  const q = cleanText(opts.q);
  const conds: (SQL | undefined)[] = [];
  if (q) {
    const like = `%${escapeLike(q.toLowerCase())}%`;
    conds.push(
      or(sql`lower(${organisations.name}) like ${like}`, sql`lower(coalesce(${organisations.city}, '')) like ${like}`),
    );
  }
  if (opts.kind) conds.push(eq(organisations.kind, opts.kind as OrgKind));
  const where = conds.length ? and(...conds) : undefined;
  const [{ total }] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(organisations)
    .where(where);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, opts.page ?? 1), pageCount);
  const rows = total
    ? await tx
        .select({
          id: organisations.id,
          name: organisations.name,
          kind: organisations.kind,
          city: organisations.city,
          country: organisations.country,
          people: sql<number>`(select count(*)::int from contacts c where c.organisation_id = ${ORG_ID} and c.merged_into_id is null)`,
          purchaseCount: sql<number>`(select count(*)::int from purchases p where p.organisation_id = ${ORG_ID} and p.status <> 'cancelled')`,
          revenueInr: orgRevenueSql(ORG_ID),
        })
        .from(organisations)
        .where(where)
        .orderBy(sql`lower(${organisations.name})`, asc(organisations.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize)
    : [];
  return {
    rows: rows.map((r) => ({
      ...r,
      people: Number(r.people),
      purchaseCount: Number(r.purchaseCount),
      revenueInr: Number(r.revenueInr),
    })),
    total,
    page,
    pageCount,
    pageSize,
  };
}

export type OrganisationDetail = {
  id: string;
  name: string;
  kind: OrgKind;
  city: string | null;
  state: string | null;
  country: string | null;
  phone: string | null;
  notes: string | null;
  createdAt: Date;
  revenueInr: number;
};

export async function getOrganisation(id: string, tx: Tx = db): Promise<OrganisationDetail | null> {
  if (!isUuid(id)) return null;
  const rows = await tx
    .select({
      id: organisations.id,
      name: organisations.name,
      kind: organisations.kind,
      city: organisations.city,
      state: organisations.state,
      country: organisations.country,
      phone: organisations.phone,
      notes: organisations.notes,
      createdAt: organisations.createdAt,
      revenueInr: orgRevenueSql(id),
    })
    .from(organisations)
    .where(eq(organisations.id, id))
    .limit(1);
  const r = rows[0];
  return r ? { ...r, revenueInr: Number(r.revenueInr) } : null;
}

export type OrganisationPerson = {
  id: string;
  name: string;
  /** null for a hidden person */
  phoneE164: string | null;
  designation: string | null;
  stage: Stage;
  grade: Grade | null;
  ltvInr: number;
  ownerName: string | null;
  /** true when the viewer may not open this contact: name is HIDDEN_CONTACT_LABEL, phone/designation/owner left out */
  hidden: boolean;
};

/**
 * Everyone linked to an organisation (live records), highest LTV first. People the viewer may not open are listed
 * as HIDDEN_CONTACT_LABEL with their LTV only; `hidden` counts them.
 */
export async function getOrganisationPeople(
  user: Viewer,
  orgId: string,
  tx: Tx = db,
): Promise<{ people: OrganisationPerson[]; hidden: number }> {
  if (!isUuid(orgId)) return { people: [], hidden: 0 };
  const people = await tx
    .select({
      id: contacts.id,
      name: contacts.name,
      phoneE164: contacts.phoneE164,
      designation: contacts.designation,
      stage: contacts.stage,
      grade: contacts.grade,
      ltvInr: contacts.ltvInr,
      ownerId: contacts.ownerId,
      ownerName: users.name,
    })
    .from(contacts)
    .leftJoin(users, eq(users.id, contacts.ownerId))
    .where(and(isNull(contacts.mergedIntoId), eq(contacts.organisationId, orgId)))
    .orderBy(desc(contacts.ltvInr), asc(contacts.name))
    .limit(500);
  const out: OrganisationPerson[] = people.map(({ ownerId, ...p }) =>
    canViewContact(user, { ownerId })
      ? { ...p, hidden: false }
      : { ...p, name: HIDDEN_CONTACT_LABEL, phoneE164: null, designation: null, ownerName: null, hidden: true },
  );
  return { people: out, hidden: out.filter((p) => p.hidden).length };
}

export type OrganisationPurchase = {
  id: string;
  productName: string;
  family: string;
  amount: number;
  currency: string;
  amountInr: number;
  status: PurchaseStatus;
  purchasedAt: Date;
  contactId: string;
  contactName: string;
  contactOwnerId: string | null;
  netInr: number;
  /** true when the viewer may not open the signer: contactName is HIDDEN_CONTACT_LABEL */
  contactHidden: boolean;
};

/**
 * Purchases linked to an organisation (B2B deals), newest first, with the net verified INR of each. With a viewer,
 * a signer they may not open is named HIDDEN_CONTACT_LABEL.
 */
export async function getOrganisationPurchases(orgId: string, viewer: Viewer | null = null, tx: Tx = db): Promise<OrganisationPurchase[]> {
  if (!isUuid(orgId)) return [];
  const rows = await tx
    .select({
      id: purchases.id,
      productName: purchases.productName,
      family: purchases.family,
      amount: purchases.amount,
      currency: purchases.currency,
      amountInr: purchases.amountInr,
      status: purchases.status,
      purchasedAt: purchases.purchasedAt,
      contactId: contacts.id,
      contactName: contacts.name,
      contactOwnerId: contacts.ownerId,
      netInr: sql<number>`coalesce((
        select sum(case when pm.kind = 'refund' then -pm.amount_inr else pm.amount_inr end)
        from payments pm where pm.purchase_id = ${PURCHASE_ID} and pm.status = 'verified'
      ), 0)::float8`,
    })
    .from(purchases)
    .innerJoin(contacts, eq(contacts.id, purchases.contactId))
    .where(eq(purchases.organisationId, orgId))
    .orderBy(desc(purchases.purchasedAt))
    .limit(500);
  return rows.map((r) => {
    const contactHidden = !!viewer && !canViewContact(viewer, { ownerId: r.contactOwnerId });
    return { ...r, netInr: Number(r.netInr), contactHidden, ...(contactHidden ? { contactName: HIDDEN_CONTACT_LABEL } : {}) };
  });
}

/** Every organisation as a picker option, by name. */
export async function listOrganisationOptions(
  tx: Tx = db,
): Promise<{ id: string; name: string; city: string | null }[]> {
  return tx
    .select({ id: organisations.id, name: organisations.name, city: organisations.city })
    .from(organisations)
    .orderBy(sql`lower(${organisations.name})`)
    .limit(2000);
}

/** True when the viewer may create or edit organisations (sales, manager, admin). */
export function canManageOrganisations(user: { role: Role }): boolean {
  return can(user, "contacts.edit");
}

// ---------------------------------------------------------------------------
// Quick Add helpers
// ---------------------------------------------------------------------------

/**
 * Channel keys ordered by how often the team picks them in manual entries (Quick Add) over the last
 * `days` days, most used first. The caller fills the rest from the settings list.
 */
export async function channelUsage(days = 90, tx: Tx = db): Promise<string[]> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const rows = await tx
    .select({ channel: enquiries.channel, n: sql<number>`count(*)::int` })
    .from(enquiries)
    .where(
      and(
        sql`${enquiries.createdById} is not null`,
        sql`${enquiries.receivedAt} >= ${since.toISOString()}::timestamptz`,
      ),
    )
    .groupBy(enquiries.channel)
    .orderBy(sql`count(*) desc`)
    .limit(20);
  return rows.map((r) => r.channel);
}

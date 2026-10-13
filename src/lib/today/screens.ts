import "server-only";
import { desc, eq } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { contacts, ratings, users, type Contact, type FieldSource } from "@/db/schema";
import { can, canEditContact, canViewContact } from "@/lib/auth/permissions";
import { computeActivityFacts } from "@/lib/metrics/facts";
import { activeItems, getSettings, type ListItem, type LocationConfig, type ScoringConfig } from "@/lib/settings";
import { isUuid } from "@/lib/utils";
import { isGccContact } from "./rating-scales";

/**
 * Loaders for the Log interaction and Rate customer screens. Each returns null when the contact does not exist,
 * was merged away, or the user may not see it (the page then 404s), so pages never leak a contact.
 */

type Viewer = { id: string; role: "admin" | "manager" | "sales" | "support" };

async function loadVisibleContact(contactId: string, user: Viewer, tx: Tx): Promise<Contact | null> {
  if (!isUuid(contactId)) return null;
  const rows = await tx.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  const c = rows[0];
  if (!c || c.mergedIntoId) return null;
  if (!canViewContact(user, c)) return null;
  return c;
}

/** For the rate action: the live contact id and whether this user may give it a sales rating. */
export async function rateAccess(
  contactId: string,
  user: Viewer,
  tx: Tx = db,
): Promise<{ contactId: string; canRate: boolean } | null> {
  const c = await loadVisibleContact(contactId, user, tx);
  if (!c) return null;
  return { contactId: c.id, canRate: canGiveSalesRating(user, c) };
}

/** Sales (own and pool contacts), managers and admins rate; support never gives a sales rating. */
function canGiveSalesRating(user: Viewer, c: Pick<Contact, "ownerId">): boolean {
  return user.role !== "support" && can(user, "ratings.edit") && canEditContact(user, c);
}

export type LogScreen = {
  contact: Pick<Contact, "id" | "name" | "phoneE164" | "grade" | "edaptScore" | "stage" | "ownerId" | "purchaseCount">;
  outcomes: ListItem[];
  lostReasons: ListItem[];
  /** may mark the contact Lost from this screen */
  canMarkLost: boolean;
};

export async function loadLogScreen(contactId: string, user: Viewer, tx: Tx = db): Promise<LogScreen | null> {
  const c = await loadVisibleContact(contactId, user, tx);
  if (!c) return null;
  const s = await getSettings(["lists.outcomes", "lists.lostReasons"], tx);
  return {
    contact: {
      id: c.id,
      name: c.name,
      phoneE164: c.phoneE164,
      grade: c.grade,
      edaptScore: c.edaptScore,
      stage: c.stage,
      ownerId: c.ownerId,
      purchaseCount: c.purchaseCount,
    },
    outcomes: activeItems(s["lists.outcomes"]),
    lostReasons: activeItems(s["lists.lostReasons"]),
    canMarkLost: can(user, "contacts.setStage") && canEditContact(user, c) && c.stage !== "lost",
  };
}

export type LastRating = {
  at: Date;
  source: "sales" | "self" | "import";
  byName: string | null;
};

/** Everything the live score preview needs, serialisable for a client component. */
export type ScorePreviewInputs = {
  scoring: ScoringConfig;
  locations: LocationConfig;
  gccCountries: string[];
  /** the contact's non-rated scoring inputs */
  base: {
    country: string | null;
    state: string | null;
    city: string | null;
    phoneCountry: string | null;
    ltvInr: number;
    purchaseCount: number;
    familyCount: number;
    referralCount: number;
    /** ISO strings */
    lastPurchaseAt: string | null;
    lastInterestAt: string | null;
  };
  /** server time, ISO, so server and browser score with the same clock */
  now: string;
};

export type RateScreen = {
  contact: Pick<
    Contact,
    | "id"
    | "name"
    | "phoneE164"
    | "grade"
    | "edaptScore"
    | "fit"
    | "readiness"
    | "value"
    | "stage"
    | "aiLevel"
    | "umerLevel"
    | "spendingBand"
    | "gutStars"
    | "ageBand"
    | "industry"
  > & { fieldSources: Record<string, FieldSource> };
  ageBands: ListItem[];
  industries: ListItem[];
  /** show the GCC monthly income column instead of India yearly */
  gcc: boolean;
  lastRating: LastRating | null;
  preview: ScorePreviewInputs;
  /** may give a sales rating: sales on own/pool contacts, managers, admins */
  canRate: boolean;
};

export async function loadRateScreen(
  contactId: string,
  user: Viewer,
  now: Date = new Date(),
  tx: Tx = db,
): Promise<RateScreen | null> {
  const c = await loadVisibleContact(contactId, user, tx);
  if (!c) return null;
  const [s, last, activity] = await Promise.all([
    getSettings(["scoring", "locations", "assignment", "lists.ageBands", "lists.industries"], tx),
    tx
      .select({ at: ratings.createdAt, source: ratings.source, byName: users.name })
      .from(ratings)
      .leftJoin(users, eq(users.id, ratings.ratedByUserId))
      .where(eq(ratings.contactId, c.id))
      .orderBy(desc(ratings.createdAt))
      .limit(1),
    computeActivityFacts(c.id, tx),
  ]);
  const gccCountries = s.assignment.gccCountries ?? [];
  const lastInterestAt = activity.lastInterestAt === undefined ? activity.lastActivityAt : activity.lastInterestAt;
  return {
    contact: {
      id: c.id,
      name: c.name,
      phoneE164: c.phoneE164,
      grade: c.grade,
      edaptScore: c.edaptScore,
      fit: c.fit,
      readiness: c.readiness,
      value: c.value,
      stage: c.stage,
      aiLevel: c.aiLevel,
      umerLevel: c.umerLevel,
      spendingBand: c.spendingBand,
      gutStars: c.gutStars,
      ageBand: c.ageBand,
      industry: c.industry,
      fieldSources: c.fieldSources ?? {},
    },
    ageBands: activeItems(s["lists.ageBands"]),
    industries: activeItems(s["lists.industries"]),
    gcc: isGccContact(c, gccCountries),
    lastRating: last[0] ? { at: last[0].at, source: last[0].source, byName: last[0].byName } : null,
    preview: {
      scoring: s.scoring,
      locations: s.locations,
      gccCountries,
      base: {
        country: c.country,
        state: c.state,
        city: c.city,
        phoneCountry: c.phoneCountry,
        ltvInr: Number(c.ltvInr) || 0,
        purchaseCount: c.purchaseCount,
        familyCount: c.familyCount,
        referralCount: c.referralCount,
        lastPurchaseAt: c.lastPurchaseAt?.toISOString() ?? null,
        lastInterestAt: lastInterestAt?.toISOString() ?? null,
      },
      now: now.toISOString(),
    },
    canRate: canGiveSalesRating(user, c),
  };
}

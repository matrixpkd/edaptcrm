/**
 * Pure assembly of every calculated column on a contact from its facts. recomputeContact (server) gathers the
 * facts and settings, calls computeCalculatedColumns and writes the result. Keeping this pure makes the whole
 * pipeline unit-testable without a database.
 */
import type { Contact, Stage } from "@/db/schema";
import type {
  LocationConfig,
  NboRule,
  ProductFamily,
  ScoringConfig,
  Thresholds,
} from "@/lib/settings/defaults";
import { nextBestOffer, type NboProduct } from "./nbo";
import { computeRepeatMetrics, round, type CohortTable } from "./repeat-core";
import { scoreContact, type ContactScore, type Grade } from "./scoring";
import { computeAutoStage } from "./stage";

/** Money facts (spec "Purchases, payments and LTV"). */
export type MoneyFacts = {
  /** verified payments - verified refunds, INR. Unverified, scheduled and rejected rows never count. */
  ltvInr: number;
  /** purchases with status paid or partial */
  purchaseCount: number;
  /** distinct families of those purchases, in order of first purchase */
  families: string[];
  familyCount: number;
  /** highest ladder rung among those families (side groups have none); 0 = none */
  currentRung: number;
  firstPurchaseAt: Date | null;
  lastPurchaseAt: Date | null;
  /** family of the earliest counted purchase */
  firstFamily: string | null;
  /** purchased_at of the counted purchases, ascending */
  purchaseDates: Date[];
  /** latest verified payment (paid_at, else verified_at, else created_at) */
  lastVerifiedPaymentAt: Date | null;
};

export type ReferralFacts = {
  /** referred (non-merged) contacts with at least one paid purchase */
  referralCount: number;
  /** sum of the LTV of every (non-merged) contact they referred, INR */
  networkValueInr: number;
};

export type ActivityFacts = {
  lastEnquiryAt: Date | null;
  lastInteractionAt: Date | null;
  /** max of enquiry, interaction, purchase (not cancelled) and verified payment */
  lastActivityAt: Date | null;
  /** any interaction logged by a team member (user_id not null) */
  hasOutboundInteraction: boolean;
  /** max of enquiry, purchase (not cancelled) and verified payment (paid or, if later, verified) */
  lastEnquiryOrPaymentAt: Date | null;
  /**
   * Readiness "recent interest": the latest enquiry, chat or purchase. A chat is a call, WhatsApp, meeting or
   * email that was inbound or actually reached the person — notes, support issues and unanswered calls do not count.
   * Optional so older callers fall back to lastActivityAt.
   */
  lastInterestAt?: Date | null;
};

export const EMPTY_MONEY_FACTS: MoneyFacts = {
  ltvInr: 0,
  purchaseCount: 0,
  families: [],
  familyCount: 0,
  currentRung: 0,
  firstPurchaseAt: null,
  lastPurchaseAt: null,
  firstFamily: null,
  purchaseDates: [],
  lastVerifiedPaymentAt: null,
};
export const EMPTY_REFERRAL_FACTS: ReferralFacts = { referralCount: 0, networkValueInr: 0 };
export const EMPTY_ACTIVITY_FACTS: ActivityFacts = {
  lastEnquiryAt: null,
  lastInteractionAt: null,
  lastActivityAt: null,
  hasOutboundInteraction: false,
  lastEnquiryOrPaymentAt: null,
};

/** Latest of several optional dates. */
export function maxDate(...dates: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (d && (!best || d.getTime() > best.getTime())) best = d;
  return best;
}

/** Highest rung among the given family keys using the ladder families from settings; 0 when none. */
export function rungFor(families: string[], ladder: ProductFamily[]): number {
  let rung = 0;
  for (const f of families) {
    const r = ladder.find((x) => x.key === f)?.rung;
    if (typeof r === "number" && r > rung) rung = r;
  }
  return rung;
}

/** Settings and catalogue needed to compute a contact's columns (loaded once per recompute call or batch). */
export type MetricsContext = {
  scoring: ScoringConfig;
  thresholds: Thresholds;
  locations: LocationConfig;
  gccCountries: string[];
  families: ProductFamily[];
  nboRules: NboRule[];
  cohorts: CohortTable;
  products: NboProduct[];
  toInr: (amount: number, currency: string) => number;
};

/** The contact fields the metrics read. */
export type ContactInputs = Pick<
  Contact,
  | "id"
  | "stage"
  | "stageChangedAt"
  | "lostReason"
  | "createdAt"
  | "spendingBand"
  | "industry"
  | "ageBand"
  | "country"
  | "state"
  | "city"
  | "phoneCountry"
  | "umerLevel"
  | "aiLevel"
  | "gutStars"
  | "tags"
  | "firstDoor"
>;

/** Every calculated column recomputeContact writes, keyed by the Drizzle property name. */
export type CalculatedColumns = {
  ltvInr: number;
  purchaseCount: number;
  familyCount: number;
  families: string[];
  currentRung: number;
  firstPurchaseAt: Date | null;
  lastPurchaseAt: Date | null;
  firstFamily: string | null;
  lastEnquiryAt: Date | null;
  lastInteractionAt: Date | null;
  lastActivityAt: Date | null;
  stage: Stage;
  stageChangedAt: Date;
  lostReason: string | null;
  fit: number;
  readiness: number;
  value: number | null;
  edaptScore: number;
  grade: Grade;
  scoredAt: Date;
  avgGapDays: number | null;
  nextExpectedAt: Date | null;
  atRisk: boolean;
  repeatProb90d: number | null;
  nextOffer: string | null;
  nextOfferProductId: string | null;
  expected90dInr: number | null;
  referralCount: number;
  networkValueInr: number;
};

export type ComputedContact = {
  columns: CalculatedColumns;
  score: ContactScore;
  /** set when the automatic stage differs from the stored one */
  stageChange: { from: Stage; to: Stage } | null;
  nboRuleId: string | null;
};

export function computeCalculatedColumns(
  contact: ContactInputs,
  facts: { money: MoneyFacts; referral: ReferralFacts; activity: ActivityFacts },
  ctx: MetricsContext,
  now: Date,
): ComputedContact {
  const { money, referral, activity } = facts;

  const stage = computeAutoStage(
    {
      currentStage: contact.stage,
      stageChangedAt: contact.stageChangedAt,
      createdAt: contact.createdAt,
      purchaseCount: money.purchaseCount,
      referralCount: referral.referralCount,
      hasOutboundInteraction: activity.hasOutboundInteraction,
      lastActivityAt: activity.lastActivityAt,
      lastEnquiryOrPaymentAt: activity.lastEnquiryOrPaymentAt,
    },
    now,
    ctx.thresholds.dormantDays,
  );
  const stageChange = stage !== contact.stage ? { from: contact.stage, to: stage } : null;

  const score = scoreContact(
    {
      country: contact.country,
      state: contact.state,
      city: contact.city,
      phoneCountry: contact.phoneCountry,
      spendingBand: contact.spendingBand,
      industry: contact.industry,
      ageBand: contact.ageBand,
      umerLevel: contact.umerLevel,
      aiLevel: contact.aiLevel,
      gutStars: contact.gutStars,
      lastInterestAt: activity.lastInterestAt === undefined ? activity.lastActivityAt : activity.lastInterestAt,
      ltvInr: money.ltvInr,
      purchaseCount: money.purchaseCount,
      familyCount: money.familyCount,
      referralCount: referral.referralCount,
      lastPurchaseAt: money.lastPurchaseAt,
    },
    ctx.scoring,
    { locations: ctx.locations, gccCountries: ctx.gccCountries },
    now,
  );

  const repeat = computeRepeatMetrics(
    { purchaseDates: money.purchaseDates, firstFamily: money.firstFamily, purchaseCount: money.purchaseCount },
    { cohorts: ctx.cohorts, thresholds: ctx.thresholds },
    now,
  );

  const nbo = nextBestOffer(
    {
      purchaseCount: money.purchaseCount,
      families: money.families,
      currentRung: money.currentRung,
      industry: contact.industry,
      aiLevel: contact.aiLevel,
      fit: score.fit,
      country: contact.country,
      phoneCountry: contact.phoneCountry,
      tags: contact.tags ?? [],
      firstDoor: contact.firstDoor,
    },
    ctx.nboRules,
    { products: ctx.products, toInr: ctx.toInr, gccCountries: ctx.gccCountries },
  );

  const isCustomer = money.purchaseCount > 0;
  const expected90dInr =
    isCustomer && repeat.repeatProb90d !== null && nbo?.priceInr !== null && nbo?.priceInr !== undefined
      ? round(repeat.repeatProb90d * nbo.priceInr, 2)
      : null;

  const columns: CalculatedColumns = {
    ltvInr: round(money.ltvInr, 2),
    purchaseCount: money.purchaseCount,
    familyCount: money.familyCount,
    families: money.families,
    currentRung: money.currentRung,
    firstPurchaseAt: money.firstPurchaseAt,
    lastPurchaseAt: money.lastPurchaseAt,
    firstFamily: money.firstFamily,
    lastEnquiryAt: activity.lastEnquiryAt,
    lastInteractionAt: activity.lastInteractionAt,
    lastActivityAt: activity.lastActivityAt,
    stage,
    stageChangedAt: stageChange ? now : contact.stageChangedAt,
    // leaving Lost (pulled back by a new enquiry or payment) clears the lost reason
    lostReason: stageChange && stageChange.from === "lost" ? null : contact.lostReason,
    fit: score.fit,
    readiness: score.readiness,
    value: score.value,
    edaptScore: score.edaptScore,
    grade: score.grade,
    scoredAt: now,
    avgGapDays: repeat.avgGapDays,
    nextExpectedAt: repeat.nextExpectedAt,
    atRisk: repeat.atRisk,
    repeatProb90d: repeat.repeatProb90d,
    nextOffer: nbo?.offer ?? null,
    nextOfferProductId: nbo?.productId ?? null,
    expected90dInr,
    referralCount: referral.referralCount,
    networkValueInr: round(referral.networkValueInr, 2),
  };
  return { columns, score, stageChange, nboRuleId: nbo?.ruleId ?? null };
}

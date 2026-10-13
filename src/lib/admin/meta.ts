/**
 * Labels, units and help text for the Settings screens: thresholds, dropdown lists, next-best-offer conditions.
 * Pure: safe in client components.
 */
import type { NboCondition, SettingKey, Thresholds } from "@/lib/settings/defaults";

// ---------------------------------------------------------------------------
// Thresholds (Settings > Alerts)
// ---------------------------------------------------------------------------

export type ThresholdMeta = {
  key: keyof Thresholds;
  label: string;
  unit: "days" | "hours" | "minutes" | "rows" | "customers";
  hint: string;
  min: number;
  max: number;
  group: "Leads" | "Today" | "Customers" | "Money" | "Forecast";
};

/** Every key of `thresholds`, in the order shown on the screen. */
export const THRESHOLD_META: ThresholdMeta[] = [
  { key: "leadReleaseDays", label: "Untouched lead returns to the pool", unit: "days", hint: "An open lead with no logged interaction for this long goes back to the pool and alerts the manager.", min: 1, max: 365, group: "Leads" },
  { key: "untouchedOwnerHours", label: "Untouched lead: remind the owner", unit: "hours", hint: "No interaction this long after assignment raises a task for the owner.", min: 1, max: 720, group: "Leads" },
  { key: "untouchedManagerHours", label: "Untouched lead: tell the manager", unit: "hours", hint: "Still untouched after this long, the manager is alerted too.", min: 1, max: 720, group: "Leads" },
  { key: "abandonedCheckoutMinutes", label: "Abandoned checkout after", unit: "minutes", hint: "A TagMango payment started or failed with no completed order within this time becomes a call task.", min: 5, max: 1440, group: "Leads" },
  { key: "todayCap", label: "Today queue length", unit: "rows", hint: "The most actions shown on a salesperson's Today list.", min: 5, max: 500, group: "Today" },
  { key: "nextRungDays", label: "Due for next rung", unit: "days", hint: "Raise the task this many days before the expected next purchase.", min: 0, max: 365, group: "Customers" },
  { key: "atRiskDays", label: "At risk after", unit: "days", hint: "A customer this many days past their expected next purchase is at risk.", min: 1, max: 730, group: "Customers" },
  { key: "vipQuietDays", label: "VIP gone quiet after", unit: "days", hint: "A grade A customer with no activity for this long goes in the owner's and Umer's digest.", min: 1, max: 1095, group: "Customers" },
  { key: "dormantDays", label: "Dormant after", unit: "days", hint: "No enquiry, interaction or purchase for this long moves a contact to Dormant.", min: 1, max: 1825, group: "Customers" },
  { key: "instalmentDueDays", label: "Instalment due reminder", unit: "days", hint: "Owner and manager hear about an EMI this many days before it is due (and when overdue).", min: 0, max: 60, group: "Money" },
  { key: "unverifiedPaymentDays", label: "Unverified payment alert after", unit: "days", hint: "A bank or UPI payment still unverified after this long emails the manager.", min: 0, max: 60, group: "Money" },
  { key: "salesCreditDays", label: "Sales credit window", unit: "days", hint: "A purchase is credited to the owner if they logged an interaction within this many days before it.", min: 0, max: 365, group: "Money" },
  { key: "cohortMinSize", label: "Smallest usable cohort", unit: "customers", hint: "Smaller cohorts use the company-wide repeat rate instead.", min: 1, max: 10000, group: "Forecast" },
  { key: "repeatWindowDays", label: "Repeat probability window", unit: "days", hint: "Repeat probability counts customers who bought again within this window.", min: 7, max: 730, group: "Forecast" },
];

// ---------------------------------------------------------------------------
// Dropdown lists (Settings > Lists)
// ---------------------------------------------------------------------------

export const LIST_KEYS = [
  "lists.channels",
  "lists.firstDoors",
  "lists.campaigns",
  "lists.tags",
  "lists.languages",
  "lists.ageBands",
  "lists.industries",
  "lists.lostReasons",
  "lists.outcomes",
] as const satisfies readonly SettingKey[];
export type ListKey = (typeof LIST_KEYS)[number];

export type ListMeta = {
  key: ListKey;
  /** short slug used in the URL (?list=channels) */
  slug: string;
  title: string;
  description: string;
  /** what the usage count counts */
  usageLabel: string;
  /** keys the code relies on: they can be renamed or switched off, never removed */
  systemKeys: string[];
  /** tags are stored as their own text, so the key is the label as typed */
  keyIsLabel?: boolean;
};

export const LIST_META: ListMeta[] = [
  {
    key: "lists.channels",
    slug: "channels",
    title: "Channels",
    description: "How an enquiry reached us. A new value with every enquiry.",
    usageLabel: "enquiries and contacts",
    systemKeys: ["whatsapp_api", "whatsapp_app", "meta_lead_form", "tagmango_checkout", "website_form", "phone_call", "walk_in_event", "import"],
  },
  {
    key: "lists.firstDoors",
    slug: "first-doors",
    title: "First doors",
    description: "How they first came to know Edapt or Umer. Set once, never overwritten.",
    usageLabel: "contacts, offer rules and capture mappings",
    systemKeys: ["other", "referral", "meta_ad", "search_website", "delegation", "mla_program"],
  },
  {
    key: "lists.campaigns",
    slug: "campaigns",
    title: "Campaigns",
    description: "Which campaign, program or event exactly. Per enquiry.",
    usageLabel: "enquiries, contacts and purchases",
    systemKeys: [],
  },
  {
    key: "lists.tags",
    slug: "tags",
    title: "Tags",
    description: "Anything else worth filtering by.",
    usageLabel: "contacts and offer rules",
    systemKeys: ["Legacy: Delegation"],
    keyIsLabel: true,
  },
  {
    key: "lists.languages",
    slug: "languages",
    title: "Languages",
    description: "Preferred language. The share who don't speak Malayalam is the expansion meter.",
    usageLabel: "contacts",
    systemKeys: ["ml"],
  },
  {
    key: "lists.ageBands",
    slug: "age-bands",
    title: "Age bands",
    description: "Used by Fit scoring: give new bands points in Settings > Scoring.",
    usageLabel: "contacts",
    systemKeys: [],
  },
  {
    key: "lists.industries",
    slug: "industries",
    title: "Industries",
    description: "Industry or role. Used by Fit scoring: give new ones points in Settings > Scoring.",
    usageLabel: "contacts and offer rules",
    systemKeys: ["business_owner"],
  },
  {
    key: "lists.lostReasons",
    slug: "lost-reasons",
    title: "Lost reasons",
    description: "Why a lead was lost. Shown on the dashboard as product feedback.",
    usageLabel: "contacts",
    systemKeys: ["other"],
  },
  {
    key: "lists.outcomes",
    slug: "outcomes",
    title: "Call outcomes",
    description: "Outcome chips on Log interaction.",
    usageLabel: "interactions",
    systemKeys: [],
  },
];

export function listMetaBySlug(slug: string | null | undefined): ListMeta | undefined {
  return LIST_META.find((m) => m.slug === slug);
}

/** "Walk-in or Event!" -> "walk_in_or_event" (letters and digits in any script are kept). */
export function slugKey(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Next best offer conditions (Settings > Next best offer)
// ---------------------------------------------------------------------------

export type NboConditionType = NboCondition["type"];

/** Which input a condition needs: nothing, a number, one choice, or several values from a list. */
export type NboInputKind =
  | { kind: "none" }
  | { kind: "number"; min: number; max: number; step?: number }
  | { kind: "region" }
  | { kind: "values"; source: "firstDoors" | "tags" | "industries" | "families" | "countries" }
  | { kind: "rung" };

export const NBO_CONDITION_META: Record<NboConditionType, { label: string; input: NboInputKind }> = {
  no_purchases: { label: "Has never bought", input: { kind: "none" } },
  first_door_in: { label: "First door is one of", input: { kind: "values", source: "firstDoors" } },
  tag_in: { label: "Has any of the tags", input: { kind: "values", source: "tags" } },
  industry_in: { label: "Industry is one of", input: { kind: "values", source: "industries" } },
  ai_level_gte: { label: "AI knowledge at least", input: { kind: "number", min: 0, max: 5 } },
  fit_gte: { label: "Fit at least", input: { kind: "number", min: 0, max: 100 } },
  country_in: { label: "Country is one of", input: { kind: "values", source: "countries" } },
  region_is: { label: "Region is", input: { kind: "region" } },
  bought_family: { label: "Has bought any of", input: { kind: "values", source: "families" } },
  not_bought_family: { label: "Has not bought any of", input: { kind: "values", source: "families" } },
  only_families: { label: "Has bought only", input: { kind: "values", source: "families" } },
  purchase_count_gte: { label: "Purchases at least", input: { kind: "number", min: 0, max: 1000 } },
  current_rung_gte: { label: "Ladder rung at least", input: { kind: "rung" } },
  current_rung_eq: { label: "Ladder rung is exactly", input: { kind: "rung" } },
};

export const NBO_CONDITION_TYPES = Object.keys(NBO_CONDITION_META) as NboConditionType[];

export const REGION_LABELS: Record<"gcc" | "india" | "rest_of_world", string> = {
  gcc: "GCC",
  india: "India",
  rest_of_world: "Rest of the world",
};

/** A blank condition of the given type, for the rule editor. */
export function blankCondition(type: NboConditionType): NboCondition {
  const input = NBO_CONDITION_META[type].input;
  switch (input.kind) {
    case "none":
      return { type } as NboCondition;
    case "number":
      return { type, value: input.min } as NboCondition;
    case "rung":
      return { type, value: 1 } as NboCondition;
    case "region":
      return { type, value: "gcc" } as NboCondition;
    case "values":
      return { type, values: [] } as NboCondition;
  }
}

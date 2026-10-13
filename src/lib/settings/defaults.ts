/**
 * Every configurable rule, list and weight in the CRM, with the defaults from the spec.
 * The Settings screens edit these values; the database row in `settings` (key -> json)
 * overrides the default here. Nothing in this file needs a code change to tune.
 */

export type ListItem = { key: string; label: string; active?: boolean };

/** A threshold table: the first row whose condition matches wins. */
export type MinRow = { min: number; points: number };
export type WithinDaysRow = { withinDays: number; points: number };
export type BelowRow = { below: number; points: number };

export type ScoringConfig = {
  /** Edapt score blends. Leads use fit + readiness; customers add value. */
  blend: {
    lead: { fit: number; readiness: number };
    customer: { fit: number; readiness: number; value: number };
  };
  /** Gut adjustment by stars; "unrated" when no gut rating exists. */
  gut: Record<"1" | "2" | "3" | "4" | "5" | "unrated", number>;
  /** Minimum score for each grade; anything below C is D. */
  grades: { A: number; B: number; C: number };
  fit: {
    spendingBand: Record<"1" | "2" | "3" | "4" | "5" | "unknown", number>;
    /** industry key -> points, plus "unknown" */
    industry: Record<string, number>;
    /** age band key -> points, plus "unknown" */
    ageBand: Record<string, number>;
    location: Record<
      "gcc" | "rest_of_world" | "kerala_city_or_metro" | "rest_of_kerala" | "rest_of_india" | "unknown",
      number
    >;
  };
  readiness: {
    umerPointsPerLevel: number;
    /** unknown Umer familiarity counts as this level */
    umerUnknownLevel: number;
    aiLevel: Record<"0" | "1" | "2" | "3" | "4" | "5" | "unknown", number>;
    /** last enquiry, chat or purchase within N days -> points (checked in order) */
    recentInterest: WithinDaysRow[];
    recentInterestOlder: number;
  };
  value: {
    /** LTV in INR below threshold -> points (checked in order); at or above the last -> ltvTop */
    ltv: BelowRow[];
    ltvTop: number;
    /** purchase count >= min -> points (checked in order, highest first) */
    frequency: MinRow[];
    /** product families bought >= min -> points */
    breadth: MinRow[];
    /** paying customers referred >= min -> points */
    referrals: MinRow[];
    /** last purchase within N days -> points */
    recency: WithinDaysRow[];
    recencyOlder: number;
  };
};

export type ProductFamily = {
  key: string;
  label: string;
  /** ladder rung 1..4, or null for a side group */
  rung: number | null;
  /** side group label when rung is null */
  group?: string;
};

export type Rung = { rung: number; label: string; description?: string };

/**
 * Next best offer rules, checked in order; the first match wins.
 * `when` conditions are ANDed. `offer` is shown on the contact page and the Today queue;
 * `productId` (optional) gives the price used by the 90-day forecast, otherwise `price`.
 */
export type NboCondition =
  | { type: "no_purchases" }
  | { type: "first_door_in"; values: string[] }
  | { type: "tag_in"; values: string[] }
  | { type: "industry_in"; values: string[] }
  | { type: "ai_level_gte"; value: number }
  | { type: "fit_gte"; value: number }
  | { type: "country_in"; values: string[] }
  | { type: "region_is"; value: "gcc" | "india" | "rest_of_world" }
  | { type: "bought_family"; values: string[] }
  | { type: "not_bought_family"; values: string[] }
  | { type: "only_families"; values: string[] }
  | { type: "purchase_count_gte"; value: number }
  | { type: "current_rung_gte"; value: number }
  | { type: "current_rung_eq"; value: number };

export type NboRule = {
  id: string;
  label: string;
  when: NboCondition[];
  offer: string;
  productId?: string | null;
  price?: number | null;
  active?: boolean;
};

export type Thresholds = {
  /** an open lead with no logged interaction for this many days returns to the pool */
  leadReleaseDays: number;
  untouchedOwnerHours: number;
  untouchedManagerHours: number;
  abandonedCheckoutMinutes: number;
  todayCap: number;
  /** "due for next rung" this many days before the expected next purchase */
  nextRungDays: number;
  /** "at risk" this many days past the expected next purchase */
  atRiskDays: number;
  instalmentDueDays: number;
  unverifiedPaymentDays: number;
  vipQuietDays: number;
  /** no enquiry, interaction or purchase for this many days -> Dormant */
  dormantDays: number;
  /** a purchase is credited to the owner if they logged an interaction within this many days before it */
  salesCreditDays: number;
  /** cohorts smaller than this fall back to the company-wide repeat rate */
  cohortMinSize: number;
  /** repeat-probability window */
  repeatWindowDays: number;
};

export type CurrencyConfig = {
  base: "INR";
  /** currencies offered on payment forms; INR first */
  enabled: string[];
  /** INR per 1 unit, by month: { AED: { "2026-10": 22.7 } }. The latest month at or before the payment date is used. */
  rates: Record<string, Record<string, number>>;
};

export type Team = { key: string; label: string; timezone: string };

export type AssignmentConfig = {
  /** contacts whose phone country is in this list go to gccTeam */
  gccCountries: string[];
  gccTeam: string;
  defaultTeam: string;
  /** when false, new leads land in the pool instead */
  autoAssign: boolean;
};

export type LocationConfig = {
  /** lower-case city names (and common spellings) counted as "Kerala cities" */
  keralaCities: string[];
  /** lower-case Indian metro names */
  indianMetros: string[];
  /** lower-case spellings of Kerala used in the state field */
  keralaStateNames: string[];
};

export type DigestConfig = {
  /** local time each user receives the daily digest */
  dailyHour: number;
  dailyMinute: number;
  /** recipients of the Monday weekly summary and the VIP digest */
  weeklyRecipients: string[];
};

export const DEFAULT_SETTINGS = {
  "lists.channels": [
    { key: "whatsapp_api", label: "WhatsApp API" },
    { key: "whatsapp_app", label: "WhatsApp app" },
    { key: "meta_lead_form", label: "Meta lead form" },
    { key: "tagmango_checkout", label: "TagMango checkout" },
    { key: "website_form", label: "Website form" },
    { key: "phone_call", label: "Phone call" },
    { key: "walk_in_event", label: "Walk-in or event" },
    { key: "import", label: "Import" },
  ] as ListItem[],

  "lists.firstDoors": [
    { key: "youtube", label: "YouTube" },
    { key: "meta_ad", label: "Meta ad" },
    { key: "workshop_webinar", label: "Workshop or webinar" },
    { key: "mla_program", label: "MLA or constituency program" },
    { key: "delegation", label: "Delegation" },
    { key: "ai_office", label: "The AI Office" },
    { key: "book_keynote", label: "Book or keynote" },
    { key: "referral", label: "Referral" },
    { key: "school_partnership", label: "School partnership" },
    { key: "business_partner", label: "Business partner" },
    { key: "search_website", label: "Search or website" },
    { key: "other", label: "Other" },
  ] as ListItem[],

  "lists.campaigns": [
    { key: "koduvally_ai_literacy", label: "Koduvally AI Literacy Mission" },
    { key: "buddhi_yatra_malappuram", label: "Buddhi Yatra Malappuram" },
    { key: "ai_office_dubai_oct_2026", label: "AI Office Dubai October 2026" },
    { key: "claude_mastery_meta", label: "Claude Mastery Meta ads" },
  ] as ListItem[],

  "lists.tags": [
    { key: "Legacy: Delegation", label: "Legacy: Delegation" },
    { key: "B2B", label: "B2B" },
    { key: "VIP", label: "VIP" },
    { key: "Mentor prospect", label: "Mentor prospect" },
  ] as ListItem[],

  "lists.languages": [
    { key: "ml", label: "Malayalam" },
    { key: "en", label: "English" },
    { key: "hi", label: "Hindi" },
    { key: "ar", label: "Arabic" },
    { key: "ta", label: "Tamil" },
    { key: "other", label: "Other" },
  ] as ListItem[],

  "lists.ageBands": [
    { key: "18-24", label: "18 to 24" },
    { key: "25-34", label: "25 to 34" },
    { key: "35-44", label: "35 to 44" },
    { key: "45-54", label: "45 to 54" },
    { key: "55-64", label: "55 to 64" },
    { key: "65+", label: "65+" },
  ] as ListItem[],

  "lists.industries": [
    { key: "business_owner", label: "Business owner" },
    { key: "senior_manager", label: "Senior manager" },
    { key: "it_professional", label: "IT professional" },
    { key: "healthcare_professional", label: "Healthcare professional" },
    { key: "government", label: "Government employee" },
    { key: "freelancer", label: "Freelancer" },
    { key: "other_professional", label: "Other professional" },
    { key: "retired", label: "Retired" },
    { key: "teacher", label: "Teacher" },
    { key: "homemaker", label: "Homemaker" },
    { key: "student", label: "Student" },
  ] as ListItem[],

  "lists.lostReasons": [
    { key: "price", label: "Price" },
    { key: "timing", label: "Timing" },
    { key: "not_interested", label: "Not interested" },
    { key: "wrong_number", label: "Wrong number" },
    { key: "bought_elsewhere", label: "Bought elsewhere" },
    { key: "other", label: "Other" },
  ] as ListItem[],

  "lists.outcomes": [
    { key: "connected", label: "Connected" },
    { key: "no_answer", label: "No answer" },
    { key: "busy", label: "Busy / call back" },
    { key: "interested", label: "Interested" },
    { key: "not_interested", label: "Not interested" },
    { key: "payment_promised", label: "Payment promised" },
    { key: "paid", label: "Paid" },
    { key: "wrong_number", label: "Wrong number" },
    { key: "resolved", label: "Resolved" },
    { key: "info_sent", label: "Info sent" },
  ] as ListItem[],

  teams: [
    { key: "kerala", label: "Kerala", timezone: "Asia/Kolkata" },
    { key: "dubai", label: "Dubai", timezone: "Asia/Dubai" },
  ] as Team[],

  assignment: {
    gccCountries: ["AE", "SA", "QA", "KW", "BH", "OM"],
    gccTeam: "dubai",
    defaultTeam: "kerala",
    autoAssign: true,
  } as AssignmentConfig,

  "ladder.rungs": [
    { rung: 1, label: "Workshops", description: "Entry workshops, ₹699 to ₹999" },
    { rung: 2, label: "Applied AI Mastery", description: "The flagship program" },
    { rung: 3, label: "The AI Office", description: "Membership for business owners" },
    { rung: 4, label: "Premium", description: "Premium programs and consulting" },
  ] as Rung[],

  "ladder.families": [
    { key: "workshop", label: "Workshops", rung: 1 },
    { key: "applied_ai_mastery", label: "Applied AI Mastery", rung: 2 },
    { key: "ai_office", label: "The AI Office", rung: 3 },
    { key: "premium", label: "Premium programs", rung: 4 },
    { key: "consulting", label: "Consulting", rung: 4 },
    { key: "b2b_program", label: "B2B programs", rung: null, group: "B2B and constituency" },
    { key: "constituency_program", label: "Constituency programs", rung: null, group: "B2B and constituency" },
    { key: "delegation", label: "Delegation (legacy)", rung: null, group: "Delegation" },
  ] as ProductFamily[],

  scoring: {
    blend: {
      lead: { fit: 0.5, readiness: 0.5 },
      customer: { fit: 0.25, readiness: 0.25, value: 0.5 },
    },
    gut: { "1": -10, "2": -5, "3": 0, "4": 5, "5": 10, unrated: 0 },
    grades: { A: 75, B: 60, C: 40 },
    fit: {
      spendingBand: { "1": 5, "2": 10, "3": 15, "4": 20, "5": 25, unknown: 10 },
      industry: {
        business_owner: 25,
        senior_manager: 22,
        it_professional: 18,
        healthcare_professional: 18,
        government: 15,
        freelancer: 15,
        other_professional: 12,
        retired: 10,
        teacher: 8,
        homemaker: 8,
        student: 5,
        unknown: 10,
      },
      ageBand: {
        "35-44": 25,
        "45-54": 22,
        "25-34": 18,
        "55-64": 15,
        "65+": 10,
        "18-24": 8,
        unknown: 12,
      },
      location: {
        gcc: 25,
        rest_of_world: 20,
        kerala_city_or_metro: 18,
        rest_of_kerala: 15,
        rest_of_india: 12,
        unknown: 12,
      },
    },
    readiness: {
      umerPointsPerLevel: 8,
      umerUnknownLevel: 1,
      aiLevel: { "0": 10, "1": 20, "2": 30, "3": 30, "4": 24, "5": 14, unknown: 15 },
      recentInterest: [
        { withinDays: 7, points: 30 },
        { withinDays: 30, points: 20 },
        { withinDays: 90, points: 10 },
      ],
      recentInterestOlder: 0,
    },
    value: {
      ltv: [
        { below: 1000, points: 5 },
        { below: 5000, points: 10 },
        { below: 20000, points: 15 },
        { below: 50000, points: 20 },
      ],
      ltvTop: 25,
      frequency: [
        { min: 6, points: 20 },
        { min: 4, points: 17 },
        { min: 3, points: 14 },
        { min: 2, points: 10 },
        { min: 1, points: 5 },
      ],
      breadth: [
        { min: 3, points: 20 },
        { min: 2, points: 13 },
        { min: 1, points: 5 },
      ],
      referrals: [
        { min: 3, points: 20 },
        { min: 2, points: 15 },
        { min: 1, points: 10 },
      ],
      recency: [
        { withinDays: 90, points: 15 },
        { withinDays: 180, points: 10 },
        { withinDays: 365, points: 5 },
      ],
      recencyOlder: 0,
    },
  } as ScoringConfig,

  locations: {
    keralaCities: [
      "thiruvananthapuram",
      "trivandrum",
      "kochi",
      "cochin",
      "ernakulam",
      "kozhikode",
      "calicut",
      "thrissur",
      "trichur",
      "kollam",
      "quilon",
      "kannur",
      "cannanore",
    ],
    indianMetros: [
      "mumbai",
      "bombay",
      "delhi",
      "new delhi",
      "bengaluru",
      "bangalore",
      "chennai",
      "madras",
      "hyderabad",
      "kolkata",
      "calcutta",
      "pune",
      "ahmedabad",
      "gurugram",
      "gurgaon",
      "noida",
    ],
    keralaStateNames: ["kerala", "kl"],
  } as LocationConfig,

  "nbo.rules": [
    {
      id: "mentor",
      label: "AI knowledge level 5",
      when: [{ type: "ai_level_gte", value: 5 }],
      offer: "Mentor or affiliate invitation",
      price: 0,
    },
    {
      id: "delegation",
      label: "Delegation alumni",
      when: [{ type: "bought_family", values: ["delegation"] }, { type: "not_bought_family", values: ["ai_office"] }],
      offer: "The AI Office and premium programs",
      price: null,
    },
    {
      // the legacy delegation list is imported tagged "Legacy: Delegation", often with no purchase rows
      id: "delegation_tag",
      label: "Delegation alumni (Legacy: Delegation tag)",
      when: [{ type: "tag_in", values: ["Legacy: Delegation"] }, { type: "not_bought_family", values: ["ai_office"] }],
      offer: "The AI Office and premium programs",
      price: null,
    },
    {
      id: "ai_office_member",
      label: "The AI Office member",
      when: [{ type: "bought_family", values: ["ai_office"] }],
      offer: "The AI Office renewal, and ask for referrals",
      price: null,
    },
    {
      id: "aam_graduate",
      label: "Applied AI Mastery graduate",
      when: [{ type: "bought_family", values: ["applied_ai_mastery"] }],
      offer: "The AI Office or advanced workshops",
      price: null,
    },
    {
      id: "owner_gcc",
      label: "GCC business owner with a workshop",
      when: [
        { type: "industry_in", values: ["business_owner"] },
        { type: "bought_family", values: ["workshop"] },
        { type: "region_is", value: "gcc" },
      ],
      offer: "AI Agents for Business, then The AI Office",
      price: null,
    },
    {
      id: "owner",
      label: "Business owner with a workshop",
      when: [{ type: "industry_in", values: ["business_owner"] }, { type: "bought_family", values: ["workshop"] }],
      offer: "AI Agents for Business",
      price: null,
    },
    {
      id: "workshop_fit",
      label: "One workshop, Fit 60 or more",
      when: [{ type: "only_families", values: ["workshop"] }, { type: "fit_gte", value: 60 }],
      offer: "Applied AI Mastery",
      price: null,
    },
    {
      id: "workshop",
      label: "Workshop buyer",
      when: [{ type: "only_families", values: ["workshop"] }],
      offer: "A workshop on a different topic",
      price: 999,
    },
    {
      id: "free",
      label: "Free only (YouTube, webinar, MLA program)",
      when: [{ type: "no_purchases" }],
      offer: "Entry workshop (₹699 to ₹999)",
      price: 699,
    },
  ] as NboRule[],

  currency: {
    base: "INR",
    enabled: ["INR", "AED", "USD"],
    rates: {
      AED: { "2026-01": 22.6, "2026-10": 22.7 },
      USD: { "2026-01": 83.2, "2026-10": 83.4 },
    },
  } as CurrencyConfig,

  thresholds: {
    leadReleaseDays: 7,
    untouchedOwnerHours: 24,
    untouchedManagerHours: 48,
    abandonedCheckoutMinutes: 60,
    todayCap: 40,
    nextRungDays: 7,
    atRiskDays: 30,
    instalmentDueDays: 3,
    unverifiedPaymentDays: 2,
    vipQuietDays: 120,
    dormantDays: 180,
    salesCreditDays: 30,
    cohortMinSize: 30,
    repeatWindowDays: 90,
  } as Thresholds,

  digest: {
    dailyHour: 8,
    dailyMinute: 30,
    weeklyRecipients: [],
  } as DigestConfig,

  /** Cohort repeat rates, rebuilt nightly. Not edited by hand. */
  "metrics.cohorts": {
    builtAt: null as string | null,
    companyRate: null as number | null,
    medianFirstGapDays: null as number | null,
    /** key "<firstFamily>:<purchaseCount>" -> { n, repeated, rate } */
    cohorts: {} as Record<string, { n: number; repeated: number; rate: number }>,
  },
};

export type Settings = typeof DEFAULT_SETTINGS;
export type SettingKey = keyof Settings;

/**
 * Integration settings for the automatic capture pipes (TagMango, Libromi, Pabbly): types and the defaults that
 * src/lib/settings/defaults.ts registers under the keys `integrations.fieldPaths`, `integrations.selfRatings`
 * and `integrations.options`. Pure: safe in client components.
 */

/** The pipes whose payloads are read through field paths. Pabbly's two routes share one contract. */
export const FIELD_PATH_SOURCES = ["tagmango", "libromi", "pabbly"] as const;
export type FieldPathSource = (typeof FIELD_PATH_SOURCES)[number];

/**
 * Admin overrides: source -> field -> paths tried BEFORE the built-in candidates (see extract.ts).
 * A path is dot notation with optional indexes, e.g. "data.customer.phone" or "items[0].name".
 */
export type IntegrationFieldPaths = Record<FieldPathSource, Record<string, string[]>>;

/** What a self-reported answer can fill. The first door fills only a contact whose first door is still unknown. */
export const SELF_RATING_FIELDS = ["firstDoor", "umerLevel", "aiLevel"] as const;
export type SelfRatingField = (typeof SELF_RATING_FIELDS)[number];

export type SelfRatingConfig = {
  /**
   * Which question an answer belongs to: a custom checkout field (TagMango) or a form answer (Pabbly) whose question
   * contains one of `match` (case-insensitive, whole words) fills `field`. Checked in order.
   */
  questions: { field: SelfRatingField; match: string[] }[];
  /**
   * Answer text -> value, per field, checked in order (first hit wins). `value` is a first door key, or a level
   * 0 to 5 as text. Answers that start with a digit 0 to 5 ("3", "3 - watches regularly") are read as that level,
   * and first door answers also match the first door list's labels and keys.
   */
  answers: { field: SelfRatingField; value: string; match: string[] }[];
  /**
   * WhatsApp one-tap replies (Libromi): a button whose id or title equals `match` (case-insensitive) sets `field`.
   * Button ids written as "door:youtube", "umer:3" or "ai:2" work without any entry here.
   */
  buttons: { match: string; field: SelfRatingField; value: string }[];
};

export type IntegrationOptions = {
  /** ISO country assumed for numbers written without a country code */
  defaultCountry: string;
  /** currency of a TagMango order that does not say */
  defaultCurrency: string;
  /** product family for a TagMango order whose product is not in the catalogue (ladder.families key) */
  tagmangoDefaultFamily: string;
  /**
   * A WhatsApp message from someone who has not written for this many hours is a new enquiry; messages inside
   * the window are logged as inbound WhatsApp interactions.
   */
  libromiWindowHours: number;
  /**
   * IANA time zone for date-times a payload writes without a zone ("2026-10-13 10:00:00"). TagMango and most Indian
   * tools write India time; a time with a zone or an epoch number is exact and never shifted.
   */
  timeZone: string;
};

export const DEFAULT_INTEGRATION_FIELD_PATHS: IntegrationFieldPaths = { tagmango: {}, libromi: {}, pabbly: {} };

export const DEFAULT_SELF_RATING_CONFIG: SelfRatingConfig = {
  questions: [
    {
      field: "firstDoor",
      match: [
        "first hear",
        "first heard",
        "hear about edapt",
        "heard about edapt",
        "how did you hear",
        "where did you hear",
        "come to know",
        "came to know",
        "know about edapt",
        "find out about edapt",
        "found out about edapt",
        "find edapt",
        "found edapt",
      ],
    },
    {
      field: "umerLevel",
      match: ["know umer", "familiar with umer", "umer familiarity", "know about umer", "heard of umer"],
    },
    {
      field: "aiLevel",
      match: ["use ai", "using ai", "ai knowledge", "experience with ai", "ai experience", "familiar with ai", "know about ai", "ai level", "level of ai", "ai skills", "ai usage"],
    },
  ],
  answers: [
    { field: "firstDoor", value: "youtube", match: ["youtube", "yt", "youtube video", "youtube channel"] },
    { field: "firstDoor", value: "meta_ad", match: ["facebook", "instagram", "insta", "fb", "meta", "facebook ad", "instagram ad", "ad", "ads", "advertisement"] },
    { field: "firstDoor", value: "workshop_webinar", match: ["workshop", "webinar", "masterclass", "live session"] },
    { field: "firstDoor", value: "mla_program", match: ["mla", "constituency", "panchayat", "buddhi yatra", "ai literacy"] },
    { field: "firstDoor", value: "delegation", match: ["delegation", "trip", "tour"] },
    { field: "firstDoor", value: "ai_office", match: ["ai office"] },
    { field: "firstDoor", value: "book_keynote", match: ["book", "keynote", "speech", "talk", "conference"] },
    { field: "firstDoor", value: "referral", match: ["friend", "friends", "family", "colleague", "referral", "referred", "word of mouth", "someone told me"] },
    { field: "firstDoor", value: "school_partnership", match: ["school", "college"] },
    { field: "firstDoor", value: "business_partner", match: ["business partner", "partner"] },
    { field: "firstDoor", value: "search_website", match: ["google", "search", "website", "web", "online search"] },

    // Umer familiarity (spec "Rating scales"); "does not know" is checked before anything mentioning "know"
    { field: "umerLevel", value: "0", match: ["don't know", "dont know", "do not know", "does not know", "not at all", "never heard", "who is umer", "no idea"] },
    { field: "umerLevel", value: "5", match: ["met him", "met umer", "personally", "personal connection", "in his network", "friend of umer"] },
    { field: "umerLevel", value: "4", match: ["follow closely", "follow him closely", "read his book", "attended his", "attended a session", "keynote", "very well"] },
    { field: "umerLevel", value: "3", match: ["watch regularly", "watches regularly", "regularly", "regular viewer", "recall his ideas"] },
    { field: "umerLevel", value: "2", match: ["few videos", "a few videos", "watched a few", "some videos", "a little"] },
    { field: "umerLevel", value: "1", match: ["know the name", "knows the name", "heard the name", "heard of him", "just the name", "saw an ad", "seen an ad", "seen his ads", "only the name"] },

    // AI knowledge
    { field: "aiLevel", value: "0", match: ["never used", "never", "not used", "no experience"] },
    { field: "aiLevel", value: "5", match: ["build", "builder", "automations", "agents", "developer", "work in tech", "in tech"] },
    { field: "aiLevel", value: "4", match: ["power user", "several tools", "many tools", "own workflows", "workflows"] },
    { field: "aiLevel", value: "3", match: ["every week", "weekly", "every day", "daily", "regularly"] },
    { field: "aiLevel", value: "2", match: ["now and then", "sometimes", "occasionally", "simple tasks"] },
    { field: "aiLevel", value: "1", match: ["tried", "a few times", "few times", "once or twice"] },
  ],
  buttons: [
    { match: "YouTube", field: "firstDoor", value: "youtube" },
    { match: "Instagram or Facebook", field: "firstDoor", value: "meta_ad" },
    { match: "Facebook or Instagram ad", field: "firstDoor", value: "meta_ad" },
    { match: "Friend or family", field: "firstDoor", value: "referral" },
    { match: "Workshop or webinar", field: "firstDoor", value: "workshop_webinar" },
    { match: "MLA program", field: "firstDoor", value: "mla_program" },
    { match: "Google or website", field: "firstDoor", value: "search_website" },
    { match: "Don't know him", field: "umerLevel", value: "0" },
    { match: "Heard the name", field: "umerLevel", value: "1" },
    { match: "Watched a few videos", field: "umerLevel", value: "2" },
    { match: "Watch him regularly", field: "umerLevel", value: "3" },
    { match: "Follow him closely", field: "umerLevel", value: "4" },
    { match: "Met him personally", field: "umerLevel", value: "5" },
  ],
};

export const DEFAULT_INTEGRATION_OPTIONS: IntegrationOptions = {
  defaultCountry: "IN",
  defaultCurrency: "INR",
  tagmangoDefaultFamily: "workshop",
  libromiWindowHours: 24,
  timeZone: "Asia/Kolkata",
};

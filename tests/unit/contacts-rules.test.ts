import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";
import {
  DEFAULT_FIRST_DOOR_BY_CHANNEL,
  addUnique,
  cleanText,
  countryCode,
  decideFirstDoor,
  earlierOf,
  excerpt,
  followUpReason,
  isManualChannel,
  placeSuggestionList,
  isPhoneFallbackName,
  isUuid,
  laterOf,
  listKeyFor,
  looseKey,
  orderedPair,
  ratingMayOverwrite,
  ratingValueError,
  removeAdded,
  sanitizeRatings,
  teamForCountry,
} from "@/lib/contacts/rules";
import { ContactError, ContactValidationError, InvalidPhoneError } from "@/lib/contacts/errors";

const lists = {
  ageBands: DEFAULT_SETTINGS["lists.ageBands"].map((i) => i.key),
  industries: DEFAULT_SETTINGS["lists.industries"].map((i) => i.key),
};

describe("first door", () => {
  it("maps channels to their default door", () => {
    expect(DEFAULT_FIRST_DOOR_BY_CHANNEL.meta_lead_form).toBe("meta_ad");
    expect(DEFAULT_FIRST_DOOR_BY_CHANNEL.website_form).toBe("search_website");
    expect(DEFAULT_FIRST_DOOR_BY_CHANNEL.tagmango_checkout).toBe("other");
    expect(DEFAULT_FIRST_DOOR_BY_CHANNEL.whatsapp_api).toBe("other");
    expect(DEFAULT_FIRST_DOOR_BY_CHANNEL.import).toBe("other");
  });

  it("every default door is a key of the first door list", () => {
    const doors = DEFAULT_SETTINGS["lists.firstDoors"].map((d) => d.key);
    for (const v of Object.values(DEFAULT_FIRST_DOOR_BY_CHANNEL)) expect(doors).toContain(v);
  });

  it("chosen door wins, then referral, then the channel default, then other", () => {
    expect(decideFirstDoor({ firstDoor: "youtube", channel: "meta_lead_form", hasReferrer: true })).toBe("youtube");
    expect(decideFirstDoor({ firstDoor: null, channel: "meta_lead_form", hasReferrer: true })).toBe("referral");
    expect(decideFirstDoor({ firstDoor: "  ", channel: "meta_lead_form", hasReferrer: false })).toBe("meta_ad");
    expect(decideFirstDoor({ channel: "carrier_pigeon", hasReferrer: false })).toBe("other");
  });
});

describe("manual channels", () => {
  it("Quick Add never offers the system-only channels (TagMango checkout, Import)", () => {
    const manual = DEFAULT_SETTINGS["lists.channels"].filter((c) => isManualChannel(c.key)).map((c) => c.key);
    expect(manual).toEqual(["whatsapp_api", "whatsapp_app", "meta_lead_form", "website_form", "phone_call", "walk_in_event"]);
    expect(isManualChannel(null)).toBe(false);
  });
});

describe("names and text", () => {
  it("looseKey ignores case and spacing", () => {
    expect(looseKey("  Mohammed   ALI k ")).toBe("mohammed ali k");
    expect(looseKey(null)).toBe("");
  });

  it("detects a name that is only the phone number", () => {
    const phone = { e164: "+919876543210", international: "+91 98765 43210" };
    expect(isPhoneFallbackName("+91 98765 43210", phone)).toBe(true);
    expect(isPhoneFallbackName("+919876543210", phone)).toBe(true);
    expect(isPhoneFallbackName("", phone)).toBe(true);
    expect(isPhoneFallbackName("Asha", phone)).toBe(false);
  });

  it("cleanText trims and collapses spaces, empty -> null", () => {
    expect(cleanText("  Kochi   city ")).toBe("Kochi city");
    expect(cleanText("   ")).toBeNull();
    expect(cleanText(undefined)).toBeNull();
  });

  it("excerpt cuts long text with an ellipsis on one line", () => {
    expect(excerpt("short\nnote")).toBe("short note");
    const long = "a".repeat(100);
    const e = excerpt(long, 20);
    expect(e.length).toBe(20);
    expect(e.endsWith("…")).toBe(true);
  });

  it("countryCode accepts two letters only", () => {
    expect(countryCode(" ae ")).toBe("AE");
    expect(countryCode("India")).toBeNull();
    expect(countryCode(null)).toBeNull();
  });

  it("isUuid accepts canonical ids only", () => {
    expect(isUuid("0b8f9a52-6f4e-4c1e-9d3a-1f2e3d4c5b6a")).toBe(true);
    expect(isUuid("0B8F9A52-6F4E-4C1E-9D3A-1F2E3D4C5B6A")).toBe(true);
    expect(isUuid("affiliate-77")).toBe(false);
    expect(isUuid(" 0b8f9a52-6f4e-4c1e-9d3a-1f2e3d4c5b6a")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  it("listKeyFor accepts keys or labels, case-insensitively", () => {
    const langs = DEFAULT_SETTINGS["lists.languages"];
    expect(listKeyFor(langs, "ml")).toBe("ml");
    expect(listKeyFor(langs, "malayalam")).toBe("ml");
    expect(listKeyFor(langs, "Klingon")).toBeNull();
    expect(listKeyFor(DEFAULT_SETTINGS["lists.ageBands"], "35 to 44")).toBe("35-44");
  });
});

describe("ratings", () => {
  it("validates ranges", () => {
    expect(ratingValueError("aiLevel", 0, lists)).toBeNull();
    expect(ratingValueError("aiLevel", 5, lists)).toBeNull();
    expect(ratingValueError("aiLevel", 6, lists)).toMatch(/0 to 5/);
    expect(ratingValueError("aiLevel", 2.5, lists)).not.toBeNull();
    expect(ratingValueError("umerLevel", -1, lists)).not.toBeNull();
    expect(ratingValueError("spendingBand", 0, lists)).toMatch(/1 to 5/);
    expect(ratingValueError("spendingBand", 5, lists)).toBeNull();
    expect(ratingValueError("gutStars", 0, lists)).not.toBeNull();
    expect(ratingValueError("gutStars", 1, lists)).toBeNull();
    expect(ratingValueError("ageBand", "35-44", lists)).toBeNull();
    expect(ratingValueError("ageBand", "35 to 44", lists)).not.toBeNull();
    expect(ratingValueError("industry", "business_owner", lists)).toBeNull();
    expect(ratingValueError("industry", "astronaut", lists)).not.toBeNull();
  });

  it("sanitizeRatings drops invalid and missing values", () => {
    expect(sanitizeRatings({ aiLevel: 9, umerLevel: 3, ageBand: "nope", spendingBand: null }, lists)).toEqual({ umerLevel: 3 });
    expect(sanitizeRatings(undefined, lists)).toEqual({});
  });

  it("sales overrides anything; self and import never override sales", () => {
    expect(ratingMayOverwrite(undefined, "self")).toBe(true);
    expect(ratingMayOverwrite("self", "self")).toBe(true);
    expect(ratingMayOverwrite("import", "self")).toBe(true);
    expect(ratingMayOverwrite("sales", "self")).toBe(false);
    expect(ratingMayOverwrite("sales", "import")).toBe(false);
    expect(ratingMayOverwrite("sales", "sales")).toBe(true);
    expect(ratingMayOverwrite("self", "sales")).toBe(true);
  });
});

describe("arrays and dates", () => {
  it("addUnique keeps order, skips duplicates, blanks and excluded values", () => {
    expect(addUnique(["a", "b"], ["b", "c", null, "", "d"], ["d"])).toEqual(["a", "b", "c"]);
  });

  it("removeAdded removes only what was added", () => {
    // before [a], merge made [a, x, y], someone later added z
    expect(removeAdded(["a", "x", "y", "z"], ["a"], ["a", "x", "y"])).toEqual(["a", "z"]);
  });

  it("laterOf / earlierOf are null-safe", () => {
    const a = new Date("2026-01-01");
    const b = new Date("2026-02-01");
    expect(laterOf(a, b)).toBe(b);
    expect(laterOf(null, a)).toBe(a);
    expect(laterOf(a, null)).toBe(a);
    expect(earlierOf(a, b)).toBe(a);
    expect(earlierOf(undefined, undefined)).toBeNull();
  });

  it("orderedPair is stable", () => {
    expect(orderedPair("b", "a")).toEqual(["a", "b"]);
    expect(orderedPair("a", "b")).toEqual(["a", "b"]);
  });
});

describe("follow-up reason", () => {
  it("says who set it and why", () => {
    expect(followUpReason({ type: "call", summary: "Asked for the brochure" })).toBe(
      "Follow-up you set after a call: Asked for the brochure",
    );
    expect(followUpReason({ type: "support_issue", summary: null, outcomeLabel: "Resolved", setByName: "Sam" })).toBe(
      "Follow-up set by Sam after a support issue: Resolved",
    );
    expect(followUpReason({ type: "whatsapp" })).toBe("Follow-up you set after a WhatsApp chat");
  });
});

describe("assignment team", () => {
  const cfg = DEFAULT_SETTINGS.assignment;
  it("GCC numbers go to Dubai, everything else to Kerala", () => {
    for (const cc of ["AE", "SA", "QA", "KW", "BH", "OM", "ae"]) expect(teamForCountry(cc, cfg)).toBe("dubai");
    expect(teamForCountry("IN", cfg)).toBe("kerala");
    expect(teamForCountry("US", cfg)).toBe("kerala");
    expect(teamForCountry(null, cfg)).toBe("kerala");
  });
});

describe("errors", () => {
  it("are typed and carry a field", () => {
    const e = new InvalidPhoneError("123");
    expect(e).toBeInstanceOf(ContactError);
    expect(e.code).toBe("invalid_phone");
    expect(e.field).toBe("phone");
    expect(e.message).toContain("123");
    expect(new ContactValidationError("x", "name").field).toBe("name");
  });
});

describe("placeSuggestionList (city / state search dropdowns)", () => {
  it("proper-cases the built-in names, adds typed ones, merges spellings that differ only in case or spacing", () => {
    const list = placeSuggestionList(["kochi", "new delhi", "thiruvananthapuram"], ["KOCHI", " Malappuram ", "New  Delhi", "Perinthalmanna", ""]);
    expect(list).toEqual(["Kochi", "Malappuram", "New Delhi", "Perinthalmanna", "Thiruvananthapuram"]);
  });

  it("keeps the built-in spelling over a typed variant, and caps the list", () => {
    expect(placeSuggestionList(["kochi"], ["kochi."])).toEqual(["Kochi"]);
    expect(placeSuggestionList(["a", "b", "c"], [], 2)).toEqual(["A", "B"]);
    expect(placeSuggestionList(DEFAULT_SETTINGS.locations.keralaCities, [])).toContain("Kozhikode");
  });
});

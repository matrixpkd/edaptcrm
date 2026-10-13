import { describe, expect, it } from "vitest";
import {
  ageBandFrom,
  applyMapping,
  cleanName,
  cleanPhones,
  cleanRow,
  countryFromText,
  detectCurrency,
  parseAmount,
  parseBool,
  parseDate,
  paymentModeFrom,
  resolveOwner,
  resolveProduct,
  splitEmails,
  splitPhones,
  type CleanContext,
} from "@/lib/import/clean";
import { presetDefaults } from "@/lib/import/presets";
import { DEFAULT_SETTINGS } from "@/lib/settings/defaults";

const NOW = new Date("2026-10-13T06:00:00Z");

function ctx(over: Partial<CleanContext> = {}, defaults = presetDefaults("other")): CleanContext {
  return {
    defaults,
    now: NOW,
    timeZone: "Asia/Kolkata",
    lists: {
      firstDoors: DEFAULT_SETTINGS["lists.firstDoors"],
      campaigns: DEFAULT_SETTINGS["lists.campaigns"],
      languages: DEFAULT_SETTINGS["lists.languages"],
      ageBands: DEFAULT_SETTINGS["lists.ageBands"],
      industries: DEFAULT_SETTINGS["lists.industries"],
      families: DEFAULT_SETTINGS["ladder.families"],
    },
    currencies: ["INR", "AED", "USD"],
    users: [
      { id: "u1", name: "Sales One", email: "sales.one@edapt.test", role: "sales", active: true },
      { id: "u2", name: "Sales Two", email: "sales.two@edapt.test", role: "sales", active: true },
      { id: "u3", name: "Gone Person", email: "gone@edapt.test", role: "sales", active: false },
      { id: "u4", name: "Support Sam", email: "sam@edapt.test", role: "support", active: true },
    ],
    products: [
      { id: "p1", name: "AI Workshop", family: "workshop", externalIds: ["mango-123"] },
      { id: "p2", name: "Applied AI Mastery", family: "applied_ai_mastery", externalIds: [] },
    ],
    ...over,
  };
}

/** Local calendar date of an instant in IST. */
function ist(d: Date | null) {
  if (!d) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

describe("import clean: phones", () => {
  it("normalises Indian numbers written every way", () => {
    for (const raw of ["9847012345", "098470 12345", "+91 98470-12345", "919847012345", "0091 9847012345", "9847012345.0"]) {
      expect(cleanPhones([raw], [], { defaultCountry: "IN" }).phone, raw).toBe("+919847012345");
    }
  });

  it("turns a UAE 05X number into +971 even with India as the default country", () => {
    const r = cleanPhones(["050 123 4567"], [], { defaultCountry: "IN" });
    expect(r.phone).toBe("+971501234567");
    expect(r.country).toBe("AE");
    expect(cleanPhones(["055-7654321"], [], { defaultCountry: "AE" }).phone).toBe("+971557654321");
  });

  it("joins a separate dial code back on (TagMango sends it apart)", () => {
    expect(cleanPhones(["0501234567"], [], { dialCode: "971", defaultCountry: "IN" }).phone).toBe("+971501234567");
    expect(cleanPhones(["501234567"], [], { dialCode: "+971" }).phone).toBe("+971501234567");
    expect(cleanPhones(["9847012345"], [], { dialCode: "91" }).phone).toBe("+919847012345");
    // the number already carries the code: not added twice
    expect(cleanPhones(["919847012345"], [], { dialCode: "91" }).phone).toBe("+919847012345");
  });

  it("keeps extra numbers in one cell and alternate columns as alternates", () => {
    expect(splitPhones("98470 12345 / 94470 54321")).toEqual(["98470 12345", "94470 54321"]);
    const r = cleanPhones(["98470 12345 / 94470 54321"], ["+971 50 123 4567"], { defaultCountry: "IN" });
    expect(r.phone).toBe("+919847012345");
    expect(r.alt).toEqual(["+919447054321", "+971501234567"]);
  });

  it("reports invalid numbers instead of guessing", () => {
    const r = cleanPhones(["12345"], [], { defaultCountry: "IN" });
    expect(r.phone).toBeNull();
    expect(r.invalid).toEqual(["12345"]);
  });
});

describe("import clean: names and emails", () => {
  it("puts names in proper case", () => {
    expect(cleanName("MOHAMMED ali k")).toBe("Mohammed Ali K");
    expect(cleanName("  anjali   nair ")).toBe("Anjali Nair");
    expect(cleanName("o'brien-smith")).toBe("O'Brien-Smith");
  });

  it("does not take numbers or emails as names", () => {
    expect(cleanName("9847012345")).toBeNull();
    expect(cleanName("anil@example.com")).toBeNull();
    expect(cleanName("")).toBeNull();
  });

  it("lower-cases emails and splits several in one cell", () => {
    expect(splitEmails("Anil.Kumar@Example.COM")).toEqual({ valid: ["anil.kumar@example.com"], invalid: [] });
    expect(splitEmails("a@x.com; B@Y.com, not-an-email")).toEqual({ valid: ["a@x.com", "b@y.com"], invalid: ["not-an-email"] });
  });
});

describe("import clean: dates", () => {
  it("reads dd/mm/yyyy as Indian by default", () => {
    expect(ist(parseDate("03/04/2025"))).toBe("2025-04-03");
    expect(ist(parseDate("12-10-2025"))).toBe("2025-10-12");
    expect(ist(parseDate("12.10.25"))).toBe("2025-10-12");
  });

  it("reads mm/dd when asked, and a first part above 12 is always the day", () => {
    expect(ist(parseDate("03/04/2025", { dayFirst: false }))).toBe("2025-03-04");
    expect(ist(parseDate("25/12/2025", { dayFirst: false }))).toBe("2025-12-25");
    expect(ist(parseDate("12/25/2025"))).toBe("2025-12-25");
  });

  it("reads ISO dates, with and without a time and zone", () => {
    expect(ist(parseDate("2025-10-12"))).toBe("2025-10-12");
    expect(parseDate("2025-10-12T10:30:00Z")?.toISOString()).toBe("2025-10-12T10:30:00.000Z");
    // a local time without a zone is IST
    expect(parseDate("2025-10-12 10:30")?.toISOString()).toBe("2025-10-12T05:00:00.000Z");
  });

  it("reads Excel serial numbers", () => {
    expect(ist(parseDate("45942"))).toBe("2025-10-12");
    expect(ist(parseDate(45942))).toBe("2025-10-12");
    expect(parseDate("45942.5")?.toISOString()).toBe("2025-10-12T06:30:00.000Z");
  });

  it("reads written-out dates", () => {
    expect(ist(parseDate("12 Oct 2025"))).toBe("2025-10-12");
    expect(ist(parseDate("12-Oct-25"))).toBe("2025-10-12");
    expect(ist(parseDate("12th October, 2025"))).toBe("2025-10-12");
    expect(ist(parseDate("Oct 12, 2025"))).toBe("2025-10-12");
    expect(ist(parseDate("Sunday, 12 October 2025"))).toBe("2025-10-12");
    expect(parseDate("12 Oct 2025 10:30 PM")?.toISOString()).toBe("2025-10-12T17:00:00.000Z");
  });

  it("dates without a time are noon local, so they show the same day in Kerala and Dubai", () => {
    expect(parseDate("12/10/2025")?.toISOString()).toBe("2025-10-12T06:30:00.000Z");
    expect(parseDate("12/10/2025", { timeZone: "Asia/Dubai" })?.toISOString()).toBe("2025-10-12T08:00:00.000Z");
  });

  it("returns null for anything that is not a real date", () => {
    for (const bad of ["", "soon", "31/02/2025", "13/13/2025", "2025-13-01", "12 Foo 2025", "123"]) {
      expect(parseDate(bad), bad).toBeNull();
    }
  });
});

describe("import clean: amounts and currency", () => {
  it("parses Indian grouping, symbols and lakh / thousand shorthands", () => {
    expect(parseAmount("₹1,20,000")).toEqual({ amount: 120000, currency: "INR" });
    expect(parseAmount("Rs. 999/-")).toEqual({ amount: 999, currency: "INR" });
    expect(parseAmount("1.2L")).toEqual({ amount: 120000, currency: null });
    expect(parseAmount("1.5 lakh")).toEqual({ amount: 150000, currency: null });
    expect(parseAmount("45k")).toEqual({ amount: 45000, currency: null });
    expect(parseAmount("2 cr")).toEqual({ amount: 20000000, currency: null });
    expect(parseAmount("1,200.50")).toEqual({ amount: 1200.5, currency: null });
    expect(parseAmount("12,000 INR")).toEqual({ amount: 12000, currency: "INR" });
  });

  it("detects AED and USD", () => {
    expect(parseAmount("AED 3,500")).toEqual({ amount: 3500, currency: "AED" });
    expect(parseAmount("3500 Dhs")).toEqual({ amount: 3500, currency: "AED" });
    expect(parseAmount("$99")).toEqual({ amount: 99, currency: "USD" });
    expect(parseAmount("USD 1,499")).toEqual({ amount: 1499, currency: "USD" });
  });

  it("free and blank values, negatives and junk", () => {
    expect(parseAmount("Free")).toEqual({ amount: 0, currency: null });
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("-500")).toEqual({ amount: -500, currency: null });
    expect(parseAmount("(500)")).toEqual({ amount: -500, currency: null });
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("12 apples")).toBeNull();
  });

  it("reads a currency cell", () => {
    expect(detectCurrency("₹")).toBe("INR");
    expect(detectCurrency("Rs")).toBe("INR");
    expect(detectCurrency("inr")).toBe("INR");
    expect(detectCurrency("Dirham")).toBe("AED");
    expect(detectCurrency("aed")).toBe("AED");
    expect(detectCurrency("US$")).toBe("USD");
    expect(detectCurrency("EUR")).toBe("EUR");
    expect(detectCurrency("")).toBeNull();
  });
});

describe("import clean: places, lists, owners, products", () => {
  it("countries from names, codes and nicknames", () => {
    expect(countryFromText("India")).toBe("IN");
    expect(countryFromText("UAE")).toBe("AE");
    expect(countryFromText("u.a.e.")).toBe("AE");
    expect(countryFromText("United Arab Emirates")).toBe("AE");
    expect(countryFromText("ksa")).toBe("SA");
    expect(countryFromText("qa")).toBe("QA");
    expect(countryFromText("Germany")).toBe("DE");
    expect(countryFromText("Narnia")).toBeNull();
  });

  it("age bands from ranges and ages", () => {
    const bands = DEFAULT_SETTINGS["lists.ageBands"];
    expect(ageBandFrom("35-44", bands)).toBe("35-44");
    expect(ageBandFrom("35 to 44", bands)).toBe("35-44");
    expect(ageBandFrom("38", bands)).toBe("35-44");
    expect(ageBandFrom("70 yrs", bands)).toBe("65+");
    expect(ageBandFrom("12", bands)).toBeNull();
  });

  it("yes/no and payment modes", () => {
    expect(parseBool("Yes")).toBe(true);
    expect(parseBool("opted out")).toBe(false);
    expect(parseBool("maybe")).toBeNull();
    expect(paymentModeFrom("Google Pay")).toBe("upi_qr");
    expect(paymentModeFrom("NEFT")).toBe("bank_transfer");
    expect(paymentModeFrom("Razorpay")).toBe("tagmango");
    expect(paymentModeFrom("Cash")).toBe("cash");
    expect(paymentModeFrom("barter")).toBeNull();
  });

  it("matches owners by email or name, never support or inactive people", () => {
    const users = ctx().users;
    expect(resolveOwner("Sales One", users)).toEqual({ id: "u1" });
    expect(resolveOwner("SALES.TWO@edapt.test", users)).toEqual({ id: "u2" });
    expect(resolveOwner("Gone Person", users)).toEqual({ warning: "Gone Person cannot own contacts (inactive or support)" });
    expect(resolveOwner("Support Sam", users)).toMatchObject({ warning: expect.stringContaining("cannot own") });
    expect(resolveOwner("Nobody", users)).toEqual({ warning: 'Owner "Nobody" is not a team member' });
  });

  it("finds products in the catalogue, by TagMango id, by the step 2 choice, or by family", () => {
    const c = ctx();
    expect(resolveProduct("ai workshop", null, c)).toEqual({ productId: "p1", family: "workshop", productName: "ai workshop" });
    expect(resolveProduct("mango-123", null, c)).toMatchObject({ productId: "p1" });
    expect(resolveProduct("Mystery course", null, c)).toEqual({ error: 'No product family for "Mystery course": choose one in step 2' });
    const mapped = ctx({ defaults: { ...presetDefaults("other"), productMap: { "mystery course": { family: "premium" } } } });
    expect(resolveProduct("Mystery course", null, mapped)).toEqual({ productId: null, family: "premium", productName: "Mystery course" });
    const fallback = ctx({ defaults: { ...presetDefaults("delegation") } });
    expect(resolveProduct(null, null, fallback)).toEqual({ productId: null, family: "delegation", productName: "Delegation (legacy)" });
  });
});

describe("import clean: a whole row", () => {
  const headers = ["Order ID", "First Name", "Last Name", "Dial", "Phone", "Email", "Mango", "Amount", "Date", "Remarks", "Comments"];
  const mapping = {
    "Order ID": "order_id",
    "First Name": "name",
    "Last Name": "name",
    Dial: "dial_code",
    Phone: "phone",
    Email: "email",
    Mango: "product",
    Amount: "amount",
    Date: "purchased_at",
    Remarks: "notes",
    Comments: "notes",
  } as const;

  it("maps, joins first + last name and labels several note columns", () => {
    const m = applyMapping(
      { "Order ID": "TM-1", "First Name": "anil", "Last Name": "KUMAR", Dial: "91", Phone: "9847012345", Remarks: "VIP", Comments: "Call after 6" },
      mapping,
      headers,
    );
    expect(m.name).toBe("anil KUMAR");
    expect(m.notes).toBe("Remarks: VIP\nComments: Call after 6");
    expect(m.phone).toBe("9847012345");
  });

  it("cleans a TagMango order into a contact and a verified-ready purchase", () => {
    const m = applyMapping(
      {
        "Order ID": " TM-1 ",
        "First Name": "ANIL",
        "Last Name": "kumar",
        Dial: "91",
        Phone: "98470 12345",
        Email: "Anil@Example.com",
        Mango: "AI Workshop",
        Amount: "₹999",
        Date: "12/10/2025",
      },
      mapping,
      headers,
    );
    const r = cleanRow(m, ctx({}, presetDefaults("tagmango")));
    expect(r.valid).toBe(true);
    expect(r.phone).toBe("+919847012345");
    expect(r.name).toBe("Anil Kumar");
    expect(r.email).toBe("anil@example.com");
    expect(r.purchase).toMatchObject({ productId: "p1", family: "workshop", amount: 999, currency: "INR", orderId: "TM-1", paymentMode: "tagmango" });
    expect(ist(new Date(r.purchase!.purchasedAt!))).toBe("2025-10-12");
  });

  it("an amount without a date or product makes the row invalid with clear reasons", () => {
    const r = cleanRow({ phone: "9847012345", amount: "999", product: "Mystery" }, ctx());
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("No purchase date for the payment: map a date column, or set the amount column to Ignore");
    expect(r.errors).toContain('No product family for "Mystery": choose one in step 2');
  });

  it("no valid phone and no email is invalid; missing fields stay empty", () => {
    const r = cleanRow({ name: "Someone", phone: "12345" }, ctx());
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(["No valid phone or email"]);
    expect(r.warnings).toEqual(['"12345" is not a valid phone number']);
    expect(r.city).toBeNull();
    expect(r.purchase).toBeNull();
  });

  it("an email alone is enough to be valid (matching decides later)", () => {
    expect(cleanRow({ email: "x@y.com" }, ctx()).valid).toBe(true);
  });

  it("applies the defaults: first door, campaign, tags, campaign as tag", () => {
    const d = { ...presetDefaults("program_sheet"), campaign: "koduvally_ai_literacy", tags: ["B2B"] };
    const r = cleanRow({ phone: "9847012345" }, ctx({}, d));
    expect(r.firstDoor).toBe("mla_program");
    expect(r.campaign).toBe("koduvally_ai_literacy");
    expect(r.tags).toEqual(["B2B", "Koduvally AI Literacy Mission"]);
  });

  it("a first door from the file must be in the list; unknown values warn and fall back", () => {
    expect(cleanRow({ phone: "9847012345", first_door: "YouTube" }, ctx()).firstDoor).toBe("youtube");
    const r = cleanRow({ phone: "9847012345", first_door: "Facebook" }, ctx({}, presetDefaults("delegation")));
    expect(r.firstDoor).toBe("delegation");
    expect(r.warnings[0]).toContain('First door "Facebook" is not in the list');
  });

  it("a currency without a rate in Settings is an error, a future date too", () => {
    expect(cleanRow({ phone: "9847012345", amount: "EUR 10", currency: "EUR", purchased_at: "2025-01-01", family: "workshop" }, ctx()).errors).toContain(
      "No exchange rate for EUR in Settings",
    );
    expect(cleanRow({ phone: "9847012345", amount: "10", purchased_at: "2027-01-01", family: "workshop" }, ctx()).errors[0]).toContain("in the future");
  });

  it("an owner from the file, with a warning when it is unknown", () => {
    expect(cleanRow({ phone: "9847012345", owner: "sales one" }, ctx()).ownerId).toBe("u1");
    const r = cleanRow({ phone: "9847012345", owner: "Mystery Rep" }, ctx());
    expect(r.ownerId).toBeNull();
    expect(r.warnings[0]).toContain("owner fallback");
  });
});

describe("import clean: when the touch happened", () => {
  it("dates the row from its enquiry date column, else the batch's records date, else leaves it unknown", () => {
    const own = cleanRow({ phone: "9847012345", enquired_at: "15/08/2025" }, ctx());
    expect(own.touchedAt).toBe("2025-08-15T06:30:00.000Z");
    expect(own.warnings).toEqual([]);

    const batch = cleanRow({ phone: "9847012345" }, ctx({}, { ...presetDefaults("program_sheet"), recordsDate: "2025-07-01" }));
    expect(batch.touchedAt).toBe("2025-07-01T06:30:00.000Z");

    // the row's own date wins over the batch date
    const both = cleanRow({ phone: "9847012345", enquired_at: "2025-08-15" }, ctx({}, { ...presetDefaults("other"), recordsDate: "2025-07-01" }));
    expect(both.touchedAt).toBe("2025-08-15T06:30:00.000Z");

    expect(cleanRow({ phone: "9847012345" }, ctx()).touchedAt).toBeNull();
  });

  it("an unreadable or future enquiry date is dropped with a warning, never guessed (the row stays valid)", () => {
    const bad = cleanRow({ phone: "9847012345", enquired_at: "sometime last year" }, ctx());
    expect(bad.valid).toBe(true);
    expect(bad.touchedAt).toBeNull();
    expect(bad.warnings).toContain('Enquiry date "sometime last year" is not a date');
    const future = cleanRow({ phone: "9847012345", enquired_at: "2099-01-01" }, ctx());
    expect(future.touchedAt).toBeNull();
    expect(future.warnings.join(" ")).toContain("in the future");
  });
});

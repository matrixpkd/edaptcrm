import { describe, expect, it } from "vitest";
import { personQuotes, quotesPerson, withoutPersonQuotes, type ImportRowParts } from "@/lib/import/erasure";

const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";
const person = { names: ["Priya Nair", "Priya N"], phones: ["+919847100001"] };
const quotes = personQuotes(person);
const ctx = { ids: new Set([P]), quotes, referrerHeaders: ["Referred By"] };

function row(over: Partial<ImportRowParts> = {}): ImportRowParts {
  return { raw: { Name: "Anil Kumar" }, mapped: { name: "Anil Kumar" }, cleaned: { name: "Anil Kumar" }, issues: [], applied: { contactId: Q }, ...over };
}

describe("import rows quoting an erased person", () => {
  it("finds their number and the phrases that name them, and nothing else", () => {
    for (const text of [
      "+919847100001 belongs to Priya Nair, so it was not added",
      "+919847100001 belongs to Priya Nair, so it was not added to Anil Kumar",
      "Order TM-1 is already recorded on Priya Nair",
      "This payment (AI Workshop) is already recorded on Priya N: not recorded again",
      "This TagMango order (TM-1) is already recorded on Priya Nair.",
      '"+919847100001" is not a valid phone number',
    ]) {
      expect(quotesPerson(text, quotes), text).toBe(true);
    }
    for (const text of [
      // a namesake whose name only starts like hers, a longer number, someone else
      "+919847100002 belongs to Priya Nairobi, so it was not added",
      "Order TM-1 is already recorded on Priya Nairobi",
      "+9198471000019 belongs to Ravi, so it was not added",
      "Same order id as row 3",
      "Priya Nair is a common name",
    ]) {
      expect(quotesPerson(text, quotes), text).toBe(false);
    }
  });

  it("takes the quote off another contact's row and keeps the rest of it", () => {
    const issues = ["+919847100001 belongs to Priya Nair, so it was not added", "Language \"Tamil\" is not in the list"];
    const candidates = [
      { id: Q, name: "Priya Nair", phone: "+919847100009", city: "Kochi" },
      { id: P, name: "Priya Nair", phone: "+919847100001", city: "Kochi" },
    ];
    const before = row({
      issues,
      cleaned: { name: "Priya Nair", match: { by: "name_city", candidates, contactName: "Priya Nair" } },
      applied: { contactId: Q, purchaseSkipped: "This TagMango order (TM-1) is already recorded on Priya Nair.", purchaseId: null },
    });
    expect(withoutPersonQuotes(before, ctx)).toEqual({
      raw: before.raw,
      mapped: before.mapped,
      cleaned: { name: "Priya Nair", match: { by: "name_city", candidates: [candidates[0]], contactName: "Priya Nair" } },
      issues: ['Language "Tamil" is not in the list'],
      applied: { contactId: Q, purchaseId: null },
    });
  });

  it("drops their name as the row's matched contact: a conflict's first candidate, or the contact a merge row matched", () => {
    const hers = { id: P, name: "Priya Nair", phone: "+919847100001", city: "Kochi" };
    const namesake = { id: Q, name: "Priya Nair", phone: "+919847100009", city: "Kochi" };
    // a conflict imported as someone new, or merged into the second candidate: the row is not hers
    for (const matchContactId of [P, Q]) {
      const before = row({ cleaned: { name: "Priya Nair", match: { by: "name_city", candidates: [hers, namesake], contactName: "Priya Nair" } } });
      expect(withoutPersonQuotes({ ...before, matchContactId }, ctx)).toEqual({
        ...before,
        cleaned: { name: "Priya Nair", match: { by: "name_city", candidates: [namesake] } },
      });
    }
    // a merge row that matched her and went to another contact
    const merged = row({ cleaned: { name: "Anil Kumar", match: { by: "phone", contactName: "Priya Nair" } } });
    expect(withoutPersonQuotes({ ...merged, matchContactId: P }, ctx)).toEqual({ ...merged, cleaned: { name: "Anil Kumar", match: { by: "phone" } } });
    // a conflict with an earlier row of the file: the name is that row's, not a contact's
    const earlier = row({ cleaned: { name: "Priya Nair", match: { by: "name_city", conflictRow: 2, contactName: "Priya Nair" } } });
    expect(withoutPersonQuotes({ ...earlier, matchContactId: null }, ctx)).toBeNull();
  });

  it("drops the referrer columns of a row that named them as referrer", () => {
    const before = row({
      raw: { Name: "Meera Das", "Referred By": "98471 00001" },
      mapped: { name: "Meera Das", referrer_phone: "98471 00001", referrer_name: "Priya" },
      cleaned: { name: "Meera Das", referrer: { phone: "98471 00001", name: "Priya" } },
      applied: { contactId: Q, referrerId: P },
    });
    expect(withoutPersonQuotes(before, ctx)).toEqual({
      raw: { Name: "Meera Das" },
      mapped: { name: "Meera Das" },
      cleaned: { name: "Meera Das", referrer: null },
      issues: [],
      applied: { contactId: Q, referrerId: P },
    });
  });

  it("leaves a row that does not quote them alone", () => {
    expect(withoutPersonQuotes(row({ issues: ["Same order id as row 3"], applied: { contactId: Q, referrerId: Q } }), ctx)).toBeNull();
  });
});

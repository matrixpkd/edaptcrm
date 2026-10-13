import { describe, expect, it } from "vitest";
import { normalizePhone } from "@/lib/phone";
import { CITIES, countryOfPhone, createRng, makePerson, mobileNumber, newPersonPool, tagmangoOrderId, utr } from "../../scripts/seed-data";

describe("seed data generator", () => {
  it("is deterministic for a seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    const pa = newPersonPool();
    const pb = newPersonPool();
    for (let i = 0; i < 50; i++) expect(makePerson(a, pa)).toEqual(makePerson(b, pb));
    expect(makePerson(createRng(1), newPersonPool())).not.toEqual(makePerson(createRng(2), newPersonPool()));
  });

  it("makes valid, unique mobile numbers in the city's country", () => {
    const r = createRng(7);
    const pool = newPersonPool();
    const people = Array.from({ length: 2000 }, () => makePerson(r, pool));
    const phones = new Set(people.map((p) => p.phone));
    expect(phones.size).toBe(people.length);
    for (const p of people) {
      const np = normalizePhone(p.phone);
      expect(np?.e164).toBe(p.phone);
      const country = countryOfPhone(p.phone);
      expect(np?.country).toBe(country);
      // Gulf residents mostly have a Gulf number; a few keep their Indian one
      if (p.region !== "gcc") expect(country).toBe("IN");
    }
    const gcc = people.filter((p) => p.region === "gcc");
    expect(gcc.filter((p) => countryOfPhone(p.phone) === p.country).length / gcc.length).toBeGreaterThan(0.9);
  });

  it("keeps name + city unique unless asked, and names never repeat a word", () => {
    const r = createRng(3);
    const pool = newPersonPool();
    const people = Array.from({ length: 1500 }, () => makePerson(r, pool));
    expect(new Set(people.map((p) => `${p.name}|${p.city}`)).size).toBe(people.length);
    for (const p of people) {
      const words = p.name.split(" ");
      expect(new Set(words).size).toBe(words.length);
    }
    const twin = makePerson(createRng(3), pool, { allowSameNameCity: true });
    expect(twin.phone).not.toBe(people[0].phone);
  });

  it("draws mostly from Kerala and the Gulf, with Malayalam the common language", () => {
    const r = createRng(11);
    const pool = newPersonPool();
    const people = Array.from({ length: 3000 }, () => makePerson(r, pool));
    const share = (f: (p: (typeof people)[number]) => boolean) => people.filter(f).length / people.length;
    expect(share((p) => p.region === "kerala")).toBeGreaterThan(0.5);
    expect(share((p) => p.region === "gcc")).toBeGreaterThan(0.15);
    expect(share((p) => p.language === "ml")).toBeGreaterThan(0.6);
    expect(CITIES.every((c) => c.region !== "gcc" || c.state === null)).toBe(true);
  });

  it("never hands out the same number twice", () => {
    const r = createRng(5);
    const used = new Set<string>();
    for (let i = 0; i < 500; i++) mobileNumber(r, "AE", used);
    expect(used.size).toBe(500);
    for (const n of used) expect(n.startsWith("+9715")).toBe(true);
  });

  it("makes references in the shape the CRM expects", () => {
    const r = createRng(9);
    expect(tagmangoOrderId(r, new Date("2026-10-01T10:00:00Z"))).toMatch(/^[0-9a-f]{24}$/);
    expect(utr(r, "upi_qr")).toMatch(/^[345]\d{11}$/);
    expect(utr(r, "bank_transfer")).toMatch(/^[A-Z]{4}N\d{11}$/);
  });
});

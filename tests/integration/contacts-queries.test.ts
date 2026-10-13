import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts, type Contact, type Role } from "@/db/schema";
import { captureEnquiry } from "@/lib/contacts/capture";
import { ContactConflictError, ContactForbiddenError, ContactValidationError } from "@/lib/contacts/errors";
import { logInteraction } from "@/lib/contacts/interactions";
import { setManualStage } from "@/lib/contacts/lifecycle";
import { flagPossibleDuplicates } from "@/lib/contacts/identity";
import { mergeContacts } from "@/lib/contacts/merge";
import { createOrganisation, updateOrganisation } from "@/lib/contacts/organisations";
import { applyRating, updateContactProfile } from "@/lib/contacts/profile";
import { setOwner } from "@/lib/contacts/assignment";
import {
  activeFilterCount,
  channelUsage,
  countPossibleDuplicates,
  createSavedView,
  deleteSavedView,
  filtersToQuery,
  getContactHeader,
  getContactReferrals,
  getContactTimeline,
  getMergeHistory,
  getOrganisation,
  getOrganisationPeople,
  getOrganisationPurchases,
  listContacts,
  listOrganisations,
  listSavedViews,
  parseContactFilters,
  parsePage,
  searchContactsForPicker,
  type ContactFilters,
} from "@/lib/contacts/queries";
import { recordPurchase } from "@/lib/money";
import { makeUser, resetDb } from "../support/db";

let seq = 0;
const inPhone = () => `98471${String(10000 + seq++).padStart(5, "0")}`;

type CaptureOver = Partial<Parameters<typeof captureEnquiry>[0]>;
async function newContact(over: CaptureOver = {}): Promise<Contact> {
  const r = await captureEnquiry({
    phone: inPhone(),
    name: `Person ${seq}`,
    channel: "phone_call",
    firstDoor: "youtube",
    skipAlerts: true,
    skipAssignment: true,
    ...over,
  });
  return r.contact;
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const list = (user: { id: string; role: Role }, f: ContactFilters = {}, page = 1, pageSize = 50) =>
  listContacts(user, f, { page, pageSize });

describe("contacts read models", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("visibility", () => {
    it("a salesperson sees their own contacts and the pool, never a colleague's; managers and support see all", async () => {
      const asha = await makeUser({ role: "sales", name: "Asha" });
      const biju = await makeUser({ role: "sales", name: "Biju" });
      const manager = await makeUser({ role: "manager" });
      const support = await makeUser({ role: "support" });
      const mine = await newContact({ ownerId: asha.id });
      const theirs = await newContact({ ownerId: biju.id });
      const pool = await newContact();

      const forAsha = await list(asha);
      expect(ids(forAsha.rows)).toEqual(ids([mine, pool]));
      expect(forAsha.total).toBe(2);
      expect(forAsha.rows.find((r) => r.id === mine.id)?.ownerName).toBe("Asha");

      // even asking for the colleague's contacts by owner id or by their exact phone returns nothing
      expect((await list(asha, { owner: biju.id })).total).toBe(0);
      expect((await list(asha, { q: theirs.phoneE164 })).total).toBe(0);
      expect(await searchContactsForPicker(asha, theirs.phoneE164)).toEqual([]);

      expect((await list(manager)).total).toBe(3);
      expect((await list(support)).total).toBe(3);
      expect(ids((await list(manager, { owner: "pool" })).rows)).toEqual([pool.id]);
      expect(ids((await list(asha, { owner: "mine" })).rows)).toEqual([mine.id]);
    });

    it("hides merged records", async () => {
      const admin = await makeUser({ role: "admin" });
      const winner = await newContact({ name: "Chitra Nair" });
      const loser = await newContact({ name: "Chitra N" });
      await mergeContacts(winner.id, loser.id, admin, "same person");
      const all = await list(admin);
      expect(ids(all.rows)).toEqual([winner.id]);
      // the loser's number now finds the winner (it became an alternate)
      expect(ids((await list(admin, { q: loser.phoneE164.slice(-6) })).rows)).toEqual([winner.id]);
      const history = await getMergeHistory(winner.id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        role: "winner",
        otherId: loser.id,
        otherName: "Chitra N",
        mergedByName: admin.name,
      });
    });
  });

  describe("search", () => {
    it("finds by partial phone digits, by any written form of the number, by name and by email", async () => {
      const admin = await makeUser({ role: "admin" });
      const deepa = await newContact({ phone: "9847012345", name: "Deepa Menon", email: "deepa@example.com" });
      const uae = await newContact({ phone: "+971501234567", name: "Faisal" });
      await newContact({ phone: "9895000000", name: "Someone Else" });

      expect(ids((await list(admin, { q: "70123" })).rows)).toEqual([deepa.id]);
      expect(ids((await list(admin, { q: "+91 98470 12345" })).rows)).toEqual([deepa.id]);
      expect(ids((await list(admin, { q: "098470-12345" })).rows)).toEqual([deepa.id]);
      // a UAE number typed the local way (05X ...) is normalised to +971 5X ...
      expect(ids((await list(admin, { q: "050 123 4567" })).rows)).toEqual([uae.id]);
      expect(ids((await list(admin, { q: "menon" })).rows)).toEqual([deepa.id]);
      expect(ids((await list(admin, { q: "DEEPA@EXAMPLE" })).rows)).toEqual([deepa.id]);
      // like-wildcards typed by the user are literal
      expect((await list(admin, { q: "%" })).total).toBe(0);
    });

    it("matches alternate numbers", async () => {
      const admin = await makeUser({ role: "admin" });
      const c = await newContact({ name: "Gopal" });
      await updateContactProfile(c.id, { altPhones: { add: ["9847099999"] } }, admin);
      expect(ids((await list(admin, { q: "7099999" })).rows)).toEqual([c.id]);
    });
  });

  describe("filters, sort and pagination", () => {
    it("filters by grade, stage, first door, channel, campaign, tag, language, country, family, at risk and unrated", async () => {
      const admin = await makeUser({ role: "admin" });
      const sales = await makeUser({ role: "sales" });
      const a = await newContact({
        firstDoor: "mla_program",
        campaign: "koduvally_ai_literacy",
        tags: ["VIP"],
        profile: { language: "en" },
      });
      const b = await newContact({ channel: "whatsapp_app", phone: "+971501112233" });
      const c = await newContact({ firstDoor: "delegation" });
      await recordPurchase(
        {
          contactId: c.id,
          productName: "Prompting workshop",
          family: "workshop",
          amount: 999,
          currency: "INR",
          mode: "cash",
          source: "manual",
          verified: true,
        },
        admin,
      );
      await setManualStage(b.id, "lost", { lostReason: "price" }, admin);
      await applyRating(a.id, { gutStars: 4 }, "sales", sales.id);
      await applyRating(b.id, { umerLevel: 2 }, "self", null);
      // calculated columns are written by recompute; set them last so the services above do not overwrite them
      await db.update(contacts).set({ grade: "A", edaptScore: 80, atRisk: true }).where(eq(contacts.id, a.id));
      await db.update(contacts).set({ grade: "C", edaptScore: 45 }).where(eq(contacts.id, b.id));

      expect(ids((await list(admin, { grades: ["A"] })).rows)).toEqual([a.id]);
      expect(ids((await list(admin, { grades: ["A", "C"] })).rows)).toEqual(ids([a, b]));
      expect(ids((await list(admin, { stages: ["lost"] })).rows)).toEqual([b.id]);
      expect(ids((await list(admin, { firstDoor: "mla_program" })).rows)).toEqual([a.id]);
      expect(ids((await list(admin, { channel: "whatsapp_app" })).rows)).toEqual([b.id]);
      expect(ids((await list(admin, { campaign: "koduvally_ai_literacy" })).rows)).toEqual([a.id]);
      expect(ids((await list(admin, { tag: "VIP" })).rows)).toEqual([a.id]);
      expect(ids((await list(admin, { language: "en" })).rows)).toEqual([a.id]);
      expect(ids((await list(admin, { country: "AE" })).rows)).toEqual([b.id]);
      expect(ids((await list(admin, { family: "workshop" })).rows)).toEqual([c.id]);
      expect(ids((await list(admin, { atRisk: true })).rows)).toEqual([a.id]);
      // a self-rating does not count as rated
      expect(ids((await list(admin, { unrated: true })).rows)).toEqual(ids([b, c]));
      // filters combine
      expect((await list(admin, { grades: ["A"], tag: "VIP", firstDoor: "youtube" })).total).toBe(0);
    });

    it("sorts by score, LTV, created and name, and pages 50 at a time with a total", async () => {
      const admin = await makeUser({ role: "admin" });
      const made: Contact[] = [];
      for (let i = 0; i < 7; i++) made.push(await newContact({ name: `Zed ${String.fromCharCode(71 - i)}` }));
      await db.update(contacts).set({ edaptScore: 90 }).where(eq(contacts.id, made[3].id));
      await db.update(contacts).set({ ltvInr: 5000 }).where(eq(contacts.id, made[5].id));

      expect((await list(admin, { sort: "score" })).rows[0].id).toBe(made[3].id);
      expect((await list(admin, { sort: "ltv" })).rows[0].id).toBe(made[5].id);
      expect((await list(admin, { sort: "name" })).rows[0].name).toBe("Zed A");

      const p1 = await list(admin, { sort: "created" }, 1, 3);
      const p3 = await list(admin, { sort: "created" }, 3, 3);
      expect(p1).toMatchObject({ total: 7, pageCount: 3, page: 1 });
      expect(p1.rows).toHaveLength(3);
      expect(p3.rows).toHaveLength(1);
      const all = [...p1.rows, ...(await list(admin, { sort: "created" }, 2, 3)).rows, ...p3.rows];
      expect(new Set(all.map((r) => r.id)).size).toBe(7);
      // a page past the end is clamped to the last page
      expect((await list(admin, { sort: "created" }, 99, 3)).page).toBe(3);
      // the default page size is 50
      expect((await listContacts(admin, {})).pageSize).toBe(50);
    });

    it("reads filters from the URL and writes them back canonically", () => {
      const f = parseContactFilters(
        new URLSearchParams(
          "q=+deepa+&grade=a&grade=B,X&stage=lost&stage=nope&owner=pool&country=ae&risk=1&sort=bogus&page=3&door=youtube",
        ),
      );
      expect(f).toMatchObject({
        q: "deepa",
        grades: ["A", "B"],
        stages: ["lost"],
        owner: "pool",
        country: "AE",
        atRisk: true,
        unrated: false,
        sort: "score",
        firstDoor: "youtube",
      });
      expect(activeFilterCount(f)).toBe(6);
      expect(filtersToQuery(f)).toBe("q=deepa&grade=A&grade=B&stage=lost&door=youtube&owner=pool&country=AE&risk=1");
      expect(parseContactFilters({ owner: "someone", sort: "ltv" })).toMatchObject({ owner: null, sort: "ltv" });
      expect(parsePage({ page: "0" })).toBe(1);
      expect(parsePage({ page: "4" })).toBe(4);
    });
  });

  describe("saved views", () => {
    it("keeps own views private, shows shared views to everyone and lets only the owner delete", async () => {
      const asha = await makeUser({ role: "sales" });
      const biju = await makeUser({ role: "sales" });
      const manager = await makeUser({ role: "manager" });
      const admin = await makeUser({ role: "admin" });

      const mine = await createSavedView(asha, { name: "My A leads", query: "?grade=A&page=4&junk=1" });
      await createSavedView(biju, { name: "Biju private", query: "stage=new" });
      const shared = await createSavedView(manager, { name: "At risk", query: "risk=1", shared: true });

      const forAsha = await listSavedViews(asha);
      expect(forAsha.map((v) => v.name)).toEqual(["My A leads", "At risk"]);
      expect(forAsha[0]).toMatchObject({ query: "grade=A", mine: true, shared: false });
      expect(forAsha[1]).toMatchObject({ mine: false, shared: true });

      // saving under the same name replaces the view
      const again = await createSavedView(asha, { name: "my a leads", query: "grade=A&grade=B" });
      expect(again).toBe(mine);
      expect((await listSavedViews(asha))[0].query).toBe("grade=A&grade=B");

      await expect(createSavedView(asha, { name: "Everyone", query: "", shared: true })).rejects.toBeInstanceOf(
        ContactForbiddenError,
      );
      await expect(createSavedView(asha, { name: "  ", query: "" })).rejects.toBeInstanceOf(ContactValidationError);

      expect(await deleteSavedView(biju, mine)).toBe(false);
      expect(await deleteSavedView(asha, shared)).toBe(false);
      expect(await deleteSavedView(asha, mine)).toBe(true);
      expect(await deleteSavedView(admin, shared)).toBe(true);
      expect(await listSavedViews(asha)).toEqual([]);
    });
  });

  describe("contact page", () => {
    it("builds the timeline from every touch, newest first, and pages it", async () => {
      const admin = await makeUser({ role: "admin", name: "Umer" });
      const sales = await makeUser({ role: "sales", name: "Asha" });
      const c = await newContact({ name: "Hari", createdById: admin.id, campaign: "claude_mastery_meta" });
      await setOwner(c.id, sales.id, { reason: "Added by hand", changedById: admin.id });
      await logInteraction(c.id, { type: "call", outcome: "connected", summary: "Wants the workshop" }, sales);
      await applyRating(c.id, { aiLevel: 2, gutStars: 4 }, "sales", sales.id);
      await recordPurchase(
        {
          contactId: c.id,
          productName: "AI Workshop",
          family: "workshop",
          amount: 999,
          currency: "INR",
          mode: "cash",
          source: "manual",
          verified: true,
        },
        admin,
      );
      await recordPurchase(
        {
          contactId: c.id,
          productName: "Applied AI Mastery",
          family: "applied_ai_mastery",
          amount: 20000,
          currency: "INR",
          mode: "bank_transfer",
          source: "manual",
          instalments: [
            { amount: 10000, dueAt: new Date(Date.now() - 1000) },
            { amount: 10000, dueAt: new Date(Date.now() + 30 * 86_400_000) },
          ],
          paidNow: { amount: 10000, reference: "UTR-TL-1" },
          verified: true,
        },
        admin,
      );
      await setManualStage(c.id, "lost", { lostReason: "price" }, admin);

      const { items, hasMore } = await getContactTimeline(c.id, { pageSize: 100 });
      expect(hasMore).toBe(false);
      const kinds = new Set(items.map((i) => i.kind));
      for (const k of ["enquiry", "interaction", "rating", "ownership", "purchase", "payment", "stage"])
        expect(kinds).toContain(k);
      const sorted = [...items].sort((x, y) => y.at.getTime() - x.at.getTime());
      expect(items.map((i) => i.id)).toEqual(sorted.map((i) => i.id));
      const enquiry = items.find((i) => i.kind === "enquiry");
      expect(enquiry).toMatchObject({ channel: "phone_call", campaign: "claude_mastery_meta", byName: "Umer" });
      const call = items.find((i) => i.kind === "interaction");
      expect(call).toMatchObject({ type: "call", outcome: "connected", summary: "Wants the workshop", byName: "Asha" });
      const own = items.find((i) => i.kind === "ownership");
      expect(own).toMatchObject({ toName: "Asha", reason: "Added by hand", byName: "Umer" });
      expect(items.some((i) => i.kind === "stage" && i.field === "stage" && i.to === "lost")).toBe(true);
      // the one-off cash purchase is a single touch; the paid instalment shows, the future one does not
      const pays = items.filter((i) => i.kind === "payment");
      expect(pays).toHaveLength(1);
      expect(pays[0]).toMatchObject({
        seq: 1,
        amount: 10000,
        status: "verified",
        hasInstalments: true,
        reference: "UTR-TL-1",
      });
      expect(items.filter((i) => i.kind === "purchase")).toHaveLength(2);

      const first = await getContactTimeline(c.id, { pageSize: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      const second = await getContactTimeline(c.id, { pageSize: 2, page: 2 });
      expect(second.items[0].id).not.toBe(first.items[0].id);
    });

    it("shows the header names, referrals with their LTV and the possible-duplicates count", async () => {
      const admin = await makeUser({ role: "admin" });
      const sales = await makeUser({ role: "sales", name: "Asha" });
      const org = await createOrganisation(
        { name: "Govt School Koduvally", kind: "school", city: "Kozhikode", country: "in" },
        admin,
      );
      const referrer = await newContact({ name: "Ravi", ownerId: sales.id, profile: { organisationId: org.id } });
      const friend = await newContact({ name: "Sana", referrer: { contactId: referrer.id } });
      await recordPurchase(
        {
          contactId: friend.id,
          productName: "AI Workshop",
          family: "workshop",
          amount: 999,
          currency: "INR",
          mode: "cash",
          source: "manual",
          verified: true,
        },
        admin,
      );

      const h = await getContactHeader(friend.id);
      expect(h?.referrer).toMatchObject({ id: referrer.id, name: "Ravi" });
      const rh = await getContactHeader(referrer.id);
      expect(rh).toMatchObject({
        ownerName: "Asha",
        firstOwnerName: "Asha",
        organisation: { id: org.id, name: "Govt School Koduvally" },
      });
      const refs = await getContactReferrals(referrer.id);
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ id: friend.id, ltvInr: 999 });
      expect(rh?.networkValueInr).toBe(999);

      const x = await newContact({ name: "Twin" });
      const y = await newContact({ name: "Twin" });
      const z = await newContact({ name: "Twin" });
      await flagPossibleDuplicates(x.id, [y.id, z.id], "Same name in the same city");
      expect(await countPossibleDuplicates()).toBe(2);
      // merging y away leaves its other review open in the table, but it no longer counts
      await mergeContacts(x.id, y.id, admin);
      expect(await countPossibleDuplicates()).toBe(1);
    });
  });

  describe("organisations", () => {
    it("creates, refuses the same name in the same city, edits and sums verified revenue of linked purchases", async () => {
      const admin = await makeUser({ role: "admin" });
      const sales = await makeUser({ role: "sales" });
      const other = await makeUser({ role: "sales" });
      const support = await makeUser({ role: "support" });
      const org = await createOrganisation(
        { name: "Koduvally MLA Office", kind: "constituency_office", city: "Koduvally", country: "IN" },
        sales,
      );
      await expect(
        createOrganisation({ name: "koduvally mla office", city: "koduvally" }, admin),
      ).rejects.toBeInstanceOf(ContactConflictError);
      await expect(createOrganisation({ name: "Other", kind: "embassy" }, admin)).rejects.toBeInstanceOf(
        ContactValidationError,
      );
      await expect(createOrganisation({ name: "By support" }, support)).rejects.toBeInstanceOf(ContactForbiddenError);
      // the same name in another city is a different account
      await createOrganisation({ name: "Koduvally MLA Office", city: "Kozhikode" }, admin);

      const signer = await newContact({ name: "Signer", ownerId: sales.id, profile: { organisationId: org.id } });
      await newContact({ name: "Colleague", ownerId: other.id, profile: { organisationId: org.id } });
      await recordPurchase(
        {
          contactId: signer.id,
          organisationId: org.id,
          productName: "Constituency AI literacy program",
          family: "constituency_program",
          amount: 200000,
          currency: "INR",
          mode: "bank_transfer",
          reference: "UTR-ORG-1",
          source: "manual",
          verified: true,
        },
        admin,
      );
      await recordPurchase(
        {
          contactId: signer.id,
          organisationId: org.id,
          productName: "Follow-on",
          family: "constituency_program",
          amount: 50000,
          currency: "INR",
          mode: "bank_transfer",
          reference: "UTR-ORG-2",
          source: "manual",
        },
        sales,
      );

      const detail = await getOrganisation(org.id);
      expect(detail).toMatchObject({ name: "Koduvally MLA Office", kind: "constituency_office", revenueInr: 200000 });
      const purchasesOfOrg = await getOrganisationPurchases(org.id);
      expect(purchasesOfOrg).toHaveLength(2);
      expect(purchasesOfOrg.find((p) => p.productName === "Follow-on")?.netInr).toBe(0);

      const forSales = await getOrganisationPeople(sales, org.id);
      expect(forSales.people.map((p) => p.name)).toEqual(["Signer"]);
      expect(forSales.hidden).toBe(1);
      expect((await getOrganisationPeople(admin, org.id)).people).toHaveLength(2);

      const listed = await listOrganisations({ q: "koduvally" });
      expect(listed.total).toBe(2);
      const row = listed.rows.find((r) => r.id === org.id);
      expect(row).toMatchObject({ people: 2, purchaseCount: 2, revenueInr: 200000 });

      const edited = await updateOrganisation(
        org.id,
        { name: "Koduvally Constituency Office", kind: "constituency_office", city: "Koduvally" },
        sales,
      );
      expect(edited.name).toBe("Koduvally Constituency Office");
      expect(edited.country).toBeNull();
    });
  });

  it("ranks Quick Add channels by how often the team enters them by hand", async () => {
    const sales = await makeUser({ role: "sales" });
    await newContact({ channel: "walk_in_event", createdById: sales.id });
    await newContact({ channel: "walk_in_event", createdById: sales.id });
    await newContact({ channel: "phone_call", createdById: sales.id });
    // automatic touches (no creator) do not count
    await newContact({ channel: "meta_lead_form" });
    await newContact({ channel: "meta_lead_form" });
    await newContact({ channel: "meta_lead_form" });
    expect(await channelUsage()).toEqual(["walk_in_event", "phone_call"]);
  });

  it("treats LIKE wildcards in a search as plain text and keeps the picker inside the viewer's scope", async () => {
    const asha = await makeUser({ role: "sales", name: "Asha" });
    const biju = await makeUser({ role: "sales", name: "Biju" });
    const plain = await newContact({ name: "Anil Kumar", ownerId: asha.id });
    const odd = await newContact({ name: "100% Kumar_x", ownerId: asha.id });
    await newContact({ name: "Kumar Colleague", ownerId: biju.id });

    // "%" and "_" must not act as wildcards (they would match every name)
    expect(ids((await list(asha, { q: "%" })).rows)).toEqual([odd.id]);
    expect(ids((await list(asha, { q: "r_x" })).rows)).toEqual([odd.id]);
    expect(ids((await list(asha, { q: "kumar" })).rows)).toEqual(ids([plain, odd]));

    // the merge/referrer picker never offers a colleague's contact to a salesperson
    const picks = await searchContactsForPicker(asha, "kumar", { excludeId: plain.id });
    expect(picks.map((p) => p.id)).toEqual([odd.id]);
  });
});

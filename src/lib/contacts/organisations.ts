import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { ORG_KINDS, organisations, type OrgKind, type Organisation } from "@/db/schema";
import { audit, auditDiff } from "@/lib/audit";
import { can } from "@/lib/auth/permissions";
import { normalizePhone } from "@/lib/phone";
import { ContactConflictError, ContactForbiddenError, ContactNotFoundError, ContactValidationError } from "./errors";
import { withTx, type Actor } from "./internal";
import { cleanText, countryCode, isUuid } from "./rules";

/**
 * B2B accounts (schools, constituency offices, companies, partners). Everyone can view them; sales, managers
 * and admins create and edit them. The same name in the same city is refused so an account is not entered twice.
 */

export type OrganisationInput = {
  name: string;
  kind?: string | null;
  city?: string | null;
  state?: string | null;
  /** ISO 3166-1 alpha-2 */
  country?: string | null;
  phone?: string | null;
  notes?: string | null;
};

type CleanOrg = {
  name: string;
  kind: OrgKind;
  city: string | null;
  state: string | null;
  country: string | null;
  phone: string | null;
  notes: string | null;
};

function assertCanManage(actor: Actor) {
  if (!can(actor, "contacts.edit"))
    throw new ContactForbiddenError("Only sales, managers and admins can edit organisations");
}

function clean(input: OrganisationInput): CleanOrg {
  const name = cleanText(input.name);
  if (!name) throw new ContactValidationError("Enter the organisation's name", "name");
  if (name.length > 200) throw new ContactValidationError("The name is too long", "name");
  const kind = (cleanText(input.kind) ?? "company") as OrgKind;
  if (!ORG_KINDS.includes(kind)) throw new ContactValidationError("Choose a kind from the list", "kind");
  const rawCountry = cleanText(input.country);
  const country = rawCountry ? countryCode(rawCountry) : null;
  if (rawCountry && !country)
    throw new ContactValidationError("Use a two-letter country code, e.g. IN or AE", "country");
  const rawPhone = cleanText(input.phone);
  let phone: string | null = null;
  if (rawPhone) {
    const np = normalizePhone(rawPhone, { defaultCountry: country ?? "IN" });
    if (!np) throw new ContactValidationError(`"${rawPhone}" is not a valid phone number`, "phone");
    phone = np.e164;
  }
  const notes = input.notes?.trim() || null;
  if (notes && notes.length > 5000) throw new ContactValidationError("Notes are too long", "notes");
  return { name, kind, city: cleanText(input.city), state: cleanText(input.state), country, phone, notes };
}

async function assertNameFree(o: CleanOrg, tx: Tx, excludeId?: string) {
  const rows = await tx
    .select({ id: organisations.id })
    .from(organisations)
    .where(
      and(
        sql`lower(${organisations.name}) = ${o.name.toLowerCase()}`,
        o.city
          ? sql`lower(coalesce(${organisations.city}, '')) = ${o.city.toLowerCase()}`
          : sql`${organisations.city} is null`,
        excludeId ? ne(organisations.id, excludeId) : undefined,
      ),
    )
    .limit(1);
  if (rows[0]) {
    throw new ContactConflictError(
      o.city ? `${o.name} in ${o.city} already exists` : `${o.name} already exists`,
      rows[0].id,
      "name",
    );
  }
}

/** Creates an organisation. Returns it. */
export async function createOrganisation(input: OrganisationInput, actor: Actor, tx: Tx = db): Promise<Organisation> {
  assertCanManage(actor);
  const o = clean(input);
  return withTx(tx, async (t) => {
    await assertNameFree(o, t);
    const [row] = await t.insert(organisations).values(o).returning();
    await audit({ table: "organisations", rowId: row.id, action: "insert", newValue: o, userId: actor.id }, t);
    return row;
  });
}

/** Edits an organisation (every field is replaced by the input). Returns it. */
export async function updateOrganisation(
  id: string,
  input: OrganisationInput,
  actor: Actor,
  tx: Tx = db,
): Promise<Organisation> {
  assertCanManage(actor);
  if (!isUuid(id)) throw new ContactNotFoundError("Organisation");
  const o = clean(input);
  return withTx(tx, async (t) => {
    const rows = await t.select().from(organisations).where(eq(organisations.id, id)).limit(1).for("update");
    const before = rows[0];
    if (!before) throw new ContactNotFoundError("Organisation");
    await assertNameFree(o, t, id);
    const [row] = await t
      .update(organisations)
      .set({ ...o, updatedAt: new Date() })
      .where(eq(organisations.id, id))
      .returning();
    await auditDiff("organisations", id, before as unknown as Record<string, unknown>, o, actor.id, t);
    return row;
  });
}

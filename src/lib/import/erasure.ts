import "server-only";
/**
 * The import rows of a person whose data is being erased (called by eraseContact in src/lib/contacts/privacy.ts,
 * inside its transaction). Every row of every imported file stays in import_rows (raw, mapped, cleaned, issues,
 * applied) and the admin's import review shows them all, so the person is taken out of:
 *
 * 1. Their own rows, wiped (raw {}, mapped and cleaned null, issues [], and the before/after values an import undo
 *    would put back on the contact; the ids an undo needs stay). A row is theirs when:
 *    - it went to them (contact_id);
 *    - it went to no contact yet (pending, failed) and matched them (match_contact_id) by number or email, or as a
 *      same-name conflict the admin chose to merge into them. A same-name conflict not decided that way is about
 *      someone else with their name (match_contact_id is only its first candidate): see part 2;
 *    - it is linked to nobody (both null) and its own number is one of theirs (main or alternate: phone is identity),
 *      or it carries the order id of one of their purchases or payments; or its alternate number, email or alternate
 *      email is theirs, when the import did not tie the row to someone else: its main number is no other contact's, its order is not recorded on another contact (a skipped row), and
 *      it is not "the same person as row N" of its file (a merge row with no contact). Emails are not unique, so a
 *      shared email alone never makes another person's row theirs. These are rows skipped because the order was
 *      already recorded on them, invalid rows, new rows that failed, and rows of an import still in review.
 * 2. Other contacts' rows that quote them, kept so that contact's import undo still works (and a file still in review
 *    can be decided and committed); only the quote goes:
 *    - issues with their number or naming them ("<number> belongs to <name>, so it was not added", "... already
 *      recorded on <name>"), and the same text in applied.purchaseSkipped;
 *    - their entry in a conflict's candidates (cleaned.match.candidates: id, name, phone and city of up to three
 *      same-name contacts, of which the first is match_contact_id), and cleaned.match.contactName when it is their
 *      name (they were the first candidate, or the row's matched contact). match_contact_id stays: an id, shown as
 *      the erased contact's placeholder name;
 *    - the referrer columns of a row that named them as its referrer (applied.referrerId): cleaned.referrer, the
 *      mapped referrer fields and the raw columns mapped to them.
 *    A namesake's line with the same wording goes too, which only shortens that row's list of issues.
 *
 * One pass over import_rows finds every such row. No index covers these predicates (contact_id, match_contact_id and
 * the jsonb values are not indexed), so it is a sequential scan of import_rows, once per erasure; the check that a
 * number is another contact's runs only for the few unlinked rows carrying their email or alternate number, through
 * the contacts phone indexes. The writes then go by primary key.
 */
import { sql } from "drizzle-orm";
import { queryRows, type Tx } from "@/db";
import { textArray, uuidArray } from "./internal";
import type { MatchInfo } from "./types";

/** Everything that identifies the person being erased, read before their contact rows are cleared. */
export type ErasedPerson = {
  /** the contact and every row merged into it */
  ids: string[];
  /** every name they went by (now, and before each rename) */
  names: string[];
  /** E.164: main and alternate numbers */
  phones: string[];
  /** lower case: main and alternate emails */
  emails: string[];
  /** references of their purchases and payments (TagMango order ids, UTRs) */
  references: string[];
};

type Candidate = NonNullable<MatchInfo["candidates"]>[number];

/** The parts of an import row this module rewrites. */
export type ImportRowParts = {
  raw: Record<string, unknown>;
  mapped: Record<string, unknown> | null;
  cleaned: Record<string, unknown> | null;
  issues: string[];
  applied: Record<string, unknown> | null;
};

/** Target fields of the referrer columns (src/lib/import/types.ts TARGET_FIELDS). */
const REFERRER_FIELDS = ["referrer_phone", "referrer_name"] as const;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

function usable(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

/**
 * How import messages quote another contact: their number anywhere (not as the start of a longer number), and their
 * name after "belongs to" (src/lib/import/commit.ts) or "recorded on" (src/lib/import/match.ts, and the duplicate
 * reference error of src/lib/money/errors.ts), ending the phrase.
 */
export function personQuotes(p: Pick<ErasedPerson, "names" | "phones">): RegExp[] {
  return [
    ...usable(p.phones).map((phone) => new RegExp(`${escapeRe(phone)}(?!\\d)`)),
    ...usable(p.names).map((name) => new RegExp(`(?:belongs to|recorded on) ${escapeRe(name)}(?:[.,:]|$)`)),
  ];
}

export function quotesPerson(text: string, quotes: RegExp[]): boolean {
  return quotes.some((q) => q.test(text));
}

/** LIKE patterns that find, in SQL, every text personQuotes matches (and a few more, which the regexes then drop). */
function quoteLikePatterns(p: Pick<ErasedPerson, "names" | "phones">): string[] {
  return [
    ...usable(p.phones).map((phone) => `%${escapeLike(phone)}%`),
    ...usable(p.names).flatMap((name) => [`%belongs to ${escapeLike(name)},%`, `%recorded on ${escapeLike(name)}%`]),
  ];
}

function omit<T extends Record<string, unknown>>(o: T, keys: readonly string[]): T {
  const out = { ...o };
  for (const k of keys) delete out[k];
  return out;
}

/**
 * Another contact's row without what it quotes of the person (see the file comment, part 2), or null when it quotes
 * nothing. `matchContactId`: the row's matched contact. `referrerHeaders`: the file's columns mapped to the referrer
 * fields. Pure.
 */
export function withoutPersonQuotes(
  row: ImportRowParts & { matchContactId?: string | null },
  ctx: { ids: ReadonlySet<string>; quotes: RegExp[]; referrerHeaders: readonly string[] },
): ImportRowParts | null {
  let changed = false;
  const issues = (Array.isArray(row.issues) ? row.issues : []).filter((i) => typeof i !== "string" || !quotesPerson(i, ctx.quotes));
  if (issues.length !== (row.issues ?? []).length) changed = true;

  let cleaned = row.cleaned;
  const match = cleaned?.match as MatchInfo | undefined;
  if (cleaned && match && typeof match === "object") {
    const candidates = Array.isArray(match.candidates) ? match.candidates : null;
    const theirs = (id: unknown) => typeof id === "string" && ctx.ids.has(id);
    const dropCandidates = !!candidates?.some((c: Candidate) => theirs(c?.id));
    // the name of the row's matched contact: a conflict's first candidate, or the contact a merge row matched
    const dropName = match.contactName != null && (theirs(row.matchContactId) || theirs(candidates?.[0]?.id));
    if (dropCandidates || dropName) {
      const next: MatchInfo = { ...match };
      if (dropCandidates) next.candidates = candidates!.filter((c: Candidate) => !theirs(c?.id));
      if (dropName) delete next.contactName;
      cleaned = { ...cleaned, match: next };
      changed = true;
    }
  }

  let applied = row.applied;
  if (applied && typeof applied.purchaseSkipped === "string" && quotesPerson(applied.purchaseSkipped, ctx.quotes)) {
    applied = omit(applied, ["purchaseSkipped"]);
    changed = true;
  }

  let raw = row.raw;
  let mapped = row.mapped;
  if (typeof row.applied?.referrerId === "string" && ctx.ids.has(row.applied.referrerId)) {
    if (cleaned && cleaned.referrer != null) {
      cleaned = { ...cleaned, referrer: null };
      changed = true;
    }
    if (mapped && REFERRER_FIELDS.some((f) => f in mapped!)) {
      mapped = omit(mapped, REFERRER_FIELDS);
      changed = true;
    }
    const columns = ctx.referrerHeaders.filter((h) => h in raw);
    if (columns.length) {
      raw = omit(raw, columns);
      changed = true;
    }
  }
  return changed ? { raw, mapped, cleaned, issues, applied } : null;
}

/** Wipes the person's own import rows and takes their quotes off other contacts' rows (see the file comment). */
export async function scrubErasedPersonFromImports(p: ErasedPerson, tx: Tx): Promise<{ wiped: number; edited: number }> {
  if (!p.ids.length) return { wiped: 0, edited: 0 };
  const phones = usable(p.phones);
  const emails = usable(p.emails.map((e) => e.toLowerCase()));
  const references = usable(p.references);
  const patterns = quoteLikePatterns(p);
  const ids = uuidArray(p.ids);

  const phoneList = textArray(phones);
  const emailList = textArray(emails);
  // the one sequential scan (see the file comment, part 1 for "own")
  const own = sql`(
    r.contact_id = any(${ids})
    or (r.contact_id is null and r.match_contact_id = any(${ids})
      and (r.match_result is distinct from 'conflict' or r.resolution = 'merge'))
    or (r.contact_id is null and r.match_contact_id is null and (
      r.cleaned->>'phone' = any(${phoneList})
      or r.cleaned->'purchase'->>'orderId' = any(${textArray(references)})
      or (
        (
          jsonb_exists_any(coalesce(r.cleaned->'altPhones', '[]'::jsonb), ${phoneList})
          or lower(r.cleaned->>'email') = any(${emailList})
          or jsonb_exists_any(coalesce(r.cleaned->'altEmails', '[]'::jsonb), ${emailList})
        )
        and r.match_result is distinct from 'skip'
        and r.match_result is distinct from 'merge'
        and not exists (
          select 1 from contacts o
          where (o.phone_e164 = r.cleaned->>'phone' or o.alt_phones @> array[r.cleaned->>'phone'])
            and o.id <> all(${ids})
        )
      )
    ))
  )`;
  const found = await queryRows<{ id: string; own: boolean }>(sql`
    select r.id, ${own} as own
    from import_rows r
    where ${own}
      or r.match_contact_id = any(${ids})
      or exists (
        select 1 from jsonb_array_elements_text(case when jsonb_typeof(r.issues) = 'array' then r.issues else '[]'::jsonb end) i
        where i like any(${textArray(patterns)})
      )
      or exists (
        select 1 from jsonb_array_elements(
          case when jsonb_typeof(r.cleaned->'match'->'candidates') = 'array' then r.cleaned->'match'->'candidates' else '[]'::jsonb end
        ) c
        where c->>'id' = any(${textArray(p.ids)})
      )
      or r.applied->>'purchaseSkipped' like any(${textArray(patterns)})
      or r.applied->>'referrerId' = any(${textArray(p.ids)})
  `, tx);

  const ownIds = found.filter((r) => r.own).map((r) => r.id);
  for (let i = 0; i < ownIds.length; i += 1000) {
    await tx.execute(sql`
      update import_rows set
        raw = '{}'::jsonb, mapped = null, cleaned = null, issues = '[]'::jsonb,
        -- what an import undo would put back on the contact (its old and new values); the row ids it needs stay
        applied = case when jsonb_typeof(applied) = 'object' then applied - 'before' - 'after' else applied end
      where id = any(${uuidArray(ownIds.slice(i, i + 1000))})
    `);
  }

  const quoting = found.filter((r) => !r.own).map((r) => r.id);
  if (!quoting.length) return { wiped: ownIds.length, edited: 0 };
  const rows = await queryRows<ImportRowParts & { id: string; matchContactId: string | null; mapping: Record<string, string> | null }>(sql`
    select r.id, r.raw, r.mapped, r.cleaned, r.issues, r.applied, r.match_contact_id as "matchContactId", b.mapping
    from import_rows r join import_batches b on b.id = r.batch_id
    where r.id = any(${uuidArray(quoting)})
    for update of r
  `, tx);
  const ctx = { ids: new Set(p.ids), quotes: personQuotes(p) };
  const patches: (ImportRowParts & { id: string })[] = [];
  for (const r of rows) {
    const referrerHeaders = Object.entries(r.mapping ?? {})
      .filter(([, field]) => (REFERRER_FIELDS as readonly string[]).includes(field))
      .map(([header]) => header);
    const next = withoutPersonQuotes(r, { ...ctx, referrerHeaders });
    if (next) patches.push({ id: r.id, ...next });
  }
  for (let i = 0; i < patches.length; i += 500) {
    await tx.execute(sql`
      update import_rows as r set raw = v.raw, mapped = v.mapped, cleaned = v.cleaned, issues = v.issues, applied = v.applied
      from jsonb_to_recordset(${JSON.stringify(patches.slice(i, i + 500))}::jsonb)
        as v(id uuid, raw jsonb, mapped jsonb, cleaned jsonb, issues jsonb, applied jsonb)
      where r.id = v.id
    `);
  }
  return { wiped: ownIds.length, edited: patches.length };
}

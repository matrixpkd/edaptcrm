/**
 * WhatsApp message templates (beyond the spec; Settings -> Message templates). PURE: safe in client components,
 * unit tested in tests/unit/templates.test.ts. The CRM never sends messages (spec "Later"): a template only fills the
 * text of a wa.me link the salesperson opens and sends from their own WhatsApp.
 */
import type { MessageTemplate } from "@/lib/settings/defaults";

export const TEMPLATE_PLACEHOLDERS = ["name", "first_name", "offer", "owner"] as const;
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

export const TEMPLATE_NAME_MAX = 60;
export const TEMPLATE_BODY_MAX = 1000;
export const TEMPLATES_MAX = 30;

export type TemplateVars = { name: string; offer?: string | null; owner?: string | null };

/** The first word of a name ("Priya" from "Priya Nair"); the whole name when it has one word. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/**
 * Fills {name}, {first_name}, {offer} and {owner}. A missing offer reads "our next programme" and a missing owner
 * "the Edapt team", so a message never goes out with an empty gap; unknown {words} stay as typed.
 */
export function fillTemplate(body: string, vars: TemplateVars): string {
  const values: Record<TemplatePlaceholder, string> = {
    name: vars.name.trim(),
    first_name: firstName(vars.name),
    offer: vars.offer?.trim() || "our next programme",
    owner: vars.owner?.trim() || "the Edapt team",
  };
  return body.replace(/\{\s*([a-z_]+)\s*\}/gi, (whole, key: string) => {
    const k = key.toLowerCase() as TemplatePlaceholder;
    return (TEMPLATE_PLACEHOLDERS as readonly string[]).includes(k) ? values[k] : whole;
  });
}

/** Placeholders a body uses that are not supported (shown as a warning in Settings). */
export function unknownPlaceholders(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\{\s*([a-z_]+)\s*\}/gi)) {
    const k = m[1].toLowerCase();
    if (!(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(k)) out.add(m[1]);
  }
  return [...out];
}

export type TemplateIssue = { index: number; field: "name" | "body"; message: string };

/**
 * Cleans the templates an admin saves: trimmed, a name and a body each, unique names, stable ids (a new template
 * gets an id from its name). Returns the clean list or the first problems.
 */
export function validateTemplates(input: unknown): { ok: true; value: MessageTemplate[] } | { ok: false; issues: TemplateIssue[] } {
  if (!Array.isArray(input)) return { ok: false, issues: [{ index: -1, field: "name", message: "Nothing to save" }] };
  if (input.length > TEMPLATES_MAX) {
    return { ok: false, issues: [{ index: -1, field: "name", message: `Keep it to ${TEMPLATES_MAX} templates` }] };
  }
  const issues: TemplateIssue[] = [];
  const seenNames = new Set<string>();
  const seenIds = new Set<string>();
  const value: MessageTemplate[] = [];
  input.forEach((raw, index) => {
    const r = (raw ?? {}) as Partial<MessageTemplate>;
    const name = String(r.name ?? "").replace(/\s+/g, " ").trim();
    const body = String(r.body ?? "").trim();
    if (!name) issues.push({ index, field: "name", message: "Give the template a name" });
    else if (name.length > TEMPLATE_NAME_MAX) issues.push({ index, field: "name", message: `Keep the name under ${TEMPLATE_NAME_MAX} characters` });
    else if (seenNames.has(name.toLowerCase())) issues.push({ index, field: "name", message: "Two templates have this name" });
    if (!body) issues.push({ index, field: "body", message: "Write the message" });
    else if (body.length > TEMPLATE_BODY_MAX) issues.push({ index, field: "body", message: `Keep the message under ${TEMPLATE_BODY_MAX} characters` });
    seenNames.add(name.toLowerCase());
    let id = typeof r.id === "string" && /^[a-z0-9_-]{1,40}$/.test(r.id) ? r.id : slug(name) || `template_${index + 1}`;
    while (seenIds.has(id)) id = `${id}_${index + 1}`;
    seenIds.add(id);
    value.push({ id, name, body, ...(r.active === false ? { active: false } : {}) });
  });
  return issues.length ? { ok: false, issues } : { ok: true, value };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/** The active templates filled for one contact, ready for the WhatsApp menu. */
export function templatesFor(list: MessageTemplate[], vars: TemplateVars): { id: string; name: string; text: string }[] {
  return list.filter((t) => t.active !== false).map((t) => ({ id: t.id, name: t.name, text: fillTemplate(t.body, vars) }));
}

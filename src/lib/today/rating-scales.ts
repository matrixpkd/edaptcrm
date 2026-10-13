/**
 * The four anchored rating scales, word for word from the spec ("Rating scales"), so two people rating the
 * same customer land on the same number. Pure: used by the Rate customer screen and its tests.
 */
import { normalizeCountry } from "@/lib/metrics/scoring";

export type ScaleAnchor = { value: number; label: string; text: string };

/** AI knowledge, 0 to 5: "What you hear on the call". */
export const AI_KNOWLEDGE_SCALE: ScaleAnchor[] = [
  { value: 0, label: "0", text: "Has never used an AI tool" },
  { value: 1, label: "1", text: "Tried ChatGPT or similar a few times" },
  { value: 2, label: "2", text: "Uses AI now and then for simple tasks" },
  { value: 3, label: "3", text: "Uses AI every week in work or business" },
  { value: 4, label: "4", text: "Power user: several tools, builds own workflows" },
  { value: 5, label: "5", text: "Builds with AI (automations, agents, apps) or works in tech" },
];

/** Umer familiarity, 0 to 5: "What you hear on the call". */
export const UMER_FAMILIARITY_SCALE: ScaleAnchor[] = [
  { value: 0, label: "0", text: "Does not know Umer" },
  { value: 1, label: "1", text: "Knows the name or saw an ad" },
  { value: 2, label: "2", text: "Has watched a few of his videos" },
  { value: 3, label: "3", text: "Watches regularly and can recall his ideas" },
  { value: 4, label: "4", text: "Follows closely: read his book, or attended his session or keynote" },
  { value: 5, label: "5", text: "Personal connection: has met him or is in his network" },
];

export type SpendingBand = { value: number; name: string; india: string; gcc: string };

/** Spending power, 1 to 5, with India yearly income and GCC monthly income bands. */
export const SPENDING_POWER_SCALE: SpendingBand[] = [
  { value: 1, name: "Low", india: "Under ₹3 lakh", gcc: "Under AED 5,000" },
  { value: 2, name: "Lower-middle", india: "₹3 to 8 lakh", gcc: "AED 5,000 to 10,000" },
  { value: 3, name: "Middle", india: "₹8 to 20 lakh", gcc: "AED 10,000 to 20,000" },
  { value: 4, name: "Upper-middle", india: "₹20 to 50 lakh", gcc: "AED 20,000 to 40,000" },
  { value: 5, name: "High", india: "Over ₹50 lakh", gcc: "Over AED 40,000" },
];

export const SPENDING_POWER_HINT =
  "Pick by stated income, or judge from role, company, location and past purchases";

/** True when the contact lives (or, with no country, has a phone) in a GCC country from settings. */
export function isGccContact(
  contact: { country: string | null; phoneCountry: string | null },
  gccCountries: string[],
): boolean {
  const cc = normalizeCountry(contact.country) ?? normalizeCountry(contact.phoneCountry);
  return !!cc && gccCountries.some((c) => normalizeCountry(c) === cc);
}

/**
 * The four worked examples from the spec ("Scoring formulas"), for the live preview on Settings > Scoring.
 * PURE: the editor rescores them in the browser with the weights being edited.
 */
import { scoreContact, type ContactScore, type ScoreContactInput } from "@/lib/metrics/scoring";
import type { LocationConfig, ScoringConfig } from "@/lib/settings/defaults";

const DAY_MS = 24 * 3600 * 1000;

export type ScoringExample = {
  id: string;
  title: string;
  summary: string;
  /** the spec's numbers with the default weights */
  spec: { fit: number; readiness: number; value: number | null; edapt: number; grade: string };
  input: (now: Date) => ScoreContactInput;
};

const ago = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

export const SCORING_EXAMPLES: ScoringExample[] = [
  {
    id: "gcc-owner",
    title: "GCC business owner",
    summary: "35 to 44, band 5, Umer 4, AI 3, chatted this week; ₹1.2 lakh over 4 purchases in 3 lines, last one 2 months ago, 2 referrals",
    spec: { fit: 100, readiness: 92, value: 92, edapt: 94, grade: "A" },
    input: (now) => ({
      country: "AE",
      industry: "business_owner",
      ageBand: "35-44",
      spendingBand: 5,
      umerLevel: 4,
      aiLevel: 3,
      lastInterestAt: ago(now, 2),
      ltvInr: 120000,
      purchaseCount: 4,
      familyCount: 3,
      referralCount: 2,
      lastPurchaseAt: ago(now, 61),
    }),
  },
  {
    id: "kerala-lead",
    title: "New lead: Kerala-city business owner",
    summary: "35 to 44, band 4, Umer 3, AI 2, enquired today",
    spec: { fit: 88, readiness: 84, value: null, edapt: 86, grade: "A" },
    input: (now) => ({
      country: "IN",
      city: "Kochi",
      state: "Kerala",
      industry: "business_owner",
      ageBand: "35-44",
      spendingBand: 4,
      umerLevel: 3,
      aiLevel: 2,
      lastInterestAt: now,
    }),
  },
  {
    id: "workshop-buyer",
    title: "Workshop buyer",
    summary: "Nothing rated yet, rest of Kerala, one ₹699 purchase 5 days ago",
    spec: { fit: 47, readiness: 53, value: 30, edapt: 40, grade: "C" },
    input: (now) => ({
      country: "IN",
      state: "Kerala",
      city: "Malappuram",
      lastInterestAt: ago(now, 5),
      ltvInr: 699,
      purchaseCount: 1,
      familyCount: 1,
      referralCount: 0,
      lastPurchaseAt: ago(now, 5),
    }),
  },
  {
    id: "student-lead",
    title: "New lead: student",
    summary: "18 to 24, band 1, rest of India, Umer 0, AI 1, enquired 2 months ago",
    spec: { fit: 30, readiness: 30, value: null, edapt: 30, grade: "D" },
    input: (now) => ({
      country: "IN",
      state: "Maharashtra",
      city: "Nagpur",
      industry: "student",
      ageBand: "18-24",
      spendingBand: 1,
      umerLevel: 0,
      aiLevel: 1,
      lastInterestAt: ago(now, 61),
    }),
  },
];

/** Every example scored with `cfg`. */
export function scoreExamples(
  cfg: ScoringConfig,
  ctx: { locations: LocationConfig; gccCountries: string[] },
  now: Date,
): { example: ScoringExample; score: ContactScore }[] {
  return SCORING_EXAMPLES.map((example) => ({ example, score: scoreContact(example.input(now), cfg, ctx, now) }));
}
